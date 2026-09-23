-- TraceDee Phase 2: server-owned journey state machine.
-- A journey is a snapshot of a published trace revision. Every transition is
-- idempotent and appends an activity event plus an outbox row in the same
-- transaction as the state mutation.

create index if not exists tracedee_journey_stops_journey_status_idx
  on public.tracedee_journey_stops (journey_id, status, position);
create index if not exists tracedee_completions_user_time_idx
  on public.tracedee_completions (user_id, completed_at desc);
create index if not exists tracedee_completions_trace_time_idx
  on public.tracedee_completions (trace_id, completed_at desc);

create or replace function public.tracedee_create_journey(
  p_actor_id uuid,
  p_trace_id uuid,
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
  v_trace record;
  v_existing record;
  v_existing_journey record;
  v_idempotency_id uuid;
  v_journey_id uuid;
  v_stop_count integer := 0;
  v_correlation_id uuid := gen_random_uuid();
  v_response jsonb;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  select id, slug, revision, status, visibility
  into v_trace
  from public.tracedee_traces
  where id = p_trace_id and status = 'PUBLISHED' and visibility = 'PUBLIC';
  if not found then
    raise exception using errcode = 'P0001', message = 'TRACE_NOT_FOUND';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, 'tracedee:journey:create:' || p_trace_id::text, trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id
      and scope = 'tracedee:journey:create:' || p_trace_id::text
      and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  select id, status, version, trace_revision
  into v_existing_journey
  from public.tracedee_journeys
  where user_id = p_actor_id
    and trace_id = p_trace_id
    and status in ('PLANNED', 'ACTIVE', 'PAUSED')
  order by created_at desc
  limit 1;

  if found then
    select count(*) into v_stop_count from public.tracedee_journey_stops where journey_id = v_existing_journey.id;
    v_response := jsonb_build_object(
      'ok', true,
      'journeyId', v_existing_journey.id,
      'traceId', p_trace_id,
      'traceSlug', v_trace.slug,
      'status', v_existing_journey.status,
      'version', v_existing_journey.version,
      'traceRevision', v_existing_journey.trace_revision,
      'stopCount', v_stop_count,
      'changed', false,
      'eventId', null,
      'correlationId', v_correlation_id
    );
    update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
    return v_response;
  end if;

  insert into public.tracedee_journeys (user_id, trace_id, trace_revision, status)
  values (p_actor_id, p_trace_id, v_trace.revision, 'PLANNED')
  returning id into v_journey_id;

  insert into public.tracedee_journey_stops (journey_id, trace_stop_id, position)
  select v_journey_id, s.id, s.position
  from public.tracedee_trace_stops s
  where s.trace_id = p_trace_id
  order by s.position asc;
  get diagnostics v_stop_count = row_count;
  if v_stop_count = 0 then
    raise exception using errcode = 'P0001', message = 'TRACE_HAS_NO_STOPS';
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'journeyId', v_journey_id,
    'traceId', p_trace_id,
    'traceSlug', v_trace.slug,
    'status', 'PLANNED',
    'version', 1,
    'traceRevision', v_trace.revision,
    'stopCount', v_stop_count,
    'changed', true,
    'eventId', null,
    'correlationId', v_correlation_id
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

create or replace function public.tracedee_journey_action(
  p_actor_id uuid,
  p_journey_id uuid,
  p_action text,
  p_idempotency_key text,
  p_request_hash text,
  p_stop_id uuid default null,
  p_stop_status text default null,
  p_expected_version integer default null,
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
  v_stop record;
  v_existing record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_event_type text;
  v_completion_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_changed boolean := false;
  v_stop_count integer := 0;
  v_completed_count integer := 0;
  v_skipped_count integer := 0;
  v_pending_count integer := 0;
  v_rows integer := 0;
  v_response jsonb;
  v_scope text;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if p_action not in ('START', 'UPDATE_STOP', 'PAUSE', 'ABANDON', 'COMPLETE') then
    raise exception using errcode = 'P0001', message = 'JOURNEY_ACTION_NOT_SUPPORTED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  v_scope := 'tracedee:journey:' || lower(p_action) || ':' || p_journey_id::text || ':' || coalesce(p_stop_id::text, '-');
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

  select
    j.id, j.user_id, j.trace_id, j.trace_revision, j.status, j.version,
    t.slug as trace_slug
  into v_journey
  from public.tracedee_journeys j
  join public.tracedee_traces t on t.id = j.trace_id
  where j.id = p_journey_id and j.user_id = p_actor_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'JOURNEY_NOT_FOUND';
  end if;

  if p_expected_version is not null and p_expected_version <> v_journey.version then
    raise exception using errcode = 'P0001', message = 'JOURNEY_VERSION_CONFLICT';
  end if;

  if p_action = 'START' then
    if v_journey.status not in ('PLANNED', 'PAUSED') then
      raise exception using errcode = 'P0001', message = 'JOURNEY_CANNOT_START';
    end if;
    update public.tracedee_journeys
    set status = 'ACTIVE', version = version + 1, started_at = coalesce(started_at, timezone('utc', now()))
    where id = p_journey_id;
    v_changed := true;
    v_event_type := 'trace_started';
  elsif p_action = 'PAUSE' then
    if v_journey.status <> 'ACTIVE' then
      raise exception using errcode = 'P0001', message = 'JOURNEY_CANNOT_PAUSE';
    end if;
    update public.tracedee_journeys set status = 'PAUSED', version = version + 1 where id = p_journey_id;
    v_changed := true;
  elsif p_action = 'ABANDON' then
    if v_journey.status in ('COMPLETED', 'ABANDONED') then
      raise exception using errcode = 'P0001', message = 'JOURNEY_CANNOT_ABANDON';
    end if;
    update public.tracedee_journeys set status = 'ABANDONED', version = version + 1 where id = p_journey_id;
    v_changed := true;
  elsif p_action = 'UPDATE_STOP' then
    if p_stop_id is null or p_stop_status not in ('COMPLETED', 'SKIPPED') then
      raise exception using errcode = 'P0001', message = 'JOURNEY_STOP_INPUT_INVALID';
    end if;
    if v_journey.status not in ('ACTIVE', 'PAUSED') then
      raise exception using errcode = 'P0001', message = 'JOURNEY_STOP_NOT_EDITABLE';
    end if;
    select id, journey_id, status, version
    into v_stop
    from public.tracedee_journey_stops
    where id = p_stop_id and journey_id = p_journey_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'JOURNEY_STOP_NOT_FOUND';
    end if;
    if v_stop.status = p_stop_status then
      v_changed := false;
    else
      update public.tracedee_journey_stops
      set status = p_stop_status,
          version = version + 1,
          completed_at = case when p_stop_status = 'COMPLETED' then timezone('utc', now()) else null end
      where id = p_stop_id;
      update public.tracedee_journeys set version = version + 1 where id = p_journey_id;
      v_changed := true;
      v_event_type := case when p_stop_status = 'COMPLETED' then 'trace_stop_completed' else 'trace_stop_skipped' end;
    end if;
  elsif p_action = 'COMPLETE' then
    if v_journey.status not in ('ACTIVE', 'PAUSED') then
      raise exception using errcode = 'P0001', message = 'JOURNEY_CANNOT_COMPLETE';
    end if;
    select count(*) into v_stop_count from public.tracedee_journey_stops where journey_id = p_journey_id;
    select count(*) filter (where status = 'COMPLETED'), count(*) filter (where status = 'SKIPPED'), count(*) filter (where status = 'PENDING')
    into v_completed_count, v_skipped_count, v_pending_count
    from public.tracedee_journey_stops where journey_id = p_journey_id;
    if v_pending_count > 0 or v_completed_count = 0 then
      raise exception using errcode = 'P0001', message = 'JOURNEY_INCOMPLETE';
    end if;
    update public.tracedee_journeys
    set status = 'COMPLETED', version = version + 1, completed_at = timezone('utc', now())
    where id = p_journey_id;
    insert into public.tracedee_completions (
      journey_id, user_id, trace_id, completed_stop_count, stop_count, completion_ratio,
      verification_status, verification_summary
    )
    values (
      p_journey_id, p_actor_id, v_journey.trace_id, v_completed_count, v_stop_count,
      v_completed_count::numeric / greatest(v_stop_count, 1), 'SELF_REPORTED',
      jsonb_build_object('skippedStopCount', v_skipped_count, 'traceRevision', v_journey.trace_revision)
    )
    on conflict (journey_id) do update set
      completed_stop_count = excluded.completed_stop_count,
      stop_count = excluded.stop_count,
      completion_ratio = excluded.completion_ratio,
      verification_summary = excluded.verification_summary
    returning id into v_completion_id;
    v_changed := true;
    v_event_type := 'trace_completed';
  end if;

  select j.status, j.version into v_journey.status, v_journey.version from public.tracedee_journeys j where j.id = p_journey_id;
  select count(*) into v_stop_count from public.tracedee_journey_stops where journey_id = p_journey_id;
  select count(*) filter (where status = 'COMPLETED'), count(*) filter (where status = 'SKIPPED'), count(*) filter (where status = 'PENDING')
  into v_completed_count, v_skipped_count, v_pending_count
  from public.tracedee_journey_stops where journey_id = p_journey_id;

  if v_changed and v_event_type is not null then
    insert into public.tracedee_activity_events (
      event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
      tracking_token, correlation_id, dedupe_key
    )
    values (
      v_event_type, p_actor_id, coalesce(nullif(trim(p_source), ''), 'aevo-go'), p_session_id,
      'JOURNEY', p_journey_id,
      jsonb_build_object('traceId', v_journey.trace_id, 'traceRevision', v_journey.trace_revision, 'stopId', p_stop_id, 'stopStatus', p_stop_status),
      v_tracking_token, v_correlation_id,
      'journey-action:' || p_actor_id::text || ':' || lower(p_action) || ':' || p_journey_id::text || ':' || coalesce(p_stop_id::text, '-') || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'journeyId', p_journey_id,
    'traceId', v_journey.trace_id,
    'traceSlug', v_journey.trace_slug,
    'status', v_journey.status,
    'version', v_journey.version,
    'traceRevision', v_journey.trace_revision,
    'stopCount', v_stop_count,
    'completedStopCount', v_completed_count,
    'skippedStopCount', v_skipped_count,
    'pendingStopCount', v_pending_count,
    'completionId', v_completion_id,
    'changed', v_changed,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_create_journey(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_create_journey(uuid, uuid, text, text, text, text) to service_role;
revoke all on function public.tracedee_journey_action(uuid, uuid, text, text, text, uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_journey_action(uuid, uuid, text, text, text, uuid, text, integer, text, text) to service_role;
