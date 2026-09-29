-- TraceDee discovery profile projection lifecycle.
--
-- The canonical interaction/content tables remain authoritative. This
-- migration adds a service-role-only, profile-scoped rebuild/delete boundary
-- plus a small durable job record so a worker can replay or remove derived
-- discovery state without granting browser access to projection tables.

create table if not exists public.tracedee_profile_projection_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references auth.users(id) on delete set null,
  operation text not null check (operation in ('REBUILD', 'DELETE')),
  request_key text not null unique check (length(trim(request_key)) between 8 and 200),
  request_hash text not null check (length(trim(request_hash)) between 8 and 200),
  reason text not null check (length(trim(reason)) between 3 and 500),
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  attempts integer not null default 0 check (attempts >= 0),
  result jsonb not null default '{}'::jsonb,
  last_error text not null default '' check (length(last_error) <= 2000),
  next_attempt_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists tracedee_profile_projection_jobs_ready_idx
  on public.tracedee_profile_projection_jobs (status, next_attempt_at, created_at)
  where status in ('PENDING', 'PROCESSING');

create index if not exists tracedee_profile_projection_jobs_profile_idx
  on public.tracedee_profile_projection_jobs (profile_id, created_at desc);

alter table public.tracedee_profile_projection_jobs enable row level security;
revoke all on table public.tracedee_profile_projection_jobs from public, anon, authenticated;
grant select, insert, update on table public.tracedee_profile_projection_jobs to service_role;

create or replace function public.tracedee_rebuild_profile_projections(
  p_profile_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_score_version integer := 1;
  v_profile_count integer := 0;
  v_expertise_count integer := 0;
  v_taste_count integer := 0;
begin
  if p_profile_id is null or not exists (select 1 from auth.users where id = p_profile_id) then
    raise exception using errcode = 'P0001', message = 'PROFILE_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tracedee-profile-projection:' || p_profile_id::text, 0));

  delete from public.tracedee_profile_scores
  where profile_id = p_profile_id and score_version = v_score_version;
  delete from public.tracedee_expertise_scores
  where profile_id = p_profile_id and score_version = v_score_version;
  delete from public.tracedee_taste_affinities
  where profile_id = p_profile_id and score_version = v_score_version;

  insert into public.tracedee_profile_scores (
    profile_id,
    score_version,
    xp,
    expertise,
    reputation,
    confidence,
    components,
    calculated_at
  )
  with signals as (
    select
      (select count(*) from public.tracedee_journeys j where j.user_id = p_profile_id and j.status = 'COMPLETED')::integer as completed_count,
      (select count(*) from public.tracedee_trace_ratings r where r.user_id = p_profile_id and r.moderation_status in ('VISIBLE', 'LIMITED'))::integer as rating_count,
      (select count(*) from public.tracedee_posts p where p.author_id = p_profile_id and p.status in ('VISIBLE', 'LIMITED'))::integer as post_count,
      (select count(*) from public.tracedee_comments c where c.author_id = p_profile_id and c.status in ('VISIBLE', 'LIMITED'))::integer as comment_count,
      (select count(*) from public.tracedee_content_reports cr where cr.reporter_id = p_profile_id)::integer as report_count,
      (select count(*) from public.tracedee_content_reports cr where cr.entity_id in (
        select p.id from public.tracedee_posts p where p.author_id = p_profile_id
      ) and cr.status in ('OPEN', 'REVIEWING'))::integer as open_report_count
  )
  select
    p_profile_id,
    v_score_version,
    least(100000, completed_count * 100 + rating_count * 20 + post_count * 30 + comment_count * 5)::integer,
    least(1000, completed_count * 10 + rating_count * 3 + post_count * 5 + comment_count)::numeric,
    greatest(-100, (post_count * 2 + comment_count + completed_count - open_report_count * 5))::numeric,
    least(1, (completed_count + rating_count + post_count + comment_count)::numeric / 10),
    jsonb_build_object(
      'completedCount', completed_count,
      'ratingCount', rating_count,
      'postCount', post_count,
      'commentCount', comment_count,
      'reportCount', report_count,
      'openReportCount', open_report_count,
      'algorithm', 'tracedee-deterministic-v1'
    ),
    timezone('utc', now())
  from signals;
  get diagnostics v_profile_count = row_count;

  insert into public.tracedee_expertise_scores (
    profile_id,
    topic,
    score_version,
    score,
    evidence_count,
    confidence,
    components,
    calculated_at
  )
  with evidence as (
    select
      p_profile_id as profile_id,
      'topic:' || lower(trim(value)) as topic,
      4::numeric as weight
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where j.user_id = p_profile_id
      and j.status = 'COMPLETED'
      and length(trim(value)) > 0
    union all
    select
      p_profile_id,
      'topic:' || lower(trim(value)),
      greatest(0, r.rating - 2)::numeric
    from public.tracedee_trace_ratings r
    join public.tracedee_traces t on t.id = r.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where r.user_id = p_profile_id
      and r.moderation_status in ('VISIBLE', 'LIMITED')
      and length(trim(value)) > 0
    union all
    select
      p_profile_id,
      'area:' || lower(trim(t.area)),
      3::numeric
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    where j.user_id = p_profile_id
      and j.status = 'COMPLETED'
      and length(trim(t.area)) > 0
    union all
    select
      p_profile_id,
      'topic:' || lower(trim(value)),
      2::numeric
    from public.tracedee_posts p
    join public.tracedee_traces t on t.id = p.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where p.author_id = p_profile_id
      and p.status in ('VISIBLE', 'LIMITED')
      and length(trim(value)) > 0
  ),
  grouped as (
    select profile_id, topic, sum(weight) as score, count(*)::integer as evidence_count
    from evidence
    group by profile_id, topic
  )
  select
    profile_id,
    topic,
    v_score_version,
    score,
    evidence_count,
    least(1, evidence_count::numeric / 5),
    jsonb_build_object('algorithm', 'tracedee-deterministic-v1'),
    timezone('utc', now())
  from grouped;
  get diagnostics v_expertise_count = row_count;

  insert into public.tracedee_taste_affinities (
    profile_id,
    dimension_type,
    dimension_key,
    score_version,
    affinity,
    evidence_count,
    calculated_at
  )
  with evidence(profile_id, dimension_type, dimension_key, affinity_weight) as (
    select p_profile_id, 'TOPIC'::text, lower(trim(value)), 1::numeric
    from public.tracedee_trace_saves s
    join public.tracedee_traces t on t.id = s.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where s.user_id = p_profile_id and length(trim(value)) > 0
    union all
    select p_profile_id, 'TOPIC', lower(trim(value)), 2::numeric
    from public.tracedee_trace_follows f
    join public.tracedee_traces t on t.id = f.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where f.user_id = p_profile_id and length(trim(value)) > 0
    union all
    select p_profile_id, 'TOPIC', lower(trim(value)), 4::numeric
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where j.user_id = p_profile_id and j.status = 'COMPLETED' and length(trim(value)) > 0
    union all
    select p_profile_id, 'TOPIC', lower(trim(value)), greatest(-2, r.rating - 3)::numeric
    from public.tracedee_trace_ratings r
    join public.tracedee_traces t on t.id = r.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where r.user_id = p_profile_id and r.moderation_status in ('VISIBLE', 'LIMITED') and length(trim(value)) > 0
    union all
    select p_profile_id, 'AREA', lower(trim(t.area)), 1::numeric
    from public.tracedee_trace_saves s
    join public.tracedee_traces t on t.id = s.trace_id
    where s.user_id = p_profile_id and length(trim(t.area)) > 0
    union all
    select p_profile_id, 'AREA', lower(trim(t.area)), 4::numeric
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    where j.user_id = p_profile_id and j.status = 'COMPLETED' and length(trim(t.area)) > 0
  ),
  grouped as (
    select profile_id, dimension_type, dimension_key, sum(affinity_weight) as affinity, count(*)::integer as evidence_count
    from evidence
    group by profile_id, dimension_type, dimension_key
  )
  select profile_id, dimension_type, dimension_key, v_score_version, affinity, evidence_count, timezone('utc', now())
  from grouped;
  get diagnostics v_taste_count = row_count;

  return jsonb_build_object(
    'ok', true,
    'profileId', p_profile_id,
    'scoreVersion', v_score_version,
    'profileCount', v_profile_count,
    'expertiseCount', v_expertise_count,
    'tasteCount', v_taste_count,
    'calculatedAt', timezone('utc', now())
  );
end;
$$;

revoke all on function public.tracedee_rebuild_profile_projections(uuid) from public, anon, authenticated;
grant execute on function public.tracedee_rebuild_profile_projections(uuid) to service_role;

create or replace function public.tracedee_delete_profile_projection_state(
  p_profile_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_preferences integer := 0;
  v_interests integer := 0;
  v_profile_scores integer := 0;
  v_expertise integer := 0;
  v_taste integer := 0;
  v_reputation integer := 0;
  v_snapshots integer := 0;
  v_evaluations integer := 0;
  v_impressions integer := 0;
  v_interactions integer := 0;
begin
  if p_profile_id is null then
    raise exception using errcode = 'P0001', message = 'PROFILE_ID_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tracedee-profile-projection:' || p_profile_id::text, 0));

  delete from public.tracedee_profile_preferences where profile_id = p_profile_id;
  get diagnostics v_preferences = row_count;
  delete from public.tracedee_profile_interests where profile_id = p_profile_id;
  get diagnostics v_interests = row_count;
  delete from public.tracedee_profile_scores where profile_id = p_profile_id;
  get diagnostics v_profile_scores = row_count;
  delete from public.tracedee_expertise_scores where profile_id = p_profile_id;
  get diagnostics v_expertise = row_count;
  delete from public.tracedee_taste_affinities where profile_id = p_profile_id;
  get diagnostics v_taste = row_count;
  delete from public.tracedee_reputation_evidence where profile_id = p_profile_id;
  get diagnostics v_reputation = row_count;
  delete from public.tracedee_recommendation_snapshots where profile_id = p_profile_id;
  get diagnostics v_snapshots = row_count;
  delete from public.tracedee_ranking_evaluations where profile_id = p_profile_id;
  get diagnostics v_evaluations = row_count;
  delete from public.tracedee_feed_impressions where actor_id = p_profile_id;
  get diagnostics v_impressions = row_count;
  delete from public.tracedee_feed_interactions where actor_id = p_profile_id;
  get diagnostics v_interactions = row_count;

  return jsonb_build_object(
    'ok', true,
    'profileId', p_profile_id,
    'deleted', jsonb_build_object(
      'preferences', v_preferences,
      'interests', v_interests,
      'profileScores', v_profile_scores,
      'expertise', v_expertise,
      'taste', v_taste,
      'reputation', v_reputation,
      'recommendationSnapshots', v_snapshots,
      'rankingEvaluations', v_evaluations,
      'feedImpressions', v_impressions,
      'feedInteractions', v_interactions
    )
  );
end;
$$;

revoke all on function public.tracedee_delete_profile_projection_state(uuid) from public, anon, authenticated;
grant execute on function public.tracedee_delete_profile_projection_state(uuid) to service_role;

create or replace function public.tracedee_enqueue_profile_projection_job(
  p_profile_id uuid,
  p_operation text,
  p_reason text,
  p_request_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_operation text := upper(trim(coalesce(p_operation, '')));
  v_request_key text := trim(coalesce(p_request_key, ''));
  v_request_hash text := trim(coalesce(p_request_hash, ''));
  v_reason text := trim(coalesce(p_reason, ''));
  v_existing record;
  v_job public.tracedee_profile_projection_jobs%rowtype;
begin
  if p_profile_id is null or not exists (select 1 from auth.users where id = p_profile_id) then
    raise exception using errcode = 'P0001', message = 'PROFILE_NOT_FOUND';
  end if;
  if v_operation not in ('REBUILD', 'DELETE') then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_OPERATION_INVALID';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_REASON_INVALID';
  end if;
  if length(v_request_key) < 8 or length(v_request_key) > 200 then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_REQUEST_KEY_INVALID';
  end if;
  if length(v_request_hash) < 8 or length(v_request_hash) > 200 then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_REQUEST_HASH_INVALID';
  end if;

  select * into v_existing
  from public.tracedee_profile_projection_jobs
  where request_key = v_request_key
  for update;
  if v_existing.id is not null then
    if v_existing.request_hash <> v_request_hash then
      raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('ok', true, 'jobId', v_existing.id, 'status', v_existing.status, 'deduped', true);
  end if;

  insert into public.tracedee_profile_projection_jobs (
    profile_id, operation, request_key, request_hash, reason
  )
  values (p_profile_id, v_operation, v_request_key, v_request_hash, v_reason)
  returning * into v_job;

  return jsonb_build_object(
    'ok', true,
    'jobId', v_job.id,
    'profileId', v_job.profile_id,
    'operation', v_job.operation,
    'status', v_job.status,
    'deduped', false
  );
end;
$$;

revoke all on function public.tracedee_enqueue_profile_projection_job(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_enqueue_profile_projection_job(uuid, text, text, text, text) to service_role;

create or replace function public.tracedee_process_profile_projection_job(
  p_job_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.tracedee_profile_projection_jobs%rowtype;
  v_result jsonb;
  v_error text;
  v_attempt integer;
  v_status text;
begin
  if p_job_id is null then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_JOB_ID_REQUIRED';
  end if;

  select * into v_job
  from public.tracedee_profile_projection_jobs
  where id = p_job_id
  for update;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_JOB_NOT_FOUND';
  end if;
  if v_job.status in ('COMPLETED', 'CANCELLED') then
    return jsonb_build_object('ok', true, 'jobId', v_job.id, 'status', v_job.status, 'result', v_job.result, 'deduped', true);
  end if;
  if v_job.status = 'PROCESSING' and coalesce(v_job.started_at, v_job.updated_at) > timezone('utc', now()) - interval '10 minutes' then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_JOB_IN_PROGRESS';
  end if;
  if v_job.status = 'PENDING' and v_job.next_attempt_at > timezone('utc', now()) then
    raise exception using errcode = 'P0001', message = 'PROFILE_PROJECTION_JOB_NOT_READY';
  end if;
  if v_job.profile_id is null then
    update public.tracedee_profile_projection_jobs
    set status = 'CANCELLED', last_error = 'PROFILE_DELETED_BEFORE_PROCESSING', completed_at = timezone('utc', now()), updated_at = timezone('utc', now())
    where id = v_job.id;
    return jsonb_build_object('ok', true, 'jobId', v_job.id, 'status', 'CANCELLED', 'deduped', false);
  end if;

  v_attempt := v_job.attempts + 1;
  update public.tracedee_profile_projection_jobs
  set status = 'PROCESSING', attempts = v_attempt, started_at = timezone('utc', now()), updated_at = timezone('utc', now()), last_error = ''
  where id = v_job.id;

  begin
    if v_job.operation = 'REBUILD' then
      v_result := public.tracedee_rebuild_profile_projections(v_job.profile_id);
    else
      v_result := public.tracedee_delete_profile_projection_state(v_job.profile_id);
    end if;

    update public.tracedee_profile_projection_jobs
    set status = 'COMPLETED', result = v_result, last_error = '', completed_at = timezone('utc', now()), updated_at = timezone('utc', now())
    where id = v_job.id;
    return jsonb_build_object('ok', true, 'jobId', v_job.id, 'operation', v_job.operation, 'status', 'COMPLETED', 'result', v_result, 'deduped', false);
  exception when others then
    get stacked diagnostics v_error = message_text;
    v_status := case when v_attempt >= 3 then 'FAILED' else 'PENDING' end;
    update public.tracedee_profile_projection_jobs
    set status = v_status,
        last_error = left(coalesce(v_error, 'PROFILE_PROJECTION_JOB_FAILED'), 2000),
        next_attempt_at = timezone('utc', now()) + case when v_status = 'PENDING' then interval '1 minute' else interval '0 minutes' end,
        updated_at = timezone('utc', now())
    where id = v_job.id;
    return jsonb_build_object('ok', false, 'jobId', v_job.id, 'operation', v_job.operation, 'status', v_status, 'attempts', v_attempt, 'retryable', v_status = 'PENDING', 'error', left(coalesce(v_error, 'PROFILE_PROJECTION_JOB_FAILED'), 2000));
  end;
end;
$$;

revoke all on function public.tracedee_process_profile_projection_job(uuid) from public, anon, authenticated;
grant execute on function public.tracedee_process_profile_projection_job(uuid) to service_role;
