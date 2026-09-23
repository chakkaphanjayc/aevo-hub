-- TraceDee Phase 3: eligible contributions and moderation-safe community input.
-- Posts require a completed journey and exactly one primary Trace/Place target.
-- Comments and reports use the same server-owned idempotency and event rules.

create index if not exists tracedee_posts_author_created_idx
  on public.tracedee_posts (author_id, created_at desc);
create index if not exists tracedee_comments_author_created_idx
  on public.tracedee_comments (author_id, created_at desc);
create index if not exists tracedee_reports_status_created_idx
  on public.tracedee_content_reports (status, created_at desc);

create or replace function public.tracedee_create_post(
  p_actor_id uuid,
  p_journey_id uuid,
  p_body text,
  p_idempotency_key text,
  p_request_hash text,
  p_trace_id uuid default null,
  p_place_id uuid default null,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_journey record;
  v_existing record;
  v_post record;
  v_idempotency_id uuid;
  v_thread_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_body text := regexp_replace(trim(coalesce(p_body, '')), '\s+', ' ', 'g');
  v_status text;
  v_response jsonb;
  v_scope text := 'tracedee:journey:post:' || p_journey_id::text;
  v_recent_count integer := 0;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if length(v_body) < 1 or length(v_body) > 8000 then
    raise exception using errcode = 'P0001', message = 'POST_INPUT_INVALID';
  end if;
  if (p_trace_id is null) = (p_place_id is null) then
    raise exception using errcode = 'P0001', message = 'POST_TARGET_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  select
    j.id,
    j.user_id,
    j.trace_id,
    j.status,
    c.id as completion_id,
    c.verification_status
  into v_journey
  from public.tracedee_journeys j
  left join public.tracedee_completions c on c.journey_id = j.id
  where j.id = p_journey_id
    and j.user_id = p_actor_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'JOURNEY_NOT_FOUND';
  end if;
  if v_journey.status <> 'COMPLETED'
     or v_journey.completion_id is null
     or v_journey.verification_status = 'REJECTED' then
    raise exception using errcode = 'P0001', message = 'CONTRIBUTION_NOT_ELIGIBLE';
  end if;

  if p_trace_id is not null and p_trace_id <> v_journey.trace_id then
    raise exception using errcode = 'P0001', message = 'POST_TARGET_INVALID';
  end if;
  if p_place_id is not null and not exists (
    select 1
    from public.tracedee_trace_stops s
    where s.trace_id = v_journey.trace_id
      and s.place_id = p_place_id
  ) then
    raise exception using errcode = 'P0001', message = 'POST_TARGET_INVALID';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (
    p_actor_id,
    v_scope,
    trim(p_idempotency_key),
    trim(p_request_hash),
    timezone('utc', now()) + interval '24 hours'
  )
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id
      and scope = v_scope
      and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  select count(*)
  into v_recent_count
  from public.tracedee_posts
  where author_id = p_actor_id
    and created_at >= timezone('utc', now()) - interval '1 hour';
  if v_recent_count >= 10 then
    raise exception using errcode = 'P0001', message = 'CONTENT_RATE_LIMITED';
  end if;
  if exists (
    select 1
    from public.tracedee_posts
    where author_id = p_actor_id
      and body = v_body
      and created_at >= timezone('utc', now()) - interval '24 hours'
  ) then
    raise exception using errcode = 'P0001', message = 'CONTENT_DUPLICATE';
  end if;

  v_status := case when v_body ~* '(https?://|www\.)' then 'UNDER_REVIEW' else 'VISIBLE' end;
  insert into public.tracedee_posts (author_id, trace_id, place_id, body, status)
  values (p_actor_id, p_trace_id, p_place_id, v_body, v_status)
  returning * into v_post;

  insert into public.tracedee_comment_threads (post_id)
  values (v_post.id)
  returning id into v_thread_id;

  if v_status = 'VISIBLE' then
    insert into public.tracedee_notifications (recipient_id, actor_id, event_type, entity_type, entity_id, payload)
    select t.creator_id, p_actor_id, 'trace_post_created', 'POST', v_post.id,
      jsonb_build_object('traceId', v_journey.trace_id, 'journeyId', p_journey_id)
    from public.tracedee_traces t
    where t.id = v_journey.trace_id
      and t.creator_id <> p_actor_id;
  end if;

  insert into public.tracedee_activity_events (
    event_type,
    actor_id,
    source,
    session_id,
    entity_type,
    entity_id,
    metadata,
    tracking_token,
    correlation_id,
    dedupe_key
  )
  values (
    'post_created',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-go'),
    p_session_id,
    'POST',
    v_post.id,
    jsonb_build_object(
      'journeyId', p_journey_id,
      'traceId', v_journey.trace_id,
      'placeId', p_place_id,
      'status', v_status,
      'bodyLength', length(v_body)
    ),
    v_tracking_token,
    v_correlation_id,
    'post-create:' || p_actor_id::text || ':' || p_journey_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true,
    'postId', v_post.id,
    'threadId', v_thread_id,
    'journeyId', p_journey_id,
    'traceId', v_journey.trace_id,
    'placeId', p_place_id,
    'status', v_status,
    'body', v_post.body,
    'changed', true,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys
  set response_status = 200, response_body = v_response
  where id = v_idempotency_id;
  return v_response;
end;
$$;

create or replace function public.tracedee_create_comment(
  p_actor_id uuid,
  p_thread_id uuid,
  p_body text,
  p_idempotency_key text,
  p_request_hash text,
  p_parent_id uuid default null,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_thread record;
  v_parent record;
  v_parent_author_id uuid;
  v_existing record;
  v_comment record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_body text := regexp_replace(trim(coalesce(p_body, '')), '\s+', ' ', 'g');
  v_status text;
  v_depth smallint := 0;
  v_recent_count integer := 0;
  v_scope text := 'tracedee:thread:comment:' || p_thread_id::text;
  v_response jsonb;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if length(v_body) < 1 or length(v_body) > 3000 then
    raise exception using errcode = 'P0001', message = 'COMMENT_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  select ct.id, ct.post_id, p.author_id, p.status, p.trace_id, p.place_id
  into v_thread
  from public.tracedee_comment_threads ct
  join public.tracedee_posts p on p.id = ct.post_id
  where ct.id = p_thread_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'COMMENT_THREAD_NOT_FOUND';
  end if;
  if v_thread.status in ('REMOVED', 'UNDER_REVIEW') then
    raise exception using errcode = 'P0001', message = 'COMMENT_NOT_ALLOWED';
  end if;

  if p_parent_id is not null then
    select id, thread_id, depth, status, author_id
    into v_parent
    from public.tracedee_comments
    where id = p_parent_id;
    if not found or v_parent.thread_id <> p_thread_id or v_parent.depth <> 0 or v_parent.status = 'REMOVED' then
      raise exception using errcode = 'P0001', message = 'COMMENT_PARENT_INVALID';
    end if;
    v_depth := 1;
    v_parent_author_id := v_parent.author_id;
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (
    p_actor_id,
    v_scope,
    trim(p_idempotency_key),
    trim(p_request_hash),
    timezone('utc', now()) + interval '24 hours'
  )
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id
      and scope = v_scope
      and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  select count(*)
  into v_recent_count
  from public.tracedee_comments
  where author_id = p_actor_id
    and created_at >= timezone('utc', now()) - interval '1 hour';
  if v_recent_count >= 20 then
    raise exception using errcode = 'P0001', message = 'CONTENT_RATE_LIMITED';
  end if;
  if exists (
    select 1
    from public.tracedee_comments
    where author_id = p_actor_id
      and thread_id = p_thread_id
      and body = v_body
      and created_at >= timezone('utc', now()) - interval '24 hours'
  ) then
    raise exception using errcode = 'P0001', message = 'CONTENT_DUPLICATE';
  end if;

  v_status := case when v_body ~* '(https?://|www\.)' then 'UNDER_REVIEW' else 'VISIBLE' end;
  insert into public.tracedee_comments (thread_id, author_id, parent_id, body, depth, status)
  values (p_thread_id, p_actor_id, p_parent_id, v_body, v_depth, v_status)
  returning * into v_comment;

  if v_status = 'VISIBLE' then
    insert into public.tracedee_notifications (recipient_id, actor_id, event_type, entity_type, entity_id, payload)
    select distinct recipient_id, p_actor_id, 'post_comment_created', 'COMMENT', v_comment.id,
      jsonb_build_object('postId', v_thread.post_id, 'threadId', p_thread_id)
    from (
      values (v_thread.author_id), (v_parent_author_id)
    ) recipients(recipient_id)
    where recipient_id is not null
      and recipient_id <> p_actor_id;
  end if;

  insert into public.tracedee_activity_events (
    event_type,
    actor_id,
    source,
    session_id,
    entity_type,
    entity_id,
    metadata,
    tracking_token,
    correlation_id,
    dedupe_key
  )
  values (
    'comment_created',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-go'),
    p_session_id,
    'COMMENT',
    v_comment.id,
    jsonb_build_object(
      'postId', v_thread.post_id,
      'threadId', p_thread_id,
      'parentId', p_parent_id,
      'status', v_status,
      'bodyLength', length(v_body)
    ),
    v_tracking_token,
    v_correlation_id,
    'comment-create:' || p_actor_id::text || ':' || p_thread_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true,
    'commentId', v_comment.id,
    'threadId', p_thread_id,
    'postId', v_thread.post_id,
    'parentId', p_parent_id,
    'depth', v_depth,
    'status', v_status,
    'body', v_comment.body,
    'changed', true,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys
  set response_status = 200, response_body = v_response
  where id = v_idempotency_id;
  return v_response;
end;
$$;

create or replace function public.tracedee_report_content(
  p_actor_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_reason text,
  p_details text,
  p_idempotency_key text,
  p_request_hash text,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_existing record;
  v_report record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_changed boolean := false;
  v_entity_type text := upper(trim(coalesce(p_entity_type, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_details text := trim(coalesce(p_details, ''));
  v_scope text := 'tracedee:report:' || v_entity_type || ':' || p_entity_id::text;
  v_response jsonb;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if v_entity_type not in ('TRACE', 'PLACE', 'POST', 'COMMENT', 'PROFILE')
     or p_entity_id is null
     or length(v_reason) < 1
     or length(v_reason) > 120
     or length(v_details) > 2000 then
    raise exception using errcode = 'P0001', message = 'REPORT_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  if not (
    (v_entity_type = 'TRACE' and exists (select 1 from public.tracedee_traces where id = p_entity_id))
    or (v_entity_type = 'PLACE' and exists (select 1 from public.tracedee_places where id = p_entity_id))
    or (v_entity_type = 'POST' and exists (select 1 from public.tracedee_posts where id = p_entity_id))
    or (v_entity_type = 'COMMENT' and exists (select 1 from public.tracedee_comments where id = p_entity_id))
    or (v_entity_type = 'PROFILE' and exists (select 1 from auth.users where id = p_entity_id))
  ) then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_FOUND';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (
    p_actor_id,
    v_scope,
    trim(p_idempotency_key),
    trim(p_request_hash),
    timezone('utc', now()) + interval '24 hours'
  )
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id
      and scope = v_scope
      and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  insert into public.tracedee_content_reports (reporter_id, entity_type, entity_id, reason, details)
  values (p_actor_id, v_entity_type, p_entity_id, v_reason, v_details)
  on conflict (reporter_id, entity_type, entity_id) do nothing
  returning * into v_report;

  v_changed := v_report.id is not null;

  if v_report.id is null then
    select * into v_report
    from public.tracedee_content_reports
    where reporter_id = p_actor_id
      and entity_type = v_entity_type
      and entity_id = p_entity_id;
  end if;

  if v_report.id is null then
    raise exception using errcode = 'P0001', message = 'REPORT_NOT_FOUND';
  end if;

  if v_changed then
    insert into public.tracedee_activity_events (
      event_type,
      actor_id,
      source,
      session_id,
      entity_type,
      entity_id,
      metadata,
      tracking_token,
      correlation_id,
      dedupe_key
    )
    values (
      'content_reported',
      p_actor_id,
      coalesce(nullif(trim(p_source), ''), 'aevo-go'),
      p_session_id,
      v_entity_type,
      p_entity_id,
      jsonb_build_object('reportId', v_report.id, 'reason', v_reason),
      v_tracking_token,
      v_correlation_id,
      'content-report:' || p_actor_id::text || ':' || v_entity_type || ':' || p_entity_id::text || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'reportId', v_report.id,
    'entityType', v_report.entity_type,
    'entityId', v_report.entity_id,
    'status', v_report.status,
    'changed', v_changed,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys
  set response_status = 200, response_body = v_response
  where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_create_post(uuid, uuid, text, text, text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_create_post(uuid, uuid, text, text, text, uuid, uuid, text, text) to service_role;
revoke all on function public.tracedee_create_comment(uuid, uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_create_comment(uuid, uuid, text, text, text, uuid, text, text) to service_role;
revoke all on function public.tracedee_report_content(uuid, text, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_report_content(uuid, text, uuid, text, text, text, text, text, text) to service_role;
