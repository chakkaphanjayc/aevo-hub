-- TraceDee Phase 4 foundation: deterministic, replayable scoring projections.
-- Source tables and append-only events remain authoritative. This rebuild is
-- intentionally idempotent so a worker can replay it after a failed run.

create or replace function public.tracedee_rebuild_projections()
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_profile_count integer := 0;
  v_expertise_count integer := 0;
  v_taste_count integer := 0;
  v_quality_count integer := 0;
  v_score_version integer := 1;
begin
  delete from public.tracedee_profile_scores where score_version = v_score_version;
  delete from public.tracedee_expertise_scores where score_version = v_score_version;
  delete from public.tracedee_taste_affinities where score_version = v_score_version;
  delete from public.tracedee_content_quality_scores where score_version = v_score_version;

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
  with actors as (
    select user_id as profile_id from public.tracedee_journeys where status = 'COMPLETED'
    union select user_id from public.tracedee_trace_ratings
    union select author_id from public.tracedee_posts
    union select author_id from public.tracedee_comments
    union select actor_id from public.tracedee_activity_events where actor_id is not null
  ),
  signals as (
    select
      a.profile_id,
      (select count(*) from public.tracedee_journeys j where j.user_id = a.profile_id and j.status = 'COMPLETED')::integer as completed_count,
      (select count(*) from public.tracedee_trace_ratings r where r.user_id = a.profile_id and r.moderation_status in ('VISIBLE', 'LIMITED'))::integer as rating_count,
      (select count(*) from public.tracedee_posts p where p.author_id = a.profile_id and p.status in ('VISIBLE', 'LIMITED'))::integer as post_count,
      (select count(*) from public.tracedee_comments c where c.author_id = a.profile_id and c.status in ('VISIBLE', 'LIMITED'))::integer as comment_count,
      (select count(*) from public.tracedee_content_reports cr where cr.reporter_id = a.profile_id)::integer as report_count,
      (select count(*) from public.tracedee_content_reports cr where cr.entity_id in (
        select p.id from public.tracedee_posts p where p.author_id = a.profile_id
      ) and cr.status in ('OPEN', 'REVIEWING'))::integer as open_report_count
    from actors a
  )
  select
    profile_id,
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
      j.user_id as profile_id,
      'topic:' || lower(trim(value)) as topic,
      4::numeric as weight,
      'completion'::text as evidence_type
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where j.status = 'COMPLETED'
      and length(trim(value)) > 0
    union all
    select
      r.user_id,
      'topic:' || lower(trim(value)),
      greatest(0, r.rating - 2)::numeric,
      'rating'
    from public.tracedee_trace_ratings r
    join public.tracedee_traces t on t.id = r.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where r.moderation_status in ('VISIBLE', 'LIMITED')
      and length(trim(value)) > 0
    union all
    select
      j.user_id,
      'area:' || lower(trim(t.area)),
      3::numeric,
      'completion_area'
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    where j.status = 'COMPLETED'
      and length(trim(t.area)) > 0
    union all
    select
      p.author_id,
      'topic:' || lower(trim(value)),
      2::numeric,
      'post'
    from public.tracedee_posts p
    join public.tracedee_traces t on t.id = p.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where p.status in ('VISIBLE', 'LIMITED')
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
  with evidence as (
    select s.user_id as profile_id, 'TOPIC'::text as dimension_type, lower(trim(value)) as dimension_key, 1::numeric as weight
    from public.tracedee_trace_saves s
    join public.tracedee_traces t on t.id = s.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where length(trim(value)) > 0
    union all
    select f.user_id, 'TOPIC', lower(trim(value)), 2::numeric
    from public.tracedee_trace_follows f
    join public.tracedee_traces t on t.id = f.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where length(trim(value)) > 0
    union all
    select j.user_id, 'TOPIC', lower(trim(value)), 4::numeric
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where j.status = 'COMPLETED'
      and length(trim(value)) > 0
    union all
    select r.user_id, 'TOPIC', lower(trim(value)), greatest(-2, r.rating - 3)::numeric
    from public.tracedee_trace_ratings r
    join public.tracedee_traces t on t.id = r.trace_id
    cross join lateral unnest(t.topic_tags) as topic(value)
    where r.moderation_status in ('VISIBLE', 'LIMITED')
      and length(trim(value)) > 0
    union all
    select s.user_id, 'AREA', lower(trim(t.area)), 1::numeric
    from public.tracedee_trace_saves s
    join public.tracedee_traces t on t.id = s.trace_id
    where length(trim(t.area)) > 0
    union all
    select j.user_id, 'AREA', lower(trim(t.area)), 4::numeric
    from public.tracedee_journeys j
    join public.tracedee_traces t on t.id = j.trace_id
    where j.status = 'COMPLETED'
      and length(trim(t.area)) > 0
  ),
  grouped as (
    select profile_id, dimension_type, dimension_key, sum(weight) as affinity, count(*)::integer as evidence_count
    from evidence
    group by profile_id, dimension_type, dimension_key
  )
  select profile_id, dimension_type, dimension_key, v_score_version, affinity, evidence_count, timezone('utc', now())
  from grouped;
  get diagnostics v_taste_count = row_count;

  insert into public.tracedee_content_quality_scores (
    entity_type,
    entity_id,
    score_version,
    score,
    confidence,
    components,
    calculated_at
  )
  with trace_signals as (
    select
      t.id as entity_id,
      (select count(*) from public.tracedee_trace_saves s where s.trace_id = t.id)::numeric as saves,
      (select count(*) from public.tracedee_trace_follows f where f.trace_id = t.id)::numeric as follows,
      (select count(*) from public.tracedee_journeys j where j.trace_id = t.id and j.status = 'COMPLETED')::numeric as completions,
      coalesce((select avg(r.rating)::numeric from public.tracedee_trace_ratings r where r.trace_id = t.id and r.moderation_status in ('VISIBLE', 'LIMITED')), 0)::numeric as avg_rating,
      (select count(*) from public.tracedee_content_reports cr where cr.entity_type = 'TRACE' and cr.entity_id = t.id and cr.status in ('OPEN', 'REVIEWING'))::numeric as open_reports
    from public.tracedee_traces t
  ),
  post_signals as (
    select
      p.id as entity_id,
      (select count(*) from public.tracedee_comments c where c.thread_id = ct.id and c.status in ('VISIBLE', 'LIMITED'))::numeric as comments,
      (select count(*) from public.tracedee_content_reports cr where cr.entity_type = 'POST' and cr.entity_id = p.id and cr.status in ('OPEN', 'REVIEWING'))::numeric as open_reports
    from public.tracedee_posts p
    left join public.tracedee_comment_threads ct on ct.post_id = p.id
  ),
  comment_signals as (
    select
      c.id as entity_id,
      (select count(*) from public.tracedee_comment_reactions cr where cr.comment_id = c.id and cr.reaction = 'HELPFUL')::numeric as helpful,
      (select count(*) from public.tracedee_content_reports cr where cr.entity_type = 'COMMENT' and cr.entity_id = c.id and cr.status in ('OPEN', 'REVIEWING'))::numeric as open_reports
    from public.tracedee_comments c
  )
  select 'TRACE', entity_id, v_score_version,
    round((saves + follows * 1.5 + completions * 3 + avg_rating * 2 - open_reports * 5)::numeric, 4),
    least(1, (saves + follows + completions + case when avg_rating > 0 then 1 else 0 end)::numeric / 10),
    jsonb_build_object('saves', saves, 'follows', follows, 'completions', completions, 'avgRating', avg_rating, 'openReports', open_reports, 'algorithm', 'tracedee-deterministic-v1'),
    timezone('utc', now())
  from trace_signals
  union all
  select 'POST', entity_id, v_score_version,
    round((comments * 1.5 - open_reports * 5)::numeric, 4),
    least(1, (comments + 1)::numeric / 10),
    jsonb_build_object('comments', comments, 'openReports', open_reports, 'algorithm', 'tracedee-deterministic-v1'),
    timezone('utc', now())
  from post_signals
  union all
  select 'COMMENT', entity_id, v_score_version,
    round((helpful * 2 - open_reports * 5)::numeric, 4),
    least(1, (helpful + 1)::numeric / 10),
    jsonb_build_object('helpful', helpful, 'openReports', open_reports, 'algorithm', 'tracedee-deterministic-v1'),
    timezone('utc', now())
  from comment_signals;
  get diagnostics v_quality_count = row_count;

  return jsonb_build_object(
    'ok', true,
    'scoreVersion', v_score_version,
    'profileCount', v_profile_count,
    'expertiseCount', v_expertise_count,
    'tasteCount', v_taste_count,
    'qualityCount', v_quality_count,
    'calculatedAt', timezone('utc', now())
  );
end;
$$;

revoke all on function public.tracedee_rebuild_projections() from public, anon, authenticated;
grant execute on function public.tracedee_rebuild_projections() to service_role;
