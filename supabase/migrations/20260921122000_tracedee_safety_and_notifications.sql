-- TraceDee Phase 3: social safety controls and aggregated notifications.
-- Blocks/mutes are account-scoped, private, and enforced in server-owned
-- discovery/community/notification reads. Notification aggregation keeps the
-- append-only activity stream intact while reducing recipient spam.

create table if not exists public.tracedee_user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.tracedee_user_mutes (
  muter_id uuid not null references auth.users(id) on delete cascade,
  muted_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (muter_id, muted_id),
  check (muter_id <> muted_id)
);

alter table public.tracedee_user_blocks enable row level security;
alter table public.tracedee_user_mutes enable row level security;

create index if not exists tracedee_user_blocks_blocked_idx
  on public.tracedee_user_blocks (blocked_id, created_at desc);
create index if not exists tracedee_user_mutes_muted_idx
  on public.tracedee_user_mutes (muted_id, created_at desc);

alter table public.tracedee_notifications
  add column if not exists aggregation_key text,
  add column if not exists aggregation_count integer not null default 1,
  add column if not exists last_actor_id uuid references auth.users(id) on delete set null;

alter table public.tracedee_notifications
  drop constraint if exists tracedee_notifications_aggregation_count_check;
alter table public.tracedee_notifications
  add constraint tracedee_notifications_aggregation_count_check check (aggregation_count >= 1);

update public.tracedee_notifications
set aggregation_key = lower(event_type) || ':' || lower(entity_type) || ':' || coalesce(entity_id::text, id::text),
    last_actor_id = actor_id
where aggregation_key is null;

create index if not exists tracedee_notifications_aggregation_idx
  on public.tracedee_notifications (recipient_id, aggregation_key, created_at desc);

create or replace function public.tracedee_prepare_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_existing record;
begin
  if new.recipient_id is null or new.actor_id = new.recipient_id then
    return null;
  end if;

  if new.actor_id is not null and (
    exists (
      select 1 from public.tracedee_user_blocks b
      where b.blocker_id = new.recipient_id and b.blocked_id = new.actor_id
    )
    or exists (
      select 1 from public.tracedee_user_mutes m
      where m.muter_id = new.recipient_id and m.muted_id = new.actor_id
    )
  ) then
    return null;
  end if;

  v_key := case
    when new.event_type = 'trace_post_created' then
      'trace_post_created:' || coalesce(new.payload->>'traceId', new.entity_id::text, 'unknown')
    when new.event_type = 'post_comment_created' then
      'post_comment_created:' || coalesce(new.payload->>'threadId', new.entity_id::text, 'unknown')
    else lower(new.event_type) || ':' || lower(new.entity_type) || ':' || coalesce(new.entity_id::text, 'unknown')
  end;
  new.aggregation_key := v_key;
  new.aggregation_count := greatest(coalesce(new.aggregation_count, 1), 1);
  new.last_actor_id := new.actor_id;

  perform pg_advisory_xact_lock(hashtextextended(new.recipient_id::text || ':' || v_key, 0));
  select id, aggregation_count
  into v_existing
  from public.tracedee_notifications
  where recipient_id = new.recipient_id
    and aggregation_key = v_key
    and created_at >= timezone('utc', now()) - interval '24 hours'
  order by created_at desc
  limit 1;

  if v_existing.id is not null then
    update public.tracedee_notifications
    set actor_id = new.actor_id,
        last_actor_id = new.actor_id,
        aggregation_count = v_existing.aggregation_count + 1,
        payload = payload || jsonb_build_object('latest', new.payload, 'aggregated', true),
        read_at = null,
        created_at = timezone('utc', now())
    where id = v_existing.id;
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists tracedee_notifications_prepare on public.tracedee_notifications;
create trigger tracedee_notifications_prepare
before insert on public.tracedee_notifications
for each row execute function public.tracedee_prepare_notification();

create or replace function public.tracedee_set_user_relation(
  p_actor_id uuid,
  p_target_id uuid,
  p_relation text,
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
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_changed boolean := false;
  v_event_type text;
  v_relation text := upper(trim(coalesce(p_relation, '')));
  v_response jsonb;
  v_rows integer := 0;
  v_scope text;
begin
  if p_actor_id is null or p_target_id is null or p_actor_id = p_target_id then
    raise exception using errcode = 'P0001', message = 'USER_RELATION_INPUT_INVALID';
  end if;
  if v_relation not in ('BLOCK', 'MUTE') or p_active is null then
    raise exception using errcode = 'P0001', message = 'USER_RELATION_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;
  if not exists (select 1 from auth.users where id = p_target_id) then
    raise exception using errcode = 'P0001', message = 'USER_RELATION_TARGET_NOT_FOUND';
  end if;

  v_scope := 'tracedee:user-relation:' || lower(v_relation) || ':' || p_target_id::text;
  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, v_scope, trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
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

  if v_relation = 'BLOCK' then
    if p_active then
      insert into public.tracedee_user_blocks (blocker_id, blocked_id)
      values (p_actor_id, p_target_id)
      on conflict (blocker_id, blocked_id) do nothing;
      get diagnostics v_rows = row_count;
      delete from public.tracedee_notifications
      where recipient_id = p_actor_id and actor_id = p_target_id;
    else
      delete from public.tracedee_user_blocks where blocker_id = p_actor_id and blocked_id = p_target_id;
      get diagnostics v_rows = row_count;
    end if;
    v_event_type := case when p_active then 'user_blocked' else 'user_unblocked' end;
  else
    if p_active then
      insert into public.tracedee_user_mutes (muter_id, muted_id)
      values (p_actor_id, p_target_id)
      on conflict (muter_id, muted_id) do nothing;
      get diagnostics v_rows = row_count;
      delete from public.tracedee_notifications
      where recipient_id = p_actor_id and actor_id = p_target_id;
    else
      delete from public.tracedee_user_mutes where muter_id = p_actor_id and muted_id = p_target_id;
      get diagnostics v_rows = row_count;
    end if;
    v_event_type := case when p_active then 'user_muted' else 'user_unmuted' end;
  end if;
  v_changed := v_rows > 0;

  if v_changed then
    insert into public.tracedee_activity_events (
      event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
      tracking_token, correlation_id, dedupe_key
    )
    values (
      v_event_type,
      p_actor_id,
      coalesce(nullif(trim(p_source), ''), 'aevo-go'),
      p_session_id,
      'PROFILE',
      p_target_id,
      jsonb_build_object('relation', v_relation, 'active', p_active),
      v_tracking_token,
      v_correlation_id,
      'user-relation:' || lower(v_relation) || ':' || p_actor_id::text || ':' || p_target_id::text || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'targetId', p_target_id,
    'relation', v_relation,
    'active', p_active,
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

revoke all on function public.tracedee_set_user_relation(uuid, uuid, text, boolean, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_set_user_relation(uuid, uuid, text, boolean, text, text, text, text) to service_role;

create or replace function public.tracedee_list_notifications(
  p_actor_id uuid,
  p_limit integer default 30,
  p_unread_only boolean default false
)
returns table (
  id uuid,
  event_type text,
  entity_type text,
  entity_id uuid,
  actor_id uuid,
  last_actor_id uuid,
  payload jsonb,
  aggregation_count integer,
  read_at timestamptz,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select n.id, n.event_type, n.entity_type, n.entity_id, n.actor_id, n.last_actor_id,
    n.payload, n.aggregation_count, n.read_at, n.created_at
  from public.tracedee_notifications n
  where n.recipient_id = p_actor_id
    and (not coalesce(p_unread_only, false) or n.read_at is null)
    and not exists (
      select 1 from public.tracedee_user_blocks b
      where b.blocker_id = p_actor_id and b.blocked_id = n.actor_id
    )
    and not exists (
      select 1 from public.tracedee_user_mutes m
      where m.muter_id = p_actor_id and m.muted_id = n.actor_id
    )
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

revoke all on function public.tracedee_list_notifications(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.tracedee_list_notifications(uuid, integer, boolean) to service_role;

create or replace function public.tracedee_mark_notification_read(
  p_actor_id uuid,
  p_notification_id uuid,
  p_read boolean,
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
  v_idempotency_id uuid;
  v_changed boolean := false;
  v_response jsonb;
  v_scope text := 'tracedee:notification-read:' || p_notification_id::text;
begin
  if p_actor_id is null or p_notification_id is null or p_read is null then
    raise exception using errcode = 'P0001', message = 'NOTIFICATION_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

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

  update public.tracedee_notifications
  set read_at = case when p_read then coalesce(read_at, timezone('utc', now())) else null end
  where id = p_notification_id and recipient_id = p_actor_id
  returning (read_at is not null) into p_read;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOTIFICATION_NOT_FOUND';
  end if;
  v_changed := true;
  v_response := jsonb_build_object('ok', true, 'notificationId', p_notification_id, 'read', p_read, 'changed', v_changed);
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_mark_notification_read(uuid, uuid, boolean, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_mark_notification_read(uuid, uuid, boolean, text, text, text, text) to service_role;

-- Add social safety event types without changing the append-only contract.
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

-- Keep the deterministic feed server-owned while excluding blocked/muted
-- creators. The function is rewritten from the installed definition so the
-- change remains compatible with prior ranking versions.
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tracedee_discovery_feed'
    and p.pronargs = 8
  order by p.oid desc
  limit 1;
  if v_definition is null then
    raise exception 'tracedee_discovery_feed function is not installed';
  end if;
  v_definition := replace(
    v_definition,
    '      and t.moderation_status in (''VISIBLE'', ''LIMITED'')
      and (p_query is null',
    '      and t.moderation_status in (''VISIBLE'', ''LIMITED'')
      and not exists (select 1 from public.tracedee_user_blocks b where b.blocker_id = p_actor_id and b.blocked_id = t.creator_id)
      and not exists (select 1 from public.tracedee_user_mutes m where m.muter_id = p_actor_id and m.muted_id = t.creator_id)
      and (p_query is null'
  );
  execute v_definition;
end;
$migration$;
