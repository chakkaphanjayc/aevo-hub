-- TraceDee Phase 5: explicit taste preferences, shadow ranking, and guarded
-- cohort rollout. Personalized ranking is never enabled by an implicit client
-- assumption; the feature flag and the user's preference both participate.

create table if not exists public.tracedee_profile_preferences (
  profile_id uuid primary key references auth.users(id) on delete cascade,
  personalization_enabled boolean not null default true,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_profile_interests (
  profile_id uuid not null references auth.users(id) on delete cascade,
  dimension_type text not null check (dimension_type in ('TOPIC', 'AREA', 'CATEGORY')),
  dimension_key text not null check (length(trim(dimension_key)) between 1 and 120),
  position smallint not null default 0 check (position between 0 and 4),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (profile_id, dimension_type, dimension_key)
);

create index if not exists tracedee_profile_interests_lookup_idx
  on public.tracedee_profile_interests (profile_id, dimension_type, position);

create table if not exists public.tracedee_ranking_evaluations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references auth.users(id) on delete set null,
  session_id text,
  model_version text not null check (length(trim(model_version)) between 1 and 120),
  ranking_mode text not null check (ranking_mode in ('DETERMINISTIC', 'SHADOW', 'PERSONALIZED')),
  deterministic_item_ids jsonb not null default '[]'::jsonb,
  shadow_item_ids jsonb not null default '[]'::jsonb,
  served_item_ids jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists tracedee_ranking_evaluations_created_idx
  on public.tracedee_ranking_evaluations (created_at desc, ranking_mode);
create index if not exists tracedee_ranking_evaluations_profile_idx
  on public.tracedee_ranking_evaluations (profile_id, created_at desc);

alter table public.tracedee_profile_preferences enable row level security;
alter table public.tracedee_profile_interests enable row level security;
alter table public.tracedee_ranking_evaluations enable row level security;
revoke all on table public.tracedee_profile_preferences, public.tracedee_profile_interests, public.tracedee_ranking_evaluations from public, anon, authenticated;
grant select, insert, update, delete on table public.tracedee_profile_preferences to service_role;
grant select, insert, update, delete on table public.tracedee_profile_interests to service_role;
grant select, insert, update, delete on table public.tracedee_ranking_evaluations to service_role;

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

create or replace function public.tracedee_flag_cohort_enabled(
  p_flag_key text,
  p_actor_id uuid default null
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce((
    select
      f.enabled
      and p_actor_id is not null
      and coalesce(f.config ->> 'killSwitch', 'false') <> 'true'
      and mod(abs(hashtextextended(f.flag_key || ':' || p_actor_id::text, 0)), 100) < f.rollout_percent
    from public.tracedee_feature_flags f
    where f.flag_key = p_flag_key
    limit 1
  ), false);
$$;

revoke all on function public.tracedee_flag_cohort_enabled(text, uuid) from public, anon, authenticated;
grant execute on function public.tracedee_flag_cohort_enabled(text, uuid) to service_role;

create or replace function public.tracedee_get_profile_preferences(
  p_actor_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'ok', true,
    'profileId', p_actor_id,
    'personalizationEnabled', coalesce(p.personalization_enabled, true),
    'onboardingCompleted', coalesce(p.onboarding_completed, false),
    'interests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dimensionType', i.dimension_type,
        'dimensionKey', i.dimension_key,
        'position', i.position
      ) order by i.position, i.dimension_type, i.dimension_key)
      from public.tracedee_profile_interests i
      where i.profile_id = p_actor_id
    ), '[]'::jsonb)
  )
  from (select 1) as anchor
  left join public.tracedee_profile_preferences p on p.profile_id = p_actor_id;
$$;

revoke all on function public.tracedee_get_profile_preferences(uuid) from public, anon, authenticated;
grant execute on function public.tracedee_get_profile_preferences(uuid) to service_role;

create or replace function public.tracedee_update_profile_preferences(
  p_actor_id uuid,
  p_personalization_enabled boolean,
  p_interests jsonb,
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
  v_previous_enabled boolean;
  v_item jsonb;
  v_dimension_type text;
  v_dimension_key text;
  v_interests jsonb := coalesce(p_interests, '[]'::jsonb);
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_event_type text;
  v_response jsonb;
  v_scope text := 'tracedee:preferences:' || p_actor_id::text;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if jsonb_typeof(v_interests) <> 'array' or jsonb_array_length(v_interests) > 5 then
    raise exception using errcode = 'P0001', message = 'PREFERENCES_INPUT_INVALID';
  end if;
  if jsonb_array_length(v_interests) between 1 and 2 then
    raise exception using errcode = 'P0001', message = 'PREFERENCES_NEED_THREE_INTERESTS';
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

  select personalization_enabled into v_previous_enabled
  from public.tracedee_profile_preferences
  where profile_id = p_actor_id;

  for v_item in select value from jsonb_array_elements(v_interests) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = 'P0001', message = 'PREFERENCES_INPUT_INVALID';
    end if;
    v_dimension_type := upper(trim(coalesce(v_item ->> 'dimensionType', '')));
    v_dimension_key := lower(trim(coalesce(v_item ->> 'dimensionKey', '')));
    if v_dimension_type not in ('TOPIC', 'AREA', 'CATEGORY') or length(v_dimension_key) < 1 or length(v_dimension_key) > 120 then
      raise exception using errcode = 'P0001', message = 'PREFERENCES_INPUT_INVALID';
    end if;
  end loop;

  insert into public.tracedee_profile_preferences (profile_id, personalization_enabled, onboarding_completed, updated_at)
  values (p_actor_id, coalesce(p_personalization_enabled, true), jsonb_array_length(v_interests) >= 3, timezone('utc', now()))
  on conflict (profile_id) do update set
    personalization_enabled = excluded.personalization_enabled,
    onboarding_completed = excluded.onboarding_completed,
    updated_at = excluded.updated_at;

  delete from public.tracedee_profile_interests where profile_id = p_actor_id;
  insert into public.tracedee_profile_interests (profile_id, dimension_type, dimension_key, position)
  select p_actor_id,
    upper(trim(value ->> 'dimensionType')),
    lower(trim(value ->> 'dimensionKey')),
    (elements.ordinality - 1)::smallint
  from jsonb_array_elements(v_interests) with ordinality as elements(value)
  on conflict (profile_id, dimension_type, dimension_key) do update set position = excluded.position;

  v_event_type := case when v_previous_enabled is distinct from coalesce(p_personalization_enabled, true) then 'personalization_toggled' else 'taste_preferences_updated' end;
  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  )
  values (
    v_event_type, p_actor_id, coalesce(nullif(trim(p_source), ''), 'aevo-go'), p_session_id,
    'PROFILE', p_actor_id,
    jsonb_build_object('personalizationEnabled', coalesce(p_personalization_enabled, true), 'interests', v_interests),
    v_tracking_token, v_correlation_id,
    'tracedee-preferences:' || p_actor_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true,
    'profileId', p_actor_id,
    'personalizationEnabled', coalesce(p_personalization_enabled, true),
    'onboardingCompleted', jsonb_array_length(v_interests) >= 3,
    'interests', v_interests,
    'changed', true,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_update_profile_preferences(uuid, boolean, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_update_profile_preferences(uuid, boolean, jsonb, text, text, text, text) to service_role;

create or replace function public.tracedee_record_feed_interaction(
  p_actor_id uuid,
  p_item_type text,
  p_item_id uuid,
  p_interaction_type text,
  p_tracking_token uuid default null,
  p_metadata jsonb default '{}'::jsonb,
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
  v_existing record;
  v_idempotency_id uuid;
  v_interaction text := upper(trim(coalesce(p_interaction_type, '')));
  v_event_type text;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_token uuid := coalesce(p_tracking_token, gen_random_uuid());
  v_response jsonb;
  v_scope text := 'tracedee:feed-interaction:' || p_item_type || ':' || p_item_id::text;
begin
  if p_actor_id is null or upper(trim(coalesce(p_item_type, ''))) <> 'TRACE' or p_item_id is null then
    raise exception using errcode = 'P0001', message = 'FEED_INTERACTION_INPUT_INVALID';
  end if;
  if v_interaction not in ('OPENED', 'DISMISSED', 'QUICK_BACK') then
    raise exception using errcode = 'P0001', message = 'FEED_INTERACTION_UNSUPPORTED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(coalesce(p_idempotency_key, ''))) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(coalesce(p_request_hash, ''))) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;
  if not exists (
    select 1 from public.tracedee_traces t
    where t.id = p_item_id and t.status = 'PUBLISHED' and t.visibility = 'PUBLIC' and t.moderation_status in ('VISIBLE', 'LIMITED')
  ) then
    raise exception using errcode = 'P0001', message = 'FEED_ITEM_NOT_FOUND';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, v_scope, trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;
  if v_idempotency_id is null then
    select request_hash, response_body into v_existing from public.tracedee_idempotency_keys
    where actor_id = p_actor_id and scope = v_scope and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT'; end if;
    if v_existing.response_body is null then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_existing.response_body;
  end if;

  insert into public.tracedee_feed_interactions (actor_id, item_type, item_id, interaction_type, tracking_token, metadata)
  values (p_actor_id, 'TRACE', p_item_id, v_interaction, v_token, coalesce(p_metadata, '{}'::jsonb));

  v_event_type := case v_interaction when 'OPENED' then 'feed_item_opened' when 'DISMISSED' then 'feed_item_dismissed' else 'feed_item_quick_back' end;
  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  ) values (
    v_event_type, p_actor_id, coalesce(nullif(trim(p_source), ''), 'aevo-go'), p_session_id,
    'TRACE', p_item_id, jsonb_build_object('interactionType', v_interaction) || coalesce(p_metadata, '{}'::jsonb),
    v_token, v_correlation_id, 'feed-interaction:' || p_actor_id::text || ':' || v_interaction || ':' || p_item_id::text || ':' || trim(p_idempotency_key)
  ) returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object('ok', true, 'itemType', 'TRACE', 'itemId', p_item_id, 'interactionType', v_interaction, 'changed', true, 'eventId', v_event_id, 'correlationId', v_correlation_id, 'trackingToken', v_token);
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_record_feed_interaction(uuid, text, uuid, text, uuid, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_record_feed_interaction(uuid, text, uuid, text, uuid, jsonb, text, text, text, text) to service_role;

create or replace function public.tracedee_record_ranking_evaluation(
  p_actor_id uuid,
  p_session_id text,
  p_model_version text,
  p_ranking_mode text,
  p_deterministic_item_ids jsonb,
  p_shadow_item_ids jsonb,
  p_served_item_ids jsonb,
  p_context jsonb default '{}'::jsonb,
  p_metrics jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if upper(trim(coalesce(p_ranking_mode, ''))) not in ('DETERMINISTIC', 'SHADOW', 'PERSONALIZED') then
    raise exception using errcode = 'P0001', message = 'RANKING_EVALUATION_MODE_INVALID';
  end if;
  if jsonb_typeof(coalesce(p_deterministic_item_ids, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_shadow_item_ids, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_served_item_ids, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'P0001', message = 'RANKING_EVALUATION_INPUT_INVALID';
  end if;
  insert into public.tracedee_recommendation_snapshots (profile_id, model_version, context, item_ids, expires_at)
  values (p_actor_id, coalesce(nullif(trim(p_model_version), ''), 'tracedee-deterministic-v1'), coalesce(p_context, '{}'::jsonb), coalesce(p_served_item_ids, '[]'::jsonb), timezone('utc', now()) + interval '7 days')
  returning id into v_id;
  insert into public.tracedee_ranking_evaluations (id, profile_id, session_id, model_version, ranking_mode, deterministic_item_ids, shadow_item_ids, served_item_ids, context, metrics)
  values (v_id, p_actor_id, p_session_id, coalesce(nullif(trim(p_model_version), ''), 'tracedee-deterministic-v1'), upper(trim(p_ranking_mode)), coalesce(p_deterministic_item_ids, '[]'::jsonb), coalesce(p_shadow_item_ids, '[]'::jsonb), coalesce(p_served_item_ids, '[]'::jsonb), coalesce(p_context, '{}'::jsonb), coalesce(p_metrics, '{}'::jsonb));
  return jsonb_build_object('ok', true, 'evaluationId', v_id);
end;
$$;

revoke all on function public.tracedee_record_ranking_evaluation(uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.tracedee_record_ranking_evaluation(uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

create or replace function public.tracedee_ranking_guardrail_report(
  p_since timestamptz default timezone('utc', now()) - interval '7 days',
  p_until timestamptz default timezone('utc', now())
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with evaluations as (
    select * from public.tracedee_ranking_evaluations
    where created_at >= coalesce(p_since, timezone('utc', now()) - interval '7 days')
      and created_at < coalesce(p_until, timezone('utc', now()))
  ),
  interaction_counts as (
    select
      count(*) filter (where interaction_type = 'OPENED')::integer as opened_count,
      count(*) filter (where interaction_type = 'DISMISSED')::integer as dismissed_count,
      count(*) filter (where interaction_type = 'QUICK_BACK')::integer as quick_back_count,
      avg(nullif((metadata ->> 'latencyMs')::numeric, 0)) as average_latency_ms
    from public.tracedee_feed_interactions
    where occurred_at >= coalesce(p_since, timezone('utc', now()) - interval '7 days')
      and occurred_at < coalesce(p_until, timezone('utc', now()))
  ),
  served_items as (
    select jsonb_array_elements_text(e.served_item_ids)::uuid as item_id
    from evaluations e
  ),
  creator_counts as (
    select t.creator_id, count(*)::numeric as item_count
    from served_items s join public.tracedee_traces t on t.id = s.item_id
    group by t.creator_id
  ),
  category_counts as (
    select distinct lower(trim(tag.value)) as category
    from served_items s
    join public.tracedee_traces t on t.id = s.item_id
    cross join lateral unnest(t.topic_tags) as tag(value)
    where length(trim(tag.value)) > 0
  ),
  totals as (
    select count(*)::numeric as served_count from served_items
  )
  select jsonb_build_object(
    'since', coalesce(p_since, timezone('utc', now()) - interval '7 days'),
    'until', coalesce(p_until, timezone('utc', now())),
    'evaluationCount', (select count(*) from evaluations),
    'personalizedEvaluationCount', (select count(*) from evaluations where ranking_mode = 'PERSONALIZED'),
    'shadowEvaluationCount', (select count(*) from evaluations where ranking_mode = 'SHADOW'),
    'servedItemCount', (select served_count from totals),
    'creatorConcentration', coalesce((select max(item_count) / nullif((select served_count from totals), 0) from creator_counts), 0),
    'categoryDiversity', coalesce((select count(*) from category_counts), 0),
    'hideRate', coalesce((select dismissed_count::numeric / nullif(opened_count, 0) from interaction_counts), 0),
    'quickBackRate', coalesce((select quick_back_count::numeric / nullif(opened_count, 0) from interaction_counts), 0),
    'averageLatencyMs', coalesce((select average_latency_ms from interaction_counts), 0),
    'guardrails', jsonb_build_object(
      'creatorConcentrationPass', coalesce((select max(item_count) / nullif((select served_count from totals), 0) from creator_counts), 0) <= 0.35,
      'categoryDiversityPass', coalesce((select count(*) from category_counts), 0) >= 3,
      'hideRatePass', coalesce((select dismissed_count::numeric / nullif(opened_count, 0) from interaction_counts), 0) <= 0.15,
      'quickBackRatePass', coalesce((select quick_back_count::numeric / nullif(opened_count, 0) from interaction_counts), 0) <= 0.35,
      'latencyPass', coalesce((select average_latency_ms from interaction_counts), 0) <= 300
    )
  );
$$;

revoke all on function public.tracedee_ranking_guardrail_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.tracedee_ranking_guardrail_report(timestamptz, timestamptz) to service_role;

-- Enter measurable shadow mode first. No personalized ordering is served by
-- this setting; a later audited flag change can move mode to LIVE at 5%.
update public.tracedee_feature_flags
set enabled = true,
    rollout_percent = 100,
    config = jsonb_build_object(
      'version', 2,
      'mode', 'SHADOW',
      'modelVersion', 'tracedee-taste-v1',
      'guardrails', jsonb_build_object('maxCreatorConcentration', 0.35, 'maxHideRate', 0.15, 'maxQuickBackRate', 0.35, 'maxLatencyMs', 300),
      'explorationQuota', 0.2,
      'killSwitch', false
    ),
    updated_at = timezone('utc', now())
where flag_key = 'taste_ranking_v1';

-- The final feed definition below keeps deterministic ordering as the fallback,
-- uses explicit cohort assignment for LIVE mode, and exposes explainable
-- scoring inputs in reason_params without leaking a taste percentage.
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
    select
      coalesce(f.enabled, false) as enabled,
      coalesce(f.rollout_percent, 0) as rollout_percent,
      coalesce(f.config, '{}'::jsonb) as config,
      case when public.tracedee_flag_cohort_enabled('taste_ranking_v1', p_actor_id) then true else false end as cohort_eligible
    from (select 1) as anchor
    left join public.tracedee_feature_flags f on f.flag_key = 'taste_ranking_v1'
  ),
  preferences as (
    select
      coalesce(p.personalization_enabled, true) as personalization_enabled,
      coalesce(array_agg(i.dimension_type || ':' || i.dimension_key order by i.position), '{}'::text[]) as interest_keys,
      coalesce(array_agg(i.dimension_key) filter (where i.dimension_type = 'TOPIC'), '{}'::text[]) as topic_interests,
      coalesce(array_agg(i.dimension_key) filter (where i.dimension_type = 'AREA'), '{}'::text[]) as area_interests
    from (select p_actor_id as profile_id) anchor
    left join public.tracedee_profile_preferences p on p.profile_id = anchor.profile_id
    left join public.tracedee_profile_interests i on i.profile_id = anchor.profile_id
    group by p.personalization_enabled
  ),
  context as (
    select
      coalesce(preferences.personalization_enabled, true) as personalization_enabled,
      coalesce(preferences.interest_keys, '{}'::text[]) as interest_keys,
      coalesce(preferences.topic_interests, '{}'::text[]) as topic_interests,
      coalesce(preferences.area_interests, '{}'::text[]) as area_interests,
      flag.enabled,
      flag.config,
      flag.cohort_eligible,
      case
        when flag.enabled and flag.config ->> 'mode' = 'LIVE' and flag.cohort_eligible and coalesce(preferences.personalization_enabled, true) then 'PERSONALIZED'
        when flag.enabled and flag.config ->> 'mode' = 'SHADOW' and flag.cohort_eligible and coalesce(preferences.personalization_enabled, true) then 'SHADOW'
        else 'DETERMINISTIC'
      end as ranking_mode
    from flag cross join preferences
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
      coalesce((select q.score from public.tracedee_content_quality_scores q where q.entity_type = 'TRACE' and q.entity_id = t.id order by q.score_version desc limit 1), 0)::numeric as quality_score,
      coalesce((select q.confidence from public.tracedee_content_quality_scores q where q.entity_type = 'TRACE' and q.entity_id = t.id order by q.score_version desc limit 1), 0)::numeric as quality_confidence,
      coalesce((select count(*) from public.tracedee_content_reports r where r.entity_type = 'TRACE' and r.entity_id = t.id and r.status in ('OPEN', 'REVIEWING')), 0)::numeric as open_report_count,
      coalesce((select count(*) from public.tracedee_feed_interactions fi where fi.actor_id = p_actor_id and fi.item_type = 'TRACE' and fi.item_id = t.id and fi.occurred_at >= timezone('utc', now()) - interval '30 days' and fi.interaction_type = 'OPENED'), 0)::numeric as opened_count,
      coalesce((select count(*) from public.tracedee_feed_interactions fi where fi.actor_id = p_actor_id and fi.item_type = 'TRACE' and fi.item_id = t.id and fi.occurred_at >= timezone('utc', now()) - interval '30 days' and fi.interaction_type = 'DISMISSED'), 0)::numeric as dismissed_count,
      coalesce((select count(*) from public.tracedee_feed_interactions fi where fi.actor_id = p_actor_id and fi.item_type = 'TRACE' and fi.item_id = t.id and fi.occurred_at >= timezone('utc', now()) - interval '30 days' and fi.interaction_type = 'QUICK_BACK'), 0)::numeric as quick_back_count,
      coalesce((select sum(ta.affinity) from public.tracedee_taste_affinities ta where ta.profile_id = p_actor_id and ((ta.dimension_type = 'TOPIC' and exists (select 1 from unnest(t.topic_tags) as tag(value) where ta.dimension_key = lower(trim(tag.value)))) or (ta.dimension_type = 'AREA' and ta.dimension_key = lower(trim(t.area))))), 0)::numeric
        + coalesce((select count(*) * 4 from public.tracedee_profile_interests pi where pi.profile_id = p_actor_id and ((pi.dimension_type = 'TOPIC' and exists (select 1 from unnest(t.topic_tags) as tag(value) where pi.dimension_key = lower(trim(tag.value)))) or (pi.dimension_type = 'AREA' and pi.dimension_key = lower(trim(t.area))))), 0)::numeric as taste_score,
      coalesce((select array_agg(distinct lower(trim(tag.value))) from unnest(t.topic_tags) as tag(value) where exists (select 1 from public.tracedee_taste_affinities ta where ta.profile_id = p_actor_id and ta.dimension_type = 'TOPIC' and ta.dimension_key = lower(trim(tag.value)))), '{}'::text[]) as matched_topics,
      case when p_actor_id is not null and exists (select 1 from public.tracedee_profile_interests pi where pi.profile_id = p_actor_id and pi.dimension_type = 'AREA' and pi.dimension_key = lower(trim(t.area))) then array[lower(trim(t.area))]::text[] else '{}'::text[] end as matched_areas,
      (p_actor_id is not null and exists (select 1 from public.tracedee_tracer_follows tf where tf.follower_id = p_actor_id and tf.tracer_id = t.creator_id)) as follows_tracer,
      greatest(0, 30 - extract(epoch from (timezone('utc', now()) - coalesce(t.published_at, t.created_at))) / 86400)::numeric as freshness_score,
      coalesce(t.published_at, t.created_at) as effective_published_at,
      context.*
    from public.tracedee_traces t
    cross join context
    left join public.user_profiles up on up.id = t.creator_id
    where t.status = 'PUBLISHED'
      and t.visibility = 'PUBLIC'
      and t.moderation_status in ('VISIBLE', 'LIMITED')
      and (p_query is null or lower(concat_ws(' ', t.title, t.description, t.area, array_to_string(t.topic_tags, ' '))) like '%' || lower(trim(p_query)) || '%')
      and (p_area is null or lower(t.area) = lower(trim(p_area)))
      and (p_tab <> 'following' or (p_actor_id is not null and exists (select 1 from public.tracedee_tracer_follows tf where tf.follower_id = p_actor_id and tf.tracer_id = t.creator_id)))
  ),
  scored as (
    select
      b.*,
      round((b.quality_score + b.save_count * 10 + b.follower_count * 5)::numeric, 4) as deterministic_score,
      round((b.quality_score + b.save_count * 10 + b.follower_count * 5
        + case when b.follows_tracer then 50 else 0 end
        + least(240, greatest(0, b.taste_score) * 6)
        + case when p_area is not null and lower(b.area) = lower(trim(p_area)) then 20 else 0 end
        + b.freshness_score
        + case when cardinality(b.matched_topics) = 0 and cardinality(b.matched_areas) = 0 then 8 else 0 end
        - b.opened_count * 3
        - b.dismissed_count * 50
        - b.quick_back_count * 20
        - b.open_report_count * 5
      )::numeric, 4) as personalized_score
    from base b
  ),
  served as (
    select
      s.*,
      case when s.ranking_mode = 'PERSONALIZED' then s.personalized_score else s.deterministic_score end as computed_score,
      case
        when s.ranking_mode = 'PERSONALIZED' and s.follows_tracer then 'FOLLOWING_TRACER'
        when s.ranking_mode = 'PERSONALIZED' and (cardinality(s.matched_topics) > 0 or cardinality(s.matched_areas) > 0) then 'TASTE_MATCH'
        when s.follower_count + s.save_count > 0 then 'POPULAR'
        else 'NEW_TRACE'
      end as computed_reason
    from scored s
  )
  select
    'TRACE'::text,
    s.id,
    s.slug,
    s.title,
    s.description,
    s.creator_id,
    s.creator_name,
    s.status,
    s.visibility,
    s.cover_place_id,
    s.area,
    s.topic_tags,
    s.stop_count,
    s.follower_count,
    s.save_count,
    s.computed_score,
    s.computed_reason,
    jsonb_build_object(
      'area', s.area,
      'stopCount', s.stop_count,
      'creatorId', s.creator_id,
      'tasteScore', case when s.ranking_mode = 'PERSONALIZED' or s.ranking_mode = 'SHADOW' then s.taste_score else 0 end,
      'matchedTopics', s.matched_topics,
      'matchedAreas', s.matched_areas,
      'rankingMode', s.ranking_mode,
      'personalizationEnabled', s.personalization_enabled,
      'cohortEligible', s.cohort_eligible,
      'deterministicScore', s.deterministic_score,
      'personalizedScore', s.personalized_score,
      'qualityConfidence', s.quality_confidence,
      'freshnessScore', s.freshness_score,
      'repetitionPenalty', s.opened_count * 3 + s.dismissed_count * 50 + s.quick_back_count * 20
    ),
    gen_random_uuid(),
    s.effective_published_at
  from served s
  where (
    p_after_id is null
    or s.computed_score < p_after_score
    or (s.computed_score = p_after_score and s.effective_published_at < p_after_published_at)
    or (s.computed_score = p_after_score and s.effective_published_at = p_after_published_at and s.id < p_after_id)
  )
  order by s.computed_score desc, s.effective_published_at desc, s.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 48);
$$;

revoke all on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) to service_role;
