-- TraceDee Phase 3: editable community content, soft deletion, and mentions.
-- Content remains recoverable for moderation/audit; public reads continue to
-- expose only VISIBLE/LIMITED rows.

alter table public.tracedee_posts
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

alter table public.tracedee_comments
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

create table if not exists public.tracedee_mentions (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('POST', 'COMMENT')),
  source_id uuid not null,
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  mention_token text not null check (length(trim(mention_token)) between 1 and 80),
  created_at timestamptz not null default timezone('utc', now()),
  unique (source_type, source_id, mentioned_user_id)
);

alter table public.tracedee_mentions enable row level security;
create index if not exists tracedee_mentions_user_created_idx
  on public.tracedee_mentions (mentioned_user_id, created_at desc);
create index if not exists tracedee_mentions_source_idx
  on public.tracedee_mentions (source_type, source_id);

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

create or replace function public.tracedee_edit_content(
  p_actor_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_body text,
  p_expected_updated_at timestamptz default null,
  p_idempotency_key text default null,
  p_request_hash text default null,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_entity_type text := upper(trim(coalesce(p_entity_type, '')));
  v_body text := trim(coalesce(p_body, ''));
  v_existing record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_status text;
  v_changed boolean := false;
  v_response jsonb;
  v_scope text;
begin
  if p_actor_id is null or p_entity_id is null or v_entity_type not in ('POST', 'COMMENT')
     or length(v_body) < 1 or length(v_body) > (case when v_entity_type = 'POST' then 8000 else 3000 end) then
    raise exception using errcode = 'P0001', message = 'CONTENT_EDIT_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  v_scope := 'tracedee:content-edit:' || lower(v_entity_type) || ':' || p_entity_id::text;
  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, v_scope, trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;
  if v_idempotency_id is null then
    select request_hash, response_body into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id and scope = v_scope and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  if v_entity_type = 'POST' then
    select id, author_id, body, status, updated_at, deleted_at
    into v_existing
    from public.tracedee_posts
    where id = p_entity_id;
  else
    select id, author_id, body, status, updated_at, deleted_at
    into v_existing
    from public.tracedee_comments
    where id = p_entity_id;
  end if;
  if v_existing.id is null then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_FOUND';
  end if;
  if v_existing.author_id <> p_actor_id or v_existing.deleted_at is not null or v_existing.status = 'REMOVED' then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_EDITABLE';
  end if;
  if p_expected_updated_at is not null and p_expected_updated_at <> v_existing.updated_at then
    raise exception using errcode = 'P0001', message = 'CONTENT_VERSION_CONFLICT';
  end if;

  if v_body = trim(v_existing.body) then
    v_response := jsonb_build_object(
      'ok', true, 'entityType', v_entity_type, 'entityId', p_entity_id,
      'status', v_existing.status, 'body', v_existing.body,
      'editedAt', v_existing.updated_at, 'changed', false,
      'eventId', null, 'correlationId', v_correlation_id, 'trackingToken', v_tracking_token
    );
    update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
    return v_response;
  end if;

  v_status := case when v_body ~* '(https?://|www\.)' then 'UNDER_REVIEW' else 'VISIBLE' end;
  if v_entity_type = 'POST' then
    update public.tracedee_posts
    set body = v_body, status = v_status, edited_at = timezone('utc', now()), updated_at = timezone('utc', now())
    where id = p_entity_id;
  else
    update public.tracedee_comments
    set body = v_body, status = v_status, edited_at = timezone('utc', now()), updated_at = timezone('utc', now())
    where id = p_entity_id;
  end if;
  v_changed := true;

  delete from public.tracedee_mentions where source_type = v_entity_type and source_id = p_entity_id;
  insert into public.tracedee_mentions (source_type, source_id, mentioned_user_id, mention_token)
  select distinct v_entity_type, p_entity_id, up.id, matches.token
  from regexp_matches(v_body, '@([[:alnum:]_.-]{1,64})', 'g') as matches(token)
  join public.user_profiles up
    on lower(regexp_replace(up.display_name, '[^[:alnum:]_.-]', '', 'g')) = lower(matches.token)
  where up.id <> p_actor_id
  on conflict (source_type, source_id, mentioned_user_id) do update
    set mention_token = excluded.mention_token;

  insert into public.tracedee_notifications (recipient_id, actor_id, event_type, entity_type, entity_id, payload)
  select m.mentioned_user_id, p_actor_id, 'mention_created', v_entity_type, p_entity_id,
    jsonb_build_object('sourceType', v_entity_type, 'sourceId', p_entity_id, 'mentionToken', m.mention_token)
  from public.tracedee_mentions m
  where m.source_type = v_entity_type and m.source_id = p_entity_id;

  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  )
  values (
    'content_edited', p_actor_id, coalesce(nullif(trim(p_source), ''), 'aevo-go'), p_session_id,
    v_entity_type, p_entity_id,
    jsonb_build_object('status', v_status, 'bodyLength', length(v_body)),
    v_tracking_token, v_correlation_id,
    'content-edit:' || lower(v_entity_type) || ':' || p_entity_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true, 'entityType', v_entity_type, 'entityId', p_entity_id,
    'status', v_status, 'body', v_body, 'editedAt', timezone('utc', now()),
    'changed', v_changed, 'eventId', v_event_id, 'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_edit_content(uuid, text, uuid, text, timestamptz, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_edit_content(uuid, text, uuid, text, timestamptz, text, text, text, text) to service_role;

create or replace function public.tracedee_delete_content(
  p_actor_id uuid,
  p_entity_type text,
  p_entity_id uuid,
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
  v_entity_type text := upper(trim(coalesce(p_entity_type, '')));
  v_existing record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_changed boolean := false;
  v_response jsonb;
  v_scope text;
begin
  if p_actor_id is null or p_entity_id is null or v_entity_type not in ('POST', 'COMMENT') then
    raise exception using errcode = 'P0001', message = 'CONTENT_DELETE_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  v_scope := 'tracedee:content-delete:' || lower(v_entity_type) || ':' || p_entity_id::text;
  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, v_scope, trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;
  if v_idempotency_id is null then
    select request_hash, response_body into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id and scope = v_scope and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  if v_entity_type = 'POST' then
    select id, author_id, status, deleted_at into v_existing from public.tracedee_posts where id = p_entity_id;
  else
    select id, author_id, status, deleted_at into v_existing from public.tracedee_comments where id = p_entity_id;
  end if;
  if v_existing.id is null then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_FOUND';
  end if;
  if v_existing.author_id <> p_actor_id then
    raise exception using errcode = 'P0001', message = 'CONTENT_DELETE_NOT_ALLOWED';
  end if;
  if v_existing.deleted_at is null and v_existing.status <> 'REMOVED' then
    if v_entity_type = 'POST' then
      update public.tracedee_posts set status = 'REMOVED', deleted_at = timezone('utc', now()), deleted_by = p_actor_id, updated_at = timezone('utc', now()) where id = p_entity_id;
    else
      update public.tracedee_comments set status = 'REMOVED', deleted_at = timezone('utc', now()), deleted_by = p_actor_id, updated_at = timezone('utc', now()) where id = p_entity_id;
    end if;
    delete from public.tracedee_mentions where source_type = v_entity_type and source_id = p_entity_id;
    v_changed := true;
  end if;

  if v_changed then
    insert into public.tracedee_activity_events (
      event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
      tracking_token, correlation_id, dedupe_key
    )
    values (
      'content_deleted', p_actor_id, coalesce(nullif(trim(p_source), ''), 'aevo-go'), p_session_id,
      v_entity_type, p_entity_id, jsonb_build_object('softDeleted', true),
      v_tracking_token, v_correlation_id,
      'content-delete:' || lower(v_entity_type) || ':' || p_entity_id::text || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);
  end if;

  v_response := jsonb_build_object(
    'ok', true, 'entityType', v_entity_type, 'entityId', p_entity_id,
    'status', 'REMOVED', 'changed', v_changed, 'eventId', v_event_id,
    'correlationId', v_correlation_id, 'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_delete_content(uuid, text, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_delete_content(uuid, text, uuid, text, text, text, text) to service_role;
