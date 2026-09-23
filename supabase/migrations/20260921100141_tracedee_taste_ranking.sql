-- TraceDee Phase 5 foundation: deterministic taste affinity as an optional
-- explainable feed signal. The flag remains disabled until a measured cohort
-- rollout is approved.

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
    jsonb_build_object(
      'area', b.area,
      'stopCount', b.stop_count,
      'creatorId', b.creator_id,
      'tasteScore', case when b.taste_enabled then b.taste_score else 0 end
    ),
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
