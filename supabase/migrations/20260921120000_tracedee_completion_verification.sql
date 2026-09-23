-- TraceDee Phase 3: privacy-preserving completion verification.
-- Completion remains user-owned and non-invasive. The server stores only
-- verification outcomes and anomaly flags; it never persists raw coordinates.

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

create index if not exists tracedee_completions_verification_idx
  on public.tracedee_completions (verification_status, completed_at desc);

create or replace function public.tracedee_complete_journey(
  p_actor_id uuid,
  p_journey_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_client_started_at timestamptz default null,
  p_client_completed_at timestamptz default null,
  p_location_permission boolean default false,
  p_coarse_latitude numeric default null,
  p_coarse_longitude numeric default null,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_completion_id uuid;
  v_journey record;
  v_event_id uuid;
  v_tracking_token uuid := gen_random_uuid();
  v_correlation_id uuid := gen_random_uuid();
  v_server_duration_minutes numeric;
  v_client_duration_minutes numeric;
  v_nearby_stop_count integer := 0;
  v_recent_completion_count integer := 0;
  v_flags jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_status text := 'SELF_REPORTED';
  v_time_consistency text := 'NOT_PROVIDED';
  v_proximity_result text := 'NOT_GRANTED';
  v_evidence_provided boolean := false;
  v_has_completed_stops boolean := false;
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
  if (p_client_started_at is null) <> (p_client_completed_at is null) then
    raise exception using errcode = 'P0001', message = 'COMPLETION_VERIFICATION_INPUT_INVALID';
  end if;
  if (p_coarse_latitude is null) <> (p_coarse_longitude is null)
     or p_coarse_latitude < -90 or p_coarse_latitude > 90
     or p_coarse_longitude < -180 or p_coarse_longitude > 180 then
    raise exception using errcode = 'P0001', message = 'COMPLETION_VERIFICATION_INPUT_INVALID';
  end if;
  if not coalesce(p_location_permission, false)
     and (p_coarse_latitude is not null or p_coarse_longitude is not null) then
    raise exception using errcode = 'P0001', message = 'COMPLETION_VERIFICATION_INPUT_INVALID';
  end if;

  v_result := public.tracedee_journey_action(
    p_actor_id,
    p_journey_id,
    'COMPLETE',
    p_idempotency_key,
    p_request_hash,
    null,
    null,
    null,
    p_source,
    p_session_id
  );
  v_completion_id := nullif(v_result->>'completionId', '')::uuid;

  select
    j.id,
    j.user_id,
    j.trace_id,
    j.started_at,
    j.completed_at,
    t.estimated_minutes
  into v_journey
  from public.tracedee_journeys j
  join public.tracedee_traces t on t.id = j.trace_id
  where j.id = p_journey_id
    and j.user_id = p_actor_id;
  if not found or v_completion_id is null then
    raise exception using errcode = 'P0001', message = 'JOURNEY_NOT_FOUND';
  end if;

  select exists (
    select 1
    from public.tracedee_journey_stops
    where journey_id = p_journey_id and status = 'COMPLETED'
  ) into v_has_completed_stops;

  if v_journey.started_at is not null and v_journey.completed_at is not null then
    v_server_duration_minutes := round(extract(epoch from (v_journey.completed_at - v_journey.started_at)) / 60.0, 2);
  end if;

  if p_client_started_at is not null and p_client_completed_at is not null then
    v_evidence_provided := true;
    v_client_duration_minutes := round(extract(epoch from (p_client_completed_at - p_client_started_at)) / 60.0, 2);
    if p_client_completed_at < p_client_started_at
       or p_client_completed_at - p_client_started_at > interval '7 days'
       or (v_journey.started_at is not null and abs(extract(epoch from (p_client_started_at - v_journey.started_at))) > 21600)
       or (v_journey.completed_at is not null and abs(extract(epoch from (p_client_completed_at - v_journey.completed_at))) > 21600) then
      v_time_consistency := 'INCONSISTENT';
      v_flags := v_flags || jsonb_build_array('TIME_INCONSISTENT');
    else
      v_time_consistency := 'CONSISTENT';
    end if;
  end if;

  if v_has_completed_stops and (
    (v_server_duration_minutes is not null and v_server_duration_minutes < greatest(2, coalesce(v_journey.estimated_minutes, 10) * 0.20))
    or (v_client_duration_minutes is not null and v_client_duration_minutes < greatest(2, coalesce(v_journey.estimated_minutes, 10) * 0.20))
  ) then
    v_flags := v_flags || jsonb_build_array('COMPLETED_TOO_QUICKLY');
  end if;

  select count(*)
  into v_recent_completion_count
  from public.tracedee_completions c
  where c.user_id = p_actor_id
    and c.id <> v_completion_id
    and c.completed_at >= timezone('utc', now()) - interval '30 minutes';
  if v_recent_completion_count >= 3 then
    v_flags := v_flags || jsonb_build_array('REPEATED_COMPLETION');
  end if;

  if coalesce(p_location_permission, false) and p_coarse_latitude is not null and p_coarse_longitude is not null then
    v_evidence_provided := true;
    select count(*)
    into v_nearby_stop_count
    from public.tracedee_journey_stops js
    join public.tracedee_trace_stops ts on ts.id = js.trace_stop_id
    join public.tracedee_places p on p.id = ts.place_id
    where js.journey_id = p_journey_id
      and js.status = 'COMPLETED'
      and p.location is not null
      and st_dwithin(
        p.location,
        st_setsrid(st_makepoint(p_coarse_longitude, p_coarse_latitude), 4326)::public.geography,
        2500
      );
    if v_nearby_stop_count > 0 then
      v_proximity_result := 'MATCHED';
    else
      v_proximity_result := 'NO_MATCH';
      v_flags := v_flags || jsonb_build_array('COARSE_LOCATION_MISMATCH');
    end if;
  elsif coalesce(p_location_permission, false) then
    v_proximity_result := 'NOT_AVAILABLE';
  end if;

  if jsonb_array_length(v_flags) > 0 then
    v_status := 'PARTIAL';
  elsif v_evidence_provided then
    v_status := 'VERIFIED';
  end if;

  v_summary := jsonb_build_object(
    'verificationMode', case when v_evidence_provided then 'OPTIONAL_EVIDENCE' else 'SELF_REPORTED' end,
    'timeConsistency', v_time_consistency,
    'serverDurationMinutes', v_server_duration_minutes,
    'clientDurationMinutes', v_client_duration_minutes,
    'coarseProximity', jsonb_build_object(
      'permissionGranted', coalesce(p_location_permission, false),
      'result', v_proximity_result,
      'nearbyCompletedStopCount', v_nearby_stop_count,
      'radiusMeters', 2500
    ),
    'anomalyFlags', v_flags,
    'verifiedAt', timezone('utc', now())
  );

  update public.tracedee_completions
  set verification_status = v_status,
      verification_summary = v_summary
  where id = v_completion_id;

  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  )
  values (
    'trace_completion_verified',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-go'),
    p_session_id,
    'COMPLETION',
    v_completion_id,
    jsonb_build_object(
      'journeyId', p_journey_id,
      'traceId', v_journey.trace_id,
      'verificationStatus', v_status,
      'anomalyFlags', v_flags,
      'timeConsistency', v_time_consistency,
      'coarseProximityResult', v_proximity_result
    ),
    v_tracking_token,
    v_correlation_id,
    'completion-verification:' || v_completion_id::text || ':' || trim(p_idempotency_key)
  )
  on conflict (dedupe_key) do nothing
  returning id into v_event_id;

  if v_event_id is not null then
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);
  else
    select id into v_event_id
    from public.tracedee_activity_events
    where dedupe_key = 'completion-verification:' || v_completion_id::text || ':' || trim(p_idempotency_key);
  end if;

  v_result := v_result || jsonb_build_object(
    'verificationStatus', v_status,
    'verificationSummary', v_summary,
    'verificationEventId', v_event_id,
    'verificationTrackingToken', v_tracking_token
  );

  update public.tracedee_idempotency_keys
  set response_status = 200,
      response_body = v_result
  where actor_id = p_actor_id
    and scope = 'tracedee:journey:complete:' || p_journey_id::text || ':-'
    and key = trim(p_idempotency_key);

  return v_result;
end;
$$;

revoke all on function public.tracedee_complete_journey(uuid, uuid, text, text, timestamptz, timestamptz, boolean, numeric, numeric, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_complete_journey(uuid, uuid, text, text, timestamptz, timestamptz, boolean, numeric, numeric, text, text) to service_role;
