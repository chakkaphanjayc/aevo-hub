-- TraceDee Phase 4: evidence-backed reputation projection.
-- Reputation remains separate from XP and expertise. The evidence snapshot is
-- service-role-only so the Admin app can explain score changes without
-- exposing the private inputs to Aevo Go.

create table if not exists public.tracedee_reputation_evidence (
  profile_id uuid not null references auth.users(id) on delete cascade,
  score_version integer not null check (score_version > 0),
  reputation numeric(10,4) not null,
  helpful_ratio numeric(10,4) not null check (helpful_ratio between 0 and 1),
  downstream_completion_rate numeric(10,4) not null check (downstream_completion_rate between 0 and 1),
  rating_confidence numeric(10,4) not null check (rating_confidence between 0 and 1),
  report_outcome numeric(10,4) not null check (report_outcome between -1 and 1),
  account_trust numeric(10,4) not null check (account_trust between 0 and 1),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  components jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default timezone('utc', now()),
  primary key (profile_id, score_version)
);

create index if not exists tracedee_reputation_evidence_score_idx
  on public.tracedee_reputation_evidence (score_version, reputation desc, calculated_at desc);

alter table public.tracedee_reputation_evidence enable row level security;
revoke all on table public.tracedee_reputation_evidence from public, anon, authenticated;
grant select, insert, update, delete on table public.tracedee_reputation_evidence to service_role;

create or replace function public.tracedee_rebuild_reputation_evidence(
  p_score_version integer default 1
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_count integer := 0;
begin
  if coalesce(p_score_version, 0) < 1 then
    raise exception using errcode = 'P0001', message = 'REPUTATION_SCORE_VERSION_INVALID';
  end if;

  delete from public.tracedee_reputation_evidence
  where score_version = p_score_version;

  insert into public.tracedee_reputation_evidence (
    profile_id,
    score_version,
    reputation,
    helpful_ratio,
    downstream_completion_rate,
    rating_confidence,
    report_outcome,
    account_trust,
    evidence_count,
    components,
    calculated_at
  )
  with actors as (
    select profile_id from public.tracedee_profile_scores where score_version = p_score_version
    union select creator_id from public.tracedee_traces
    union select author_id from public.tracedee_posts
    union select author_id from public.tracedee_comments
    union select user_id from public.tracedee_journeys
    union select user_id from public.tracedee_trace_ratings
    union select actor_id from public.tracedee_activity_events where actor_id is not null
  ),
  authored as (
    select t.creator_id as profile_id, t.id as entity_id, 'TRACE'::text as entity_type
    from public.tracedee_traces t
    where t.status in ('PUBLISHED', 'UNDER_REVIEW', 'REMOVED', 'ARCHIVED')
    union all
    select p.author_id, p.id, 'POST'::text
    from public.tracedee_posts p
    where p.status in ('VISIBLE', 'LIMITED', 'UNDER_REVIEW', 'REMOVED')
    union all
    select c.author_id, c.id, 'COMMENT'::text
    from public.tracedee_comments c
    where c.status in ('VISIBLE', 'LIMITED', 'UNDER_REVIEW', 'REMOVED')
  ),
  content_signals as (
    select
      a.profile_id,
      count(*)::integer as authored_count,
      count(*) filter (where a.entity_type = 'COMMENT')::integer as comment_count
    from authored a
    group by a.profile_id
  ),
  helpful_signals as (
    select
      a.profile_id,
      count(*)::integer as helpful_count
    from authored a
    join public.tracedee_comment_reactions r
      on a.entity_type = 'COMMENT'
      and r.comment_id = a.entity_id
      and r.reaction = 'HELPFUL'
      and r.user_id <> a.profile_id
    group by a.profile_id
  ),
  published_signals as (
    select t.creator_id as profile_id, count(*)::integer as published_trace_count
    from public.tracedee_traces t
    where t.status = 'PUBLISHED' and t.visibility = 'PUBLIC'
    group by t.creator_id
  ),
  downstream_signals as (
    select t.creator_id as profile_id, count(*)::integer as downstream_completion_count
    from public.tracedee_traces t
    join public.tracedee_journeys j
      on j.trace_id = t.id
      and j.status = 'COMPLETED'
      and j.user_id <> t.creator_id
    where t.status = 'PUBLISHED' and t.visibility = 'PUBLIC'
    group by t.creator_id
  ),
  rating_signals as (
    select
      t.creator_id as profile_id,
      count(r.id)::integer as rating_count,
      coalesce(avg(r.rating), 0)::numeric as average_rating
    from public.tracedee_traces t
    left join public.tracedee_trace_ratings r
      on r.trace_id = t.id
      and r.user_id <> t.creator_id
      and r.moderation_status in ('VISIBLE', 'LIMITED')
    where t.status = 'PUBLISHED' and t.visibility = 'PUBLIC'
    group by t.creator_id
  ),
  report_signals as (
    select
      a.profile_id,
      count(r.id)::integer as report_count,
      count(r.id) filter (where r.status in ('OPEN', 'REVIEWING'))::integer as open_report_count,
      count(r.id) filter (where r.status = 'DISMISSED')::integer as dismissed_report_count,
      count(r.id) filter (
        where r.status = 'RESOLVED'
          and exists (
            select 1
            from public.tracedee_moderation_audit ma
            where ma.report_id = r.id
              and ma.action in ('LIMIT', 'REMOVE')
          )
      )::integer as adverse_report_count
    from authored a
    left join public.tracedee_content_reports r
      on r.entity_type = a.entity_type
      and r.entity_id = a.entity_id
    group by a.profile_id
  ),
  account_signals as (
    select
      a.profile_id,
      least(1, greatest(0,
        least(0.5, extract(epoch from (timezone('utc', now()) - coalesce(u.created_at, timezone('utc', now())))) / (86400 * 365))
        + least(0.5, coalesce((select count(*) from public.tracedee_activity_events e where e.actor_id = a.profile_id), 0)::numeric / 20)
      ))::numeric as account_trust
    from actors a
    left join auth.users u on u.id = a.profile_id
  ),
  signals as (
    select
      a.profile_id,
      coalesce(cs.authored_count, 0) as authored_count,
      coalesce(cs.comment_count, 0) as comment_count,
      coalesce(hs.helpful_count, 0) as helpful_count,
      coalesce(ps.published_trace_count, 0) as published_trace_count,
      coalesce(ds.downstream_completion_count, 0) as downstream_completion_count,
      coalesce(rs.rating_count, 0) as rating_count,
      coalesce(rs.average_rating, 0)::numeric as average_rating,
      coalesce(rps.report_count, 0) as report_count,
      coalesce(rps.open_report_count, 0) as open_report_count,
      coalesce(rps.dismissed_report_count, 0) as dismissed_report_count,
      coalesce(rps.adverse_report_count, 0) as adverse_report_count,
      coalesce(acs.account_trust, 0)::numeric as account_trust
    from actors a
    left join content_signals cs on cs.profile_id = a.profile_id
    left join helpful_signals hs on hs.profile_id = a.profile_id
    left join published_signals ps on ps.profile_id = a.profile_id
    left join downstream_signals ds on ds.profile_id = a.profile_id
    left join rating_signals rs on rs.profile_id = a.profile_id
    left join report_signals rps on rps.profile_id = a.profile_id
    left join account_signals acs on acs.profile_id = a.profile_id
  ),
  scored as (
    select
      s.*,
      case when s.comment_count > 0 then least(1, s.helpful_count::numeric / s.comment_count) else 0 end as helpful_ratio,
      least(1, s.downstream_completion_count::numeric / greatest(1, s.published_trace_count * 3)) as downstream_completion_rate,
      least(1, (s.rating_count::numeric / 5) * (s.average_rating / 5)) as rating_confidence,
      greatest(-1, least(1,
        1
        - s.adverse_report_count * 0.25
        - s.open_report_count * 0.10
        + s.dismissed_report_count * 0.05
      )) as report_outcome
    from signals s
  )
  select
    profile_id,
    p_score_version,
    round(greatest(-100, least(100,
      helpful_ratio * 35
      + downstream_completion_rate * 30
      + rating_confidence * 20
      + report_outcome * 10
      + account_trust * 5
    ))::numeric, 4),
    round(helpful_ratio::numeric, 4),
    round(downstream_completion_rate::numeric, 4),
    round(rating_confidence::numeric, 4),
    round(report_outcome::numeric, 4),
    round(account_trust::numeric, 4),
    (authored_count + helpful_count + downstream_completion_count + rating_count + report_count),
    jsonb_build_object(
      'algorithm', 'tracedee-reputation-v1',
      'weights', jsonb_build_object('helpfulRatio', 35, 'downstreamCompletionRate', 30, 'ratingConfidence', 20, 'reportOutcome', 10, 'accountTrust', 5),
      'inputs', jsonb_build_object(
        'authoredCount', authored_count,
        'commentCount', comment_count,
        'helpfulCount', helpful_count,
        'publishedTraceCount', published_trace_count,
        'downstreamCompletionCount', downstream_completion_count,
        'ratingCount', rating_count,
        'averageRating', round(average_rating::numeric, 4),
        'reportCount', report_count,
        'openReportCount', open_report_count,
        'dismissedReportCount', dismissed_report_count,
        'adverseReportCount', adverse_report_count
      ),
      'evidence', jsonb_build_array(
        case when helpful_ratio > 0 then 'helpful reactions from other members' else 'no helpful reaction evidence yet' end,
        case when downstream_completion_count > 0 then 'other members completed published traces' else 'no downstream completion evidence yet' end,
        case when rating_count > 0 then 'visible ratings from other members' else 'no rating evidence yet' end,
        case when report_count = 0 then 'no content reports' when adverse_report_count = 0 then 'reports have no adverse moderation outcome' else 'adverse moderation outcomes reduce trust' end
      )
    ),
    timezone('utc', now())
  from scored;
  get diagnostics v_count = row_count;

  update public.tracedee_profile_scores p
  set reputation = e.reputation,
      components = p.components || jsonb_build_object('reputation', e.components),
      updated_at = timezone('utc', now())
  from public.tracedee_reputation_evidence e
  where e.profile_id = p.profile_id
    and e.score_version = p.score_version
    and p.score_version = p_score_version;

  return jsonb_build_object(
    'ok', true,
    'scoreVersion', p_score_version,
    'profileCount', v_count,
    'calculatedAt', timezone('utc', now())
  );
end;
$$;

revoke all on function public.tracedee_rebuild_reputation_evidence(integer) from public, anon, authenticated;
grant execute on function public.tracedee_rebuild_reputation_evidence(integer) to service_role;

create or replace function public.tracedee_list_reputation_evidence(
  p_profile_id uuid default null,
  p_limit integer default 50
)
returns table (
  profile_id uuid,
  profile_name text,
  score_version integer,
  reputation numeric,
  helpful_ratio numeric,
  downstream_completion_rate numeric,
  rating_confidence numeric,
  report_outcome numeric,
  account_trust numeric,
  evidence_count integer,
  components jsonb,
  calculated_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    e.profile_id,
    coalesce(nullif(up.display_name, ''), nullif(up.email, ''), 'Aevo member') as profile_name,
    e.score_version,
    e.reputation,
    e.helpful_ratio,
    e.downstream_completion_rate,
    e.rating_confidence,
    e.report_outcome,
    e.account_trust,
    e.evidence_count,
    e.components,
    e.calculated_at
  from public.tracedee_reputation_evidence e
  left join public.user_profiles up on up.id = e.profile_id
  where p_profile_id is null or e.profile_id = p_profile_id
  order by e.reputation desc, e.calculated_at desc, e.profile_id asc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke all on function public.tracedee_list_reputation_evidence(uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_list_reputation_evidence(uuid, integer) to service_role;

-- Include the evidence snapshot in the existing replay/rollback snapshot.
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
    'reputation', coalesce((select jsonb_agg(to_jsonb(row_data)) from public.tracedee_reputation_evidence row_data where row_data.score_version = 1), '[]'::jsonb),
    'quality', coalesce((select jsonb_agg(to_jsonb(row_data)) from public.tracedee_content_quality_scores row_data where row_data.score_version = 1), '[]'::jsonb)
  );
$$;

revoke all on function public.tracedee_projection_snapshot() from public, anon, authenticated;
grant execute on function public.tracedee_projection_snapshot() to service_role;

-- Make the worker's canonical run include reputation before it snapshots the
-- applied state. The earlier migration already added the XP reconciliation.
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tracedee_rebuild_projections_with_run'
    and p.pronargs = 1
  order by p.oid desc
  limit 1;
  if v_definition is null then
    raise exception 'tracedee_rebuild_projections_with_run function is not installed';
  end if;
  if position('tracedee_rebuild_reputation_evidence' in v_definition) = 0 then
    v_definition := replace(
      v_definition,
      '  perform public.tracedee_reconcile_xp();',
      '  perform public.tracedee_rebuild_reputation_evidence(1);' || chr(10) || '  perform public.tracedee_reconcile_xp();'
    );
    execute v_definition;
  end if;
end;
$migration$;

-- Extend rollback to restore evidence rows from the same immutable snapshot.
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tracedee_rollback_projection'
    and p.pronargs = 7
  order by p.oid desc
  limit 1;
  if v_definition is null then
    raise exception 'tracedee_rollback_projection function is not installed';
  end if;
  if position('tracedee_reputation_evidence' in v_definition) = 0 then
    v_definition := replace(
      v_definition,
      '  delete from public.tracedee_content_quality_scores where score_version = v_run.score_version;',
      '  delete from public.tracedee_reputation_evidence where score_version = v_run.score_version;' || chr(10) || '  delete from public.tracedee_content_quality_scores where score_version = v_run.score_version;'
    );
    v_definition := replace(
      v_definition,
      '  insert into public.tracedee_content_quality_scores (id, entity_type, entity_id, score_version, score, confidence, components, calculated_at)',
      '  insert into public.tracedee_reputation_evidence (profile_id, score_version, reputation, helpful_ratio, downstream_completion_rate, rating_confidence, report_outcome, account_trust, evidence_count, components, calculated_at)' || chr(10) ||
      '  select profile_id, score_version, reputation, helpful_ratio, downstream_completion_rate, rating_confidence, report_outcome, account_trust, evidence_count, components, calculated_at' || chr(10) ||
      '  from jsonb_to_recordset(coalesce(v_run.previous_snapshot -> ''reputation'', ''[]''::jsonb)) as row_data(' ||
      'profile_id uuid, score_version integer, reputation numeric, helpful_ratio numeric, downstream_completion_rate numeric, rating_confidence numeric, report_outcome numeric, account_trust numeric, evidence_count integer, components jsonb, calculated_at timestamptz);' || chr(10) || chr(10) ||
      '  insert into public.tracedee_content_quality_scores (id, entity_type, entity_id, score_version, score, confidence, components, calculated_at)'
    );
    execute v_definition;
  end if;
end;
$migration$;
