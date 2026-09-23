-- TraceDee Phase 4 replay/rollback foundation.
--
-- The authoritative tables and append-only events remain unchanged. Each
-- worker rebuild records the exact pre-rebuild projection snapshot, allowing a
-- privileged operator to restore that snapshot when an event is invalidated.

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

create table if not exists public.tracedee_score_projection_runs (
  id uuid primary key default gen_random_uuid(),
  score_version integer not null check (score_version > 0),
  status text not null check (status in ('APPLYING', 'APPLIED', 'ROLLED_BACK', 'FAILED')),
  reason text not null default 'scheduled' check (length(trim(reason)) between 1 and 500),
  previous_snapshot jsonb not null default '{}'::jsonb,
  applied_snapshot jsonb not null default '{}'::jsonb,
  profile_count integer not null default 0 check (profile_count >= 0),
  expertise_count integer not null default 0 check (expertise_count >= 0),
  taste_count integer not null default 0 check (taste_count >= 0),
  quality_count integer not null default 0 check (quality_count >= 0),
  failure_reason text not null default '',
  rollback_reason text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  applied_at timestamptz,
  rolled_back_at timestamptz
);

create index if not exists tracedee_score_projection_runs_status_idx
  on public.tracedee_score_projection_runs (status, created_at desc);

alter table public.tracedee_score_projection_runs enable row level security;
revoke all on table public.tracedee_score_projection_runs from public, anon, authenticated;
grant select, insert, update on table public.tracedee_score_projection_runs to service_role;

create or replace function public.tracedee_projection_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'profile', coalesce((select jsonb_agg(to_jsonb(row_data)) from public.tracedee_profile_scores row_data where row_data.score_version = 1), '[]'::jsonb),
    'expertise', coalesce((select jsonb_agg(to_jsonb(row_data)) from public.tracedee_expertise_scores row_data where row_data.score_version = 1), '[]'::jsonb),
    'taste', coalesce((select jsonb_agg(to_jsonb(row_data)) from public.tracedee_taste_affinities row_data where row_data.score_version = 1), '[]'::jsonb),
    'quality', coalesce((select jsonb_agg(to_jsonb(row_data)) from public.tracedee_content_quality_scores row_data where row_data.score_version = 1), '[]'::jsonb)
  );
$$;

revoke all on function public.tracedee_projection_snapshot() from public, anon, authenticated;
grant execute on function public.tracedee_projection_snapshot() to service_role;

create or replace function public.tracedee_rebuild_projections_with_run(
  p_reason text default 'scheduled'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_reason text := left(nullif(trim(coalesce(p_reason, '')), ''), 500);
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_error text;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
begin
  v_reason := coalesce(v_reason, 'scheduled');
  v_before := public.tracedee_projection_snapshot();
  insert into public.tracedee_score_projection_runs (id, score_version, status, reason, previous_snapshot)
  values (v_run_id, 1, 'APPLYING', v_reason, v_before);

  begin
    v_result := public.tracedee_rebuild_projections();
  exception when others then
    get stacked diagnostics v_error = message_text;
    update public.tracedee_score_projection_runs
    set status = 'FAILED', failure_reason = left(coalesce(v_error, 'projection rebuild failed'), 2000)
    where id = v_run_id;
    raise;
  end;

  v_after := public.tracedee_projection_snapshot();
  update public.tracedee_score_projection_runs
  set status = 'APPLIED',
      applied_snapshot = v_after,
      profile_count = coalesce((v_result ->> 'profileCount')::integer, 0),
      expertise_count = coalesce((v_result ->> 'expertiseCount')::integer, 0),
      taste_count = coalesce((v_result ->> 'tasteCount')::integer, 0),
      quality_count = coalesce((v_result ->> 'qualityCount')::integer, 0),
      applied_at = timezone('utc', now())
  where id = v_run_id;

  insert into public.tracedee_activity_events (
    event_type,
    actor_id,
    source,
    entity_type,
    entity_id,
    metadata,
    tracking_token,
    correlation_id,
    dedupe_key
  )
  values (
    'score_projection_rebuilt',
    null,
    'tracedee-projector',
    'SCORE_PROJECTION_RUN',
    v_run_id,
    jsonb_build_object('runId', v_run_id, 'scoreVersion', 1, 'reason', v_reason),
    v_tracking_token,
    v_correlation_id,
    'score-projection-rebuilt:' || v_run_id::text
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  return v_result || jsonb_build_object(
    'runId', v_run_id,
    'reason', v_reason,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
end;
$$;

revoke all on function public.tracedee_rebuild_projections_with_run(text) from public, anon, authenticated;
grant execute on function public.tracedee_rebuild_projections_with_run(text) to service_role;

create or replace function public.tracedee_list_projection_runs(
  p_limit integer default 20
)
returns table (
  run_id uuid,
  score_version integer,
  status text,
  reason text,
  profile_count integer,
  expertise_count integer,
  taste_count integer,
  quality_count integer,
  failure_reason text,
  rollback_reason text,
  created_at timestamptz,
  applied_at timestamptz,
  rolled_back_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select id, score_version, status, reason, profile_count, expertise_count, taste_count, quality_count, failure_reason, rollback_reason, created_at, applied_at, rolled_back_at
  from public.tracedee_score_projection_runs
  order by created_at desc, id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

revoke all on function public.tracedee_list_projection_runs(integer) from public, anon, authenticated;
grant execute on function public.tracedee_list_projection_runs(integer) to service_role;

create or replace function public.tracedee_rollback_projection(
  p_actor_id uuid,
  p_run_id uuid,
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
  v_run record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_reason text := trim(coalesce(p_reason, ''));
  v_scope text := 'tracedee:projection-rollback:' || p_run_id::text;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_response jsonb;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if p_run_id is null or length(v_reason) < 3 or length(v_reason) > 1000 then
    raise exception using errcode = 'P0001', message = 'PROJECTION_ROLLBACK_INVALID';
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

  select * into v_run
  from public.tracedee_score_projection_runs
  where id = p_run_id
  for update;
  if v_run.id is null then
    raise exception using errcode = 'P0001', message = 'PROJECTION_RUN_NOT_FOUND';
  end if;
  if v_run.status <> 'APPLIED' then
    raise exception using errcode = 'P0001', message = 'PROJECTION_RUN_NOT_ROLLBACKABLE';
  end if;

  delete from public.tracedee_profile_scores where score_version = v_run.score_version;
  delete from public.tracedee_expertise_scores where score_version = v_run.score_version;
  delete from public.tracedee_taste_affinities where score_version = v_run.score_version;
  delete from public.tracedee_content_quality_scores where score_version = v_run.score_version;

  insert into public.tracedee_profile_scores (profile_id, score_version, xp, expertise, reputation, confidence, components, calculated_at, updated_at)
  select profile_id, score_version, xp, expertise, reputation, confidence, components, calculated_at, updated_at
  from jsonb_to_recordset(v_run.previous_snapshot -> 'profile') as row_data(
    profile_id uuid, score_version integer, xp integer, expertise numeric, reputation numeric, confidence numeric, components jsonb, calculated_at timestamptz, updated_at timestamptz
  );

  insert into public.tracedee_expertise_scores (id, profile_id, topic, score_version, score, evidence_count, confidence, components, calculated_at)
  select id, profile_id, topic, score_version, score, evidence_count, confidence, components, calculated_at
  from jsonb_to_recordset(v_run.previous_snapshot -> 'expertise') as row_data(
    id uuid, profile_id uuid, topic text, score_version integer, score numeric, evidence_count integer, confidence numeric, components jsonb, calculated_at timestamptz
  );

  insert into public.tracedee_taste_affinities (id, profile_id, dimension_type, dimension_key, score_version, affinity, evidence_count, calculated_at)
  select id, profile_id, dimension_type, dimension_key, score_version, affinity, evidence_count, calculated_at
  from jsonb_to_recordset(v_run.previous_snapshot -> 'taste') as row_data(
    id uuid, profile_id uuid, dimension_type text, dimension_key text, score_version integer, affinity numeric, evidence_count integer, calculated_at timestamptz
  );

  insert into public.tracedee_content_quality_scores (id, entity_type, entity_id, score_version, score, confidence, components, calculated_at)
  select id, entity_type, entity_id, score_version, score, confidence, components, calculated_at
  from jsonb_to_recordset(v_run.previous_snapshot -> 'quality') as row_data(
    id uuid, entity_type text, entity_id uuid, score_version integer, score numeric, confidence numeric, components jsonb, calculated_at timestamptz
  );

  update public.tracedee_score_projection_runs
  set status = 'ROLLED_BACK', rollback_reason = v_reason, rolled_back_at = timezone('utc', now())
  where id = p_run_id;

  insert into public.tracedee_activity_events (event_type, actor_id, source, session_id, entity_type, entity_id, metadata, tracking_token, correlation_id, dedupe_key)
  values (
    'score_projection_rolled_back',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-admin'),
    p_session_id,
    'SCORE_PROJECTION_RUN',
    p_run_id,
    jsonb_build_object('runId', p_run_id, 'reason', v_reason, 'scoreVersion', v_run.score_version),
    v_tracking_token,
    v_correlation_id,
    'score-projection-rolled-back:' || p_run_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true,
    'runId', p_run_id,
    'scoreVersion', v_run.score_version,
    'status', 'ROLLED_BACK',
    'changed', true,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_rollback_projection(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_rollback_projection(uuid, uuid, text, text, text, text, text) to service_role;
