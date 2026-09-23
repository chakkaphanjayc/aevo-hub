-- TraceDee Phase 3/4 community and moderation slice.
--
-- The Gateway remains the only supported access path. Moderation actions are
-- platform-admin operations, but the domain mutation is still performed by a
-- service-role-only RPC so content state, audit, activity, outbox, and
-- idempotency are committed atomically.

alter table public.tracedee_traces
  add column if not exists moderation_status text not null default 'VISIBLE';

alter table public.tracedee_traces
  drop constraint if exists tracedee_traces_moderation_status_check;

alter table public.tracedee_traces
  add constraint tracedee_traces_moderation_status_check
  check (moderation_status in ('VISIBLE', 'LIMITED', 'UNDER_REVIEW', 'REMOVED'));

alter table public.tracedee_content_reports
  add column if not exists evidence_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists resolution_code text,
  add column if not exists resolution_note text not null default '';

alter table public.tracedee_activity_events
  drop constraint if exists tracedee_activity_events_event_type_check;

alter table public.tracedee_activity_events
  add constraint tracedee_activity_events_event_type_check check (event_type in (
    'feed_item_impressed', 'feed_item_opened', 'feed_item_dismissed', 'feed_item_quick_back',
    'place_saved', 'trace_saved', 'trace_unsaved', 'tracer_followed', 'tracer_unfollowed',
    'trace_followed', 'trace_unfollowed', 'trace_started', 'trace_stop_completed',
    'trace_stop_skipped', 'trace_completed', 'trace_completion_verified', 'trace_remixed',
    'trace_rated', 'post_created', 'comment_created', 'comment_marked_helpful',
    'content_reported', 'content_moderated', 'content_edited', 'content_deleted',
    'mention_created', 'score_projection_rebuilt', 'score_projection_rolled_back',
    'user_blocked', 'user_unblocked', 'user_muted', 'user_unmuted', 'xp_awarded', 'xp_reversed',
    'taste_preferences_updated', 'personalization_toggled'
  ));

create table if not exists public.tracedee_moderation_audit (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.tracedee_content_reports(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  entity_type text not null check (entity_type in ('TRACE', 'PLACE', 'POST', 'COMMENT', 'PROFILE')),
  entity_id uuid not null,
  action text not null check (action in ('REVIEW', 'LIMIT', 'REMOVE', 'RESTORE', 'DISMISS')),
  reason text not null check (length(trim(reason)) between 3 and 1000),
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists tracedee_content_reports_queue_idx
  on public.tracedee_content_reports (status, created_at desc, id desc);

create index if not exists tracedee_moderation_audit_report_idx
  on public.tracedee_moderation_audit (report_id, created_at desc);

create index if not exists tracedee_moderation_audit_entity_idx
  on public.tracedee_moderation_audit (entity_type, entity_id, created_at desc);

alter table public.tracedee_moderation_audit enable row level security;

revoke all on table public.tracedee_moderation_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.tracedee_moderation_audit to service_role;

create or replace function public.tracedee_content_snapshot(
  p_entity_type text,
  p_entity_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_entity_type text := upper(trim(coalesce(p_entity_type, '')));
  v_snapshot jsonb;
begin
  if v_entity_type = 'TRACE' then
    select jsonb_build_object(
      'id', id,
      'slug', slug,
      'title', title,
      'description', description,
      'status', status,
      'moderationStatus', moderation_status,
      'visibility', visibility,
      'revision', revision,
      'area', area,
      'topicTags', topic_tags,
      'updatedAt', updated_at
    ) into v_snapshot
    from public.tracedee_traces
    where id = p_entity_id;
  elsif v_entity_type = 'PLACE' then
    select jsonb_build_object(
      'id', id,
      'slug', slug,
      'name', name,
      'area', area,
      'category', category,
      'description', description,
      'moderationStatus', moderation_status,
      'updatedAt', updated_at
    ) into v_snapshot
    from public.tracedee_places
    where id = p_entity_id;
  elsif v_entity_type = 'POST' then
    select jsonb_build_object(
      'id', id,
      'authorId', author_id,
      'traceId', trace_id,
      'placeId', place_id,
      'body', body,
      'status', status,
      'updatedAt', updated_at
    ) into v_snapshot
    from public.tracedee_posts
    where id = p_entity_id;
  elsif v_entity_type = 'COMMENT' then
    select jsonb_build_object(
      'id', id,
      'threadId', thread_id,
      'authorId', author_id,
      'parentId', parent_id,
      'depth', depth,
      'body', body,
      'status', status,
      'updatedAt', updated_at
    ) into v_snapshot
    from public.tracedee_comments
    where id = p_entity_id;
  elsif v_entity_type = 'PROFILE' then
    select jsonb_build_object(
      'id', id,
      'displayName', display_name
    ) into v_snapshot
    from public.user_profiles
    where id = p_entity_id;
  end if;

  return coalesce(v_snapshot, '{}'::jsonb);
end;
$$;

revoke all on function public.tracedee_content_snapshot(text, uuid) from public, anon, authenticated;
grant execute on function public.tracedee_content_snapshot(text, uuid) to service_role;

update public.tracedee_content_reports
set evidence_snapshot = public.tracedee_content_snapshot(entity_type, entity_id)
where evidence_snapshot = '{}'::jsonb;

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
  v_entity_type text := upper(trim(coalesce(p_entity_type, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_details text := trim(coalesce(p_details, ''));
  v_scope text := 'tracedee:report:' || v_entity_type || ':' || p_entity_id::text;
  v_event_id uuid;
  v_changed boolean := false;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
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

  insert into public.tracedee_content_reports (
    reporter_id,
    entity_type,
    entity_id,
    reason,
    details,
    evidence_snapshot
  )
  values (
    p_actor_id,
    v_entity_type,
    p_entity_id,
    v_reason,
    v_details,
    public.tracedee_content_snapshot(v_entity_type, p_entity_id)
  )
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

  if v_report.evidence_snapshot = '{}'::jsonb then
    update public.tracedee_content_reports
    set evidence_snapshot = public.tracedee_content_snapshot(v_entity_type, p_entity_id)
    where id = v_report.id
    returning * into v_report;
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'reportId', v_report.id,
    'entityType', v_report.entity_type,
    'entityId', v_report.entity_id,
    'status', v_report.status,
    'changed', v_changed,
    'eventId', null,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
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
    v_response := jsonb_set(v_response, '{eventId}', to_jsonb(v_event_id));
  end if;

  update public.tracedee_idempotency_keys
  set response_status = 200, response_body = v_response
  where id = v_idempotency_id;
  return v_response;
end;
$$;

-- Replace the report function's browser grants after the function is recreated.
revoke all on function public.tracedee_report_content(uuid, text, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_report_content(uuid, text, uuid, text, text, text, text, text, text) to service_role;

create or replace function public.tracedee_list_moderation_queue(
  p_status text default 'OPEN',
  p_limit integer default 50,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  report_id uuid,
  entity_type text,
  entity_id uuid,
  reporter_id uuid,
  reporter_name text,
  reason text,
  details text,
  report_status text,
  evidence_snapshot jsonb,
  current_snapshot jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  resolution_code text,
  resolution_note text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    r.id,
    r.entity_type,
    r.entity_id,
    r.reporter_id,
    coalesce(nullif(up.display_name, ''), nullif(up.email, ''), 'Aevo member'),
    r.reason,
    r.details,
    r.status,
    r.evidence_snapshot,
    public.tracedee_content_snapshot(r.entity_type, r.entity_id),
    r.reviewed_by,
    r.reviewed_at,
    r.resolution_code,
    r.resolution_note,
    r.created_at
  from public.tracedee_content_reports r
  left join public.user_profiles up on up.id = r.reporter_id
  where (p_status is null or trim(p_status) = '' or r.status = upper(trim(p_status)))
    and (
      p_before_created_at is null
      or r.created_at < p_before_created_at
      or (r.created_at = p_before_created_at and p_before_id is not null and r.id < p_before_id)
    )
  order by r.created_at desc, r.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

revoke all on function public.tracedee_list_moderation_queue(text, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.tracedee_list_moderation_queue(text, integer, timestamptz, uuid) to service_role;

create or replace function public.tracedee_moderate_report(
  p_actor_id uuid,
  p_report_id uuid,
  p_action text,
  p_reason text,
  p_idempotency_key text,
  p_request_hash text,
  p_source text default 'aevo-admin',
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
  v_audit_id uuid;
  v_event_id uuid;
  v_action text := upper(trim(coalesce(p_action, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_scope text := 'tracedee:moderation:' || p_report_id::text;
  v_before jsonb;
  v_after jsonb;
  v_before_report_status text;
  v_after_report_status text;
  v_content_status text;
  v_changed boolean;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_response jsonb;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if p_report_id is null or v_action not in ('REVIEW', 'LIMIT', 'REMOVE', 'RESTORE', 'DISMISS') or length(v_reason) < 3 or length(v_reason) > 1000 then
    raise exception using errcode = 'P0001', message = 'MODERATION_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
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

  select * into v_report
  from public.tracedee_content_reports
  where id = p_report_id
  for update;
  if v_report.id is null then
    raise exception using errcode = 'P0001', message = 'REPORT_NOT_FOUND';
  end if;
  if v_report.entity_type = 'PROFILE' and v_action in ('LIMIT', 'REMOVE', 'RESTORE') then
    raise exception using errcode = 'P0001', message = 'MODERATION_ACTION_UNSUPPORTED';
  end if;

  v_before_report_status := v_report.status;
  v_before := public.tracedee_content_snapshot(v_report.entity_type, v_report.entity_id);

  if v_action = 'REVIEW' then
    v_after_report_status := 'REVIEWING';
  elsif v_action = 'DISMISS' then
    v_after_report_status := 'DISMISSED';
  else
    v_after_report_status := 'RESOLVED';
    v_content_status := case v_action when 'LIMIT' then 'LIMITED' when 'REMOVE' then 'REMOVED' else 'VISIBLE' end;
    if v_report.entity_type = 'TRACE' then
      update public.tracedee_traces set moderation_status = v_content_status, updated_at = timezone('utc', now()) where id = v_report.entity_id;
    elsif v_report.entity_type = 'PLACE' then
      update public.tracedee_places set moderation_status = v_content_status, updated_at = timezone('utc', now()) where id = v_report.entity_id;
    elsif v_report.entity_type = 'POST' then
      update public.tracedee_posts set status = v_content_status, updated_at = timezone('utc', now()) where id = v_report.entity_id;
    elsif v_report.entity_type = 'COMMENT' then
      update public.tracedee_comments set status = v_content_status, updated_at = timezone('utc', now()) where id = v_report.entity_id;
    end if;
  end if;

  v_after := public.tracedee_content_snapshot(v_report.entity_type, v_report.entity_id);
  v_changed := v_before is distinct from v_after or v_before_report_status is distinct from v_after_report_status;

  update public.tracedee_content_reports
  set status = v_after_report_status,
      reviewed_by = p_actor_id,
      reviewed_at = timezone('utc', now()),
      resolution_code = v_action,
      resolution_note = v_reason
  where id = p_report_id
  returning * into v_report;

  insert into public.tracedee_moderation_audit (
    report_id,
    actor_id,
    entity_type,
    entity_id,
    action,
    reason,
    before_state,
    after_state
  )
  values (
    p_report_id,
    p_actor_id,
    v_report.entity_type,
    v_report.entity_id,
    v_action,
    v_reason,
    jsonb_build_object('reportStatus', v_before_report_status, 'content', v_before),
    jsonb_build_object('reportStatus', v_after_report_status, 'content', v_after)
  )
  returning id into v_audit_id;

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
    'content_moderated',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-admin'),
    p_session_id,
    v_report.entity_type,
    v_report.entity_id,
    jsonb_build_object('reportId', p_report_id, 'auditId', v_audit_id, 'action', v_action, 'contentStatus', v_content_status),
    v_tracking_token,
    v_correlation_id,
    'content-moderated:' || p_report_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true,
    'reportId', p_report_id,
    'entityType', v_report.entity_type,
    'entityId', v_report.entity_id,
    'action', v_action,
    'reportStatus', v_after_report_status,
    'contentStatus', v_content_status,
    'auditId', v_audit_id,
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

revoke all on function public.tracedee_moderate_report(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_moderate_report(uuid, uuid, text, text, text, text, text, text) to service_role;

create or replace function public.tracedee_set_comment_helpful(
  p_actor_id uuid,
  p_comment_id uuid,
  p_active boolean,
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
  v_comment record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_changed boolean := false;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_response jsonb;
  v_rows integer := 0;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if p_comment_id is null or p_active is null then
    raise exception using errcode = 'P0001', message = 'COMMENT_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (
    p_actor_id,
    'tracedee:comment-helpful:' || p_comment_id::text,
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
      and scope = 'tracedee:comment-helpful:' || p_comment_id::text
      and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  select id, thread_id, status into v_comment
  from public.tracedee_comments
  where id = p_comment_id;
  if v_comment.id is null then
    raise exception using errcode = 'P0001', message = 'COMMENT_THREAD_NOT_FOUND';
  end if;
  if v_comment.status not in ('VISIBLE', 'LIMITED') then
    raise exception using errcode = 'P0001', message = 'COMMENT_NOT_ALLOWED';
  end if;

  if p_active then
    insert into public.tracedee_comment_reactions (comment_id, user_id, reaction)
    values (p_comment_id, p_actor_id, 'HELPFUL')
    on conflict (comment_id, user_id, reaction) do nothing;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
  else
    delete from public.tracedee_comment_reactions
    where comment_id = p_comment_id and user_id = p_actor_id and reaction = 'HELPFUL';
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
  end if;

  if v_changed and p_active then
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
      'comment_marked_helpful',
      p_actor_id,
      coalesce(nullif(trim(p_source), ''), 'aevo-go'),
      p_session_id,
      'COMMENT',
      p_comment_id,
      jsonb_build_object('active', true),
      v_tracking_token,
      v_correlation_id,
      'comment-helpful:' || p_actor_id::text || ':' || p_comment_id::text || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'commentId', p_comment_id,
    'active', p_active,
    'helpfulCount', (select count(*) from public.tracedee_comment_reactions where comment_id = p_comment_id and reaction = 'HELPFUL'),
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

revoke all on function public.tracedee_set_comment_helpful(uuid, uuid, boolean, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_set_comment_helpful(uuid, uuid, boolean, text, text, text, text) to service_role;

-- Rebuild the public feed function so moderated traces never leak through
-- public discovery after a queue action.
create or replace function public.tracedee_discovery_feed(
  p_actor_id uuid default null,
  p_tab text default 'for_you',
  p_query text default null,
  p_area text default null,
  p_after_score numeric default null,
  p_after_published_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 20
)
returns table (
  item_type text,
  item_id uuid,
  slug text,
  title text,
  description text,
  creator_id uuid,
  creator_name text,
  status text,
  visibility text,
  cover_place_id uuid,
  area text,
  topic_tags text[],
  stop_count integer,
  follower_count bigint,
  save_count bigint,
  rank_score numeric,
  reason_code text,
  reason_params jsonb,
  tracking_token uuid,
  published_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with flag as (
    select coalesce((
      select f.enabled and f.rollout_percent >= 100
      from public.tracedee_feature_flags f
      where f.flag_key = 'taste_ranking_v1'
      limit 1
    ), false) as taste_enabled
  ),
  base as (
    select
      t.id,
      t.slug,
      t.title,
      t.description,
      t.creator_id,
      coalesce(nullif(up.display_name, ''), nullif(up.email, ''), 'Aevo member') as creator_name,
      t.status,
      t.visibility,
      t.cover_place_id,
      t.area,
      t.topic_tags,
      coalesce((select count(*) from public.tracedee_trace_stops s where s.trace_id = t.id), 0)::integer as stop_count,
      coalesce((select count(*) from public.tracedee_trace_follows f where f.trace_id = t.id), 0)::bigint as follower_count,
      coalesce((select count(*) from public.tracedee_trace_saves s where s.trace_id = t.id), 0)::bigint as save_count,
      coalesce((select q.score from public.tracedee_content_quality_scores q where q.entity_type = 'TRACE' and q.entity_id = t.id order by q.score_version desc limit 1), 0)::numeric
        + coalesce((select count(*) from public.tracedee_trace_saves s where s.trace_id = t.id), 0)::numeric * 10
        + coalesce((select count(*) from public.tracedee_trace_follows f where f.trace_id = t.id), 0)::numeric * 5 as base_score,
      coalesce((select sum(ta.affinity)
        from public.tracedee_taste_affinities ta
        where ta.profile_id = p_actor_id
          and ta.dimension_type = 'TOPIC'
          and exists (
            select 1 from unnest(t.topic_tags) as tag(value)
            where ta.dimension_key = lower(trim(value))
          )), 0)::numeric as taste_score,
      (p_actor_id is not null and exists (
        select 1 from public.tracedee_tracer_follows tf
        where tf.follower_id = p_actor_id and tf.tracer_id = t.creator_id
      )) as follows_tracer,
      coalesce(t.published_at, t.created_at) as effective_published_at,
      flag.taste_enabled
    from public.tracedee_traces t
    cross join flag
    left join public.user_profiles up on up.id = t.creator_id
    where t.status = 'PUBLISHED'
      and t.visibility = 'PUBLIC'
      and t.moderation_status in ('VISIBLE', 'LIMITED')
      and (p_query is null or lower(concat_ws(' ', t.title, t.description, t.area, array_to_string(t.topic_tags, ' '))) like '%' || lower(trim(p_query)) || '%')
      and (p_area is null or lower(t.area) = lower(trim(p_area)))
      and (p_tab <> 'following' or (p_actor_id is not null and exists (
        select 1 from public.tracedee_tracer_follows tf
        where tf.follower_id = p_actor_id and tf.tracer_id = t.creator_id
      )))
  ),
  scored as (
    select
      b.*,
      b.base_score + case when b.taste_enabled and b.taste_score > 0 then least(250, b.taste_score * 2) else 0 end as computed_score,
      case
        when b.follows_tracer then 'FOLLOWING_TRACER'
        when b.taste_enabled and b.taste_score > 0 then 'TASTE_MATCH'
        when b.follower_count + b.save_count > 0 then 'POPULAR'
        else 'NEW_TRACE'
      end as computed_reason
    from base b
  )
  select
    'TRACE'::text,
    b.id,
    b.slug,
    b.title,
    b.description,
    b.creator_id,
    b.creator_name,
    b.status,
    b.visibility,
    b.cover_place_id,
    b.area,
    b.topic_tags,
    b.stop_count,
    b.follower_count,
    b.save_count,
    b.computed_score,
    b.computed_reason,
    jsonb_build_object('area', b.area, 'stopCount', b.stop_count, 'creatorId', b.creator_id, 'tasteScore', case when b.taste_enabled then b.taste_score else 0 end),
    gen_random_uuid(),
    b.effective_published_at
  from scored b
  where (
    p_after_id is null
    or b.computed_score < p_after_score
    or (b.computed_score = p_after_score and b.effective_published_at < p_after_published_at)
    or (b.computed_score = p_after_score and b.effective_published_at = p_after_published_at and b.id < p_after_id)
  )
  order by b.computed_score desc, b.effective_published_at desc, b.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 48);
$$;

revoke all on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) to service_role;
