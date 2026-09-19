-- Read-path projections for the Hub shell.
--
-- These functions deliberately do not become public authorization APIs. The
-- gateway authenticates the caller and resolves the tenant boundary first;
-- only the server role can execute the projections. They consolidate reads
-- over canonical tables without introducing duplicate business entities.

create or replace function public.hub_user_organizations(
  p_user_id uuid
)
returns table (
  id uuid,
  name text,
  slug text,
  role text,
  status text,
  created_at timestamptz
)
language sql
stable
set search_path = pg_catalog, public
as $function$
select
  o.id,
  o.name,
  o.slug,
  r.code::text as role,
  case when o.status = 'ACTIVE' then 'ACTIVE' else 'INACTIVE' end::text as status,
  o.created_at
from public.memberships m
join public.organizations o
  on o.id = m.organization_id
 and o.status <> 'DELETED'
join public.roles r on r.id = m.role_id
where m.user_id = p_user_id
  and m.status = 'ACTIVE'
order by m.created_at asc;
$function$;

revoke all on function public.hub_user_organizations(uuid)
  from public, anon, authenticated;
grant execute on function public.hub_user_organizations(uuid)
  to service_role;

create or replace function public.hub_user_navigation_favorites(
  p_user_id uuid
)
returns setof public.user_navigation_favorites
language sql
stable
set search_path = pg_catalog, public
as $function$
with user_memberships as (
  select
    m.id as membership_id,
    m.organization_id,
    r.code as role_code
  from public.memberships m
  join public.organizations o
    on o.id = m.organization_id
   and o.status = 'ACTIVE'
  join public.roles r on r.id = m.role_id
  where m.user_id = p_user_id
    and m.status = 'ACTIVE'
), accessible_stores as (
  select s.id, s.organization_id
  from public.stores s
  join user_memberships m on m.organization_id = s.organization_id
  where s.status = 'ACTIVE'
    and (
      m.role_code in ('OWNER', 'ADMIN', 'ORGANIZATION_MANAGER')
      or exists (
        select 1
        from public.membership_stores ms
        where ms.membership_id = m.membership_id
          and ms.store_id = s.id
      )
    )
)
select favorites.*
from public.user_navigation_favorites favorites
where favorites.user_id = p_user_id
  and (
    favorites.kind = 'MENU'
    or exists (
      select 1
      from user_memberships m
      where m.organization_id = favorites.organization_id
        and (
          favorites.kind = 'ORGANIZATION'
          or exists (
            select 1
            from accessible_stores s
            where s.organization_id = favorites.organization_id
              and s.id = favorites.store_id
          )
        )
    )
  )
order by favorites.position asc, favorites.created_at asc;
$function$;

revoke all on function public.hub_user_navigation_favorites(uuid)
  from public, anon, authenticated;
grant execute on function public.hub_user_navigation_favorites(uuid)
  to service_role;

create or replace function public.hub_organization_entitlements(
  p_organization_id uuid
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $function$
with subscription_context as (
  select
    coalesce((
      select s.plan_id
      from public.subscriptions s
      where s.organization_id = p_organization_id
      limit 1
    ), 'starter')::text as plan_id,
    coalesce((
      select s.status
      from public.subscriptions s
      where s.organization_id = p_organization_id
      limit 1
    ), 'ACTIVE')::text as status
), resolved as (
  select
    pe.feature_key,
    case when oe.feature_key is null then pe.is_enabled else oe.is_enabled end as is_enabled,
    case when oe.feature_key is null then pe.limit_value else oe.limit_value end as limit_value
  from subscription_context c
  join public.plan_entitlements pe on pe.plan_id = c.plan_id
  left join public.organization_entitlements oe
    on oe.organization_id = p_organization_id
   and oe.feature_key = pe.feature_key
  union all
  select oe.feature_key, oe.is_enabled, oe.limit_value
  from public.organization_entitlements oe
  where oe.organization_id = p_organization_id
    and not exists (
      select 1
      from subscription_context c
      join public.plan_entitlements pe on pe.plan_id = c.plan_id
      where pe.feature_key = oe.feature_key
    )
), current_usage as (
  select feature_key, current_count
  from public.usage_counters
  where organization_id = p_organization_id
)
select jsonb_build_object(
  'organizationId', p_organization_id,
  'planId', c.plan_id,
  'status', c.status,
  'features', coalesce((
    select jsonb_object_agg(r.feature_key, r.is_enabled)
    from resolved r
  ), '{}'::jsonb),
  'limits', coalesce((
    select jsonb_object_agg(r.feature_key, r.limit_value)
    from resolved r
  ), '{}'::jsonb),
  'usage', coalesce((
    select jsonb_object_agg(u.feature_key, u.current_count)
    from current_usage u
  ), '{}'::jsonb)
)
from subscription_context c;
$function$;

revoke all on function public.hub_organization_entitlements(uuid)
  from public, anon, authenticated;
grant execute on function public.hub_organization_entitlements(uuid)
  to service_role;

comment on function public.hub_user_organizations(uuid) is
  'Server-only Hub read model for active user organization memberships.';
comment on function public.hub_user_navigation_favorites(uuid) is
  'Server-only tenant-aware navigation favorite read model.';
comment on function public.hub_organization_entitlements(uuid) is
  'Server-only resolved organization entitlement and usage read model.';
