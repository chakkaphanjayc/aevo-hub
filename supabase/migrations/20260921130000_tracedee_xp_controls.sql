-- TraceDee Phase 4: bounded, replayable XP awards.
-- XP is derived from authoritative activity/completion/content state. Awards
-- are provisional for an anti-abuse window, capped per UTC day, and reversible
-- when the source content or completion becomes invalid.

create table if not exists public.tracedee_xp_awards (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.tracedee_activity_events(id) on delete restrict,
  profile_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  base_amount integer not null check (base_amount >= 0),
  awarded_amount integer not null check (awarded_amount >= 0),
  status text not null default 'PROVISIONAL' check (status in ('PROVISIONAL', 'CONFIRMED', 'REVERSED')),
  available_at timestamptz not null,
  reversal_reason text,
  components jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.tracedee_xp_awards enable row level security;
create index if not exists tracedee_xp_awards_profile_status_idx
  on public.tracedee_xp_awards (profile_id, status, created_at desc);
create index if not exists tracedee_xp_awards_available_idx
  on public.tracedee_xp_awards (status, available_at);

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

create or replace function public.tracedee_reconcile_xp(
  p_now timestamptz default timezone('utc', now())
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_inserted integer := 0;
  v_confirmed integer := 0;
  v_reversed integer := 0;
  v_profile_count integer := 0;
begin
  with candidates as (
    select
      e.id as event_id,
      e.actor_id as profile_id,
      e.event_type,
      e.occurred_at,
      case e.event_type
        when 'trace_completed' then 100
        when 'post_created' then 30
        when 'comment_marked_helpful' then 5
        when 'trace_rated' then 10
        else 0
      end as base_amount
    from public.tracedee_activity_events e
    where e.actor_id is not null
      and e.event_type in ('trace_completed', 'post_created', 'comment_marked_helpful', 'trace_rated')
      and (
        (e.event_type = 'trace_completed' and exists (
          select 1
          from public.tracedee_completions c
          where c.journey_id = e.entity_id
            and c.verification_status <> 'REJECTED'
        ))
        or (e.event_type = 'post_created' and exists (
          select 1 from public.tracedee_posts p
          where p.id = e.entity_id and p.status in ('VISIBLE', 'LIMITED')
        ))
        or (e.event_type = 'comment_marked_helpful'
          and coalesce((e.metadata->>'active')::boolean, false)
          and exists (
            select 1 from public.tracedee_comments c
            where c.id = e.entity_id and c.status in ('VISIBLE', 'LIMITED')
          ))
        or (e.event_type = 'trace_rated' and exists (
          select 1 from public.tracedee_trace_ratings r
          where r.trace_id = e.entity_id
            and r.user_id = e.actor_id
            and r.completion_id::text = e.metadata->>'completionId'
            and r.moderation_status in ('VISIBLE', 'LIMITED')
        ))
      )
      and not exists (select 1 from public.tracedee_xp_awards a where a.event_id = e.id)
  ),
  ranked as (
    select c.*,
      row_number() over (
        partition by c.profile_id, c.event_type, (c.occurred_at at time zone 'utc')::date
        order by c.occurred_at asc, c.event_id asc
      ) as signal_rank
    from candidates c
  ),
  scaled as (
    select r.*,
      greatest(0, floor(r.base_amount * power(0.5, r.signal_rank - 1)))::integer as scaled_amount
    from ranked r
  ),
  capped as (
    select s.*,
      least(
        s.scaled_amount,
        greatest(0, 500 - coalesce(sum(s.scaled_amount) over (
          partition by s.profile_id, (s.occurred_at at time zone 'utc')::date
          order by s.occurred_at asc, s.event_id asc
          rows between unbounded preceding and 1 preceding
        ), 0))
      )::integer as awarded_amount
    from scaled s
  )
  insert into public.tracedee_xp_awards (
    event_id, profile_id, event_type, base_amount, awarded_amount, status,
    available_at, components
  )
  select
    event_id,
    profile_id,
    event_type,
    base_amount,
    awarded_amount,
    case when occurred_at + interval '24 hours' <= p_now then 'CONFIRMED' else 'PROVISIONAL' end,
    occurred_at + interval '24 hours',
    jsonb_build_object(
      'algorithm', 'tracedee-xp-v1',
      'dailyCap', 500,
      'diminishingRank', signal_rank,
      'utcDate', (occurred_at at time zone 'utc')::date
    )
  from capped;
  get diagnostics v_inserted = row_count;

  update public.tracedee_xp_awards a
  set status = 'CONFIRMED', updated_at = timezone('utc', now())
  where a.status = 'PROVISIONAL' and a.available_at <= p_now;
  get diagnostics v_confirmed = row_count;

  update public.tracedee_xp_awards a
  set status = 'REVERSED',
      reversal_reason = case
        when a.event_type = 'trace_completed' then 'completion_rejected'
        when a.event_type = 'post_created' then 'content_removed'
        when a.event_type = 'comment_marked_helpful' then 'comment_removed'
        when a.event_type = 'trace_rated' then 'rating_removed'
        else 'source_invalidated'
      end,
      awarded_amount = 0,
      updated_at = timezone('utc', now())
  where a.status <> 'REVERSED'
    and (
      (a.event_type = 'trace_completed' and exists (
        select 1 from public.tracedee_activity_events e
        join public.tracedee_completions c on c.journey_id = e.entity_id
        where e.id = a.event_id and c.verification_status = 'REJECTED'
      ))
      or (a.event_type = 'post_created' and exists (
        select 1 from public.tracedee_activity_events e
        join public.tracedee_posts p on p.id = e.entity_id
        where e.id = a.event_id and p.status = 'REMOVED'
      ))
      or (a.event_type = 'comment_marked_helpful' and exists (
        select 1 from public.tracedee_activity_events e
        join public.tracedee_comments c on c.id = e.entity_id
        where e.id = a.event_id and c.status = 'REMOVED'
      ))
      or (a.event_type = 'trace_rated' and exists (
        select 1 from public.tracedee_activity_events e
        join public.tracedee_trace_ratings r
          on r.trace_id = e.entity_id
         and r.user_id = e.actor_id
         and r.completion_id::text = e.metadata->>'completionId'
        where e.id = a.event_id and r.moderation_status = 'REMOVED'
      ))
    );
  get diagnostics v_reversed = row_count;

  update public.tracedee_profile_scores ps
  set xp = coalesce((
        select sum(a.awarded_amount)::integer
        from public.tracedee_xp_awards a
        where a.profile_id = ps.profile_id and a.status in ('PROVISIONAL', 'CONFIRMED')
      ), 0),
      components = ps.components || jsonb_build_object(
        'xpAlgorithm', 'tracedee-xp-v1',
        'xpDailyCap', 500,
        'xpProvisional', coalesce((select sum(a.awarded_amount)::integer from public.tracedee_xp_awards a where a.profile_id = ps.profile_id and a.status = 'PROVISIONAL'), 0),
        'xpConfirmed', coalesce((select sum(a.awarded_amount)::integer from public.tracedee_xp_awards a where a.profile_id = ps.profile_id and a.status = 'CONFIRMED'), 0),
        'xpReversed', coalesce((select count(*)::integer from public.tracedee_xp_awards a where a.profile_id = ps.profile_id and a.status = 'REVERSED'), 0)
      ),
      updated_at = timezone('utc', now())
  where exists (select 1 from public.tracedee_xp_awards a where a.profile_id = ps.profile_id);
  get diagnostics v_profile_count = row_count;

  return jsonb_build_object(
    'ok', true,
    'algorithm', 'tracedee-xp-v1',
    'insertedCount', v_inserted,
    'confirmedCount', v_confirmed,
    'reversedCount', v_reversed,
    'profileCount', v_profile_count,
    'calculatedAt', timezone('utc', now())
  );
end;
$$;

revoke all on function public.tracedee_reconcile_xp(timestamptz) from public, anon, authenticated;
grant execute on function public.tracedee_reconcile_xp(timestamptz) to service_role;

-- Ensure official run/replay snapshots include the bounded XP projection.
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
  v_definition := replace(
    v_definition,
    '  v_result := public.tracedee_rebuild_projections();',
    '  v_result := public.tracedee_rebuild_projections();
  perform public.tracedee_reconcile_xp();'
  );
  execute v_definition;
end;
$migration$;
