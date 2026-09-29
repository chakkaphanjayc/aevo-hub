-- Discovery UGC safety: bounded historical text remediation.
--
-- This is an operator/worker boundary, not a browser mutation. It only moves
-- currently public Post/Comment rows that match the high-confidence reject
-- policy into UNDER_REVIEW. It never hard-deletes content and does not touch
-- canonical Trace/Place rows.

create table if not exists public.tracedee_ugc_policy_remediation_runs (
  id uuid primary key default gen_random_uuid(),
  policy_version text not null check (length(trim(policy_version)) between 1 and 80),
  requested_limit integer not null check (requested_limit between 1 and 10000),
  posts_held integer not null default 0 check (posts_held >= 0),
  comments_held integer not null default 0 check (comments_held >= 0),
  posts_remaining boolean not null default false,
  comments_remaining boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.tracedee_ugc_policy_remediation_runs enable row level security;

create index if not exists tracedee_ugc_policy_remediation_runs_created_idx
  on public.tracedee_ugc_policy_remediation_runs (created_at desc);

revoke all on table public.tracedee_ugc_policy_remediation_runs from public, anon, authenticated;
grant select, insert, update on table public.tracedee_ugc_policy_remediation_runs to service_role;

create or replace function public.tracedee_remediate_ugc_text_policy(
  p_limit integer default 1000
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_policy_version text := 'ugc-safe-v1';
  v_run_id uuid;
  v_posts_held integer := 0;
  v_comments_held integer := 0;
  v_posts_remaining boolean := false;
  v_comments_remaining boolean := false;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception using errcode = 'P0001', message = 'UGC_REMEDIATION_LIMIT_INVALID';
  end if;

  -- Serialize operators/workers so two runs cannot report overlapping work.
  perform pg_advisory_xact_lock(hashtextextended('tracedee-ugc-text-remediation', 0));

  insert into public.tracedee_ugc_policy_remediation_runs (policy_version, requested_limit)
  values (v_policy_version, p_limit)
  returning id into v_run_id;

  with flagged as materialized (
    select p.id
    from public.tracedee_posts p
    where p.status in ('VISIBLE', 'LIMITED')
      and public.tracedee_content_policy_decision(p.body)->>'action' = 'REJECT'
    order by p.created_at, p.id
    limit p_limit
  )
  update public.tracedee_posts p
  set status = 'UNDER_REVIEW',
      updated_at = timezone('utc', now())
  from flagged
  where p.id = flagged.id;
  get diagnostics v_posts_held = row_count;

  with flagged as materialized (
    select c.id
    from public.tracedee_comments c
    where c.status in ('VISIBLE', 'LIMITED')
      and public.tracedee_content_policy_decision(c.body)->>'action' = 'REJECT'
    order by c.created_at, c.id
    limit p_limit
  )
  update public.tracedee_comments c
  set status = 'UNDER_REVIEW',
      updated_at = timezone('utc', now())
  from flagged
  where c.id = flagged.id;
  get diagnostics v_comments_held = row_count;

  select exists (
    select 1
    from public.tracedee_posts p
    where p.status in ('VISIBLE', 'LIMITED')
      and public.tracedee_content_policy_decision(p.body)->>'action' = 'REJECT'
  ) into v_posts_remaining;

  select exists (
    select 1
    from public.tracedee_comments c
    where c.status in ('VISIBLE', 'LIMITED')
      and public.tracedee_content_policy_decision(c.body)->>'action' = 'REJECT'
  ) into v_comments_remaining;

  update public.tracedee_ugc_policy_remediation_runs
  set posts_held = v_posts_held,
      comments_held = v_comments_held,
      posts_remaining = v_posts_remaining,
      comments_remaining = v_comments_remaining
  where id = v_run_id;

  return jsonb_build_object(
    'ok', true,
    'runId', v_run_id,
    'policyVersion', v_policy_version,
    'requestedLimit', p_limit,
    'postsHeld', v_posts_held,
    'commentsHeld', v_comments_held,
    'postsRemaining', v_posts_remaining,
    'commentsRemaining', v_comments_remaining
  );
end;
$$;

revoke all on function public.tracedee_remediate_ugc_text_policy(integer) from public, anon, authenticated;
grant execute on function public.tracedee_remediate_ugc_text_policy(integer) to service_role;
