-- Workspace read models and indexes.
--
-- The Hub dashboard is a server-owned surface, so these functions are only
-- callable by the API service role. Tenant authorization remains in the
-- gateway before the function is invoked; the SQL keeps every aggregate
-- explicitly scoped to the requested organization/store.

create index if not exists orders_org_active_created_idx
  on public.orders (organization_id, created_at desc)
  where status in ('PAID', 'COMPLETED', 'SERVED', 'READY');

create index if not exists bookings_org_venue_start_idx
  on public.bookings (organization_id, venue_id, start_at);

create index if not exists devices_org_active_store_idx
  on public.devices (organization_id, store_id)
  where status = 'ACTIVE';

create index if not exists organization_entitlements_org_enabled_feature_idx
  on public.organization_entitlements (organization_id, is_enabled, feature_key);

create or replace function public.hub_organization_overview_metrics(
  p_organization_id uuid,
  p_today_start timestamptz,
  p_month_start timestamptz
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $function$
with active_stores as (
  select id, name, code, status, created_at
  from public.stores
  where organization_id = p_organization_id
    and status = 'ACTIVE'
),
eligible_orders as (
  select store_id, total_minor, created_at
  from public.orders
  where organization_id = p_organization_id
    and status in ('PAID', 'COMPLETED', 'SERVED', 'READY')
    and created_at >= p_month_start
),
today_store_orders as (
  select store_id,
         coalesce(sum(total_minor), 0) as revenue_minor,
         count(*) as order_count
  from eligible_orders
  where created_at >= p_today_start
  group by store_id
),
active_devices as (
  select store_id, count(*) as device_count
  from public.devices
  where organization_id = p_organization_id
    and status = 'ACTIVE'
  group by store_id
)
select jsonb_build_object(
  'totalStores', (select count(*) from active_stores),
  'activeApps', (
    select count(*)
    from public.organization_entitlements
    where organization_id = p_organization_id
      and is_enabled = true
      and feature_key not like 'max_%'
  ),
  'totalMembers', (
    select count(*)
    from public.memberships
    where organization_id = p_organization_id
      and status = 'ACTIVE'
  ),
  'todayRevenueMinor', coalesce((select sum(total_minor) from eligible_orders where created_at >= p_today_start), 0),
  'monthRevenueMinor', coalesce((select sum(total_minor) from eligible_orders), 0),
  'storePerformance', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'storeId', stores.id,
        'name', stores.name,
        'code', stores.code,
        'status', stores.status,
        'todayRevenueMinor', coalesce(orders.revenue_minor, 0),
        'todayOrdersCount', coalesce(orders.order_count, 0),
        'activeDevicesCount', coalesce(devices.device_count, 0)
      )
      order by stores.created_at asc, stores.name asc
    )
    from active_stores stores
    left join today_store_orders orders on orders.store_id = stores.id
    left join active_devices devices on devices.store_id = stores.id
  ), '[]'::jsonb)
);
$function$;

revoke all on function public.hub_organization_overview_metrics(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hub_organization_overview_metrics(uuid, timestamptz, timestamptz)
  to service_role;

create or replace function public.hub_store_overview_metrics(
  p_organization_id uuid,
  p_store_id uuid,
  p_today_start timestamptz
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $function$
select jsonb_build_object(
  'storeId', stores.id,
  'name', stores.name,
  'code', stores.code,
  'todaySalesMinor', coalesce((
    select sum(total_minor)
    from public.orders
    where organization_id = p_organization_id
      and store_id = p_store_id
      and status in ('PAID', 'COMPLETED', 'SERVED', 'READY')
      and created_at >= p_today_start
  ), 0),
  'todayOrders', coalesce((
    select count(*)
    from public.orders
    where organization_id = p_organization_id
      and store_id = p_store_id
      and status in ('PAID', 'COMPLETED', 'SERVED', 'READY')
      and created_at >= p_today_start
  ), 0),
  'todayBookings', coalesce((
    select count(*)
    from public.bookings bookings
    join public.venues venues
      on venues.id = bookings.venue_id
     and venues.organization_id = bookings.organization_id
    where bookings.organization_id = p_organization_id
      and venues.store_id = p_store_id
      and bookings.start_at >= p_today_start
  ), 0),
  'devicesOnline', coalesce((
    select count(*)
    from public.devices
    where organization_id = p_organization_id
      and store_id = p_store_id
      and status = 'ACTIVE'
  ), 0),
  'devicesTotal', coalesce((
    select count(*)
    from public.devices
    where organization_id = p_organization_id
      and store_id = p_store_id
  ), 0)
)
from public.stores stores
where stores.organization_id = p_organization_id
  and stores.id = p_store_id
  and stores.status = 'ACTIVE';
$function$;

revoke all on function public.hub_store_overview_metrics(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hub_store_overview_metrics(uuid, uuid, timestamptz)
  to service_role;
