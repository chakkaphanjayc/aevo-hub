-- Production hardening for organization/store lifecycle.
-- IDs remain database-owned UUIDs. Human-facing slugs and store codes are
-- generated/validated inside the same transaction as the tenant record.

create or replace function public.hub_create_organization(
  p_owner_user_id uuid,
  p_name text,
  p_slug text default null,
  p_legal_name text default null,
  p_business_type text default 'GENERAL',
  p_country text default 'TH',
  p_timezone text default 'Asia/Bangkok',
  p_currency text default 'THB',
  p_logo_url text default null,
  p_contact_email text default null,
  p_contact_phone text default null
)
returns table (
  id uuid,
  name text,
  slug text,
  status text,
  created_at timestamptz
)
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_base_slug text;
  v_candidate_slug text;
  v_suffix integer := 0;
  v_organization_id uuid;
  v_owner_role_id uuid;
begin
  if p_owner_user_id is null then
    raise exception using errcode = '22004', message = 'OWNER_USER_ID_REQUIRED';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception using errcode = '22023', message = 'ORGANIZATION_NAME_REQUIRED';
  end if;

  v_base_slug := regexp_replace(
    lower(trim(coalesce(nullif(p_slug, ''), p_name))),
    '[^a-z0-9]+',
    '-',
    'g'
  );
  v_base_slug := trim(both '-' from v_base_slug);
  if v_base_slug = '' then
    v_base_slug := 'org';
  end if;
  v_base_slug := left(v_base_slug, 63);

  loop
    v_candidate_slug := case
      when v_suffix = 0 then v_base_slug
      else left(v_base_slug, 63 - length(v_suffix::text) - 1) || '-' || v_suffix::text
    end;

    begin
      insert into public.organizations (
        name,
        slug,
        status,
        owner_user_id,
        legal_name,
        business_type,
        country,
        timezone,
        currency,
        logo_url,
        contact_email,
        contact_phone,
        onboarding_status
      )
      values (
        trim(p_name),
        v_candidate_slug,
        'ACTIVE',
        p_owner_user_id,
        coalesce(nullif(trim(p_legal_name), ''), trim(p_name)),
        coalesce(nullif(trim(p_business_type), ''), 'GENERAL'),
        upper(coalesce(nullif(trim(p_country), ''), 'TH')),
        coalesce(nullif(trim(p_timezone), ''), 'Asia/Bangkok'),
        upper(coalesce(nullif(trim(p_currency), ''), 'THB')),
        nullif(trim(p_logo_url), ''),
        lower(nullif(trim(p_contact_email), '')),
        nullif(trim(p_contact_phone), ''),
        'IN_PROGRESS'
      )
      returning organizations.id into v_organization_id;
      exit;
    exception
      when unique_violation then
        v_suffix := v_suffix + 1;
        if v_suffix > 1000 then
          raise exception using errcode = '23505', message = 'ORGANIZATION_SLUG_UNAVAILABLE';
        end if;
    end;
  end loop;

  select r.id
    into v_owner_role_id
  from public.roles r
  where r.code = 'OWNER'
  limit 1;

  if v_owner_role_id is null then
    raise exception using errcode = 'P0001', message = 'OWNER_ROLE_NOT_CONFIGURED';
  end if;

  insert into public.memberships (organization_id, user_id, role_id, status)
  values (v_organization_id, p_owner_user_id, v_owner_role_id, 'ACTIVE');

  insert into public.subscriptions (organization_id, plan_id, provider, status)
  values (v_organization_id, 'starter', 'MANUAL', 'TRIALING')
  on conflict (organization_id) do nothing;

  insert into public.organization_entitlements (
    organization_id,
    feature_key,
    is_enabled,
    custom_override,
    limit_value
  )
  select
    v_organization_id,
    pe.feature_key,
    pe.is_enabled,
    false,
    pe.limit_value
  from public.plan_entitlements pe
  where pe.plan_id = 'starter'
  on conflict (organization_id, feature_key) do nothing;

  return query
  select o.id, o.name, o.slug, o.status, o.created_at
  from public.organizations o
  where o.id = v_organization_id;
end;
$$;

create or replace function public.hub_create_store(
  p_organization_id uuid,
  p_name text,
  p_code text,
  p_timezone text default 'Asia/Bangkok',
  p_currency text default 'THB',
  p_store_mode text default 'POS',
  p_address text default null,
  p_phone text default null,
  p_tax_id text default null
)
returns table (
  id uuid,
  organization_id uuid,
  name text,
  code text,
  timezone text
)
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_max_stores integer;
  v_active_stores integer;
begin
  select o.max_stores
    into v_max_stores
  from public.organizations o
  where o.id = p_organization_id
    and o.status = 'ACTIVE';

  if not found then
    raise exception using errcode = 'P0001', message = 'ORGANIZATION_NOT_ACTIVE';
  end if;

  select count(*)::integer
    into v_active_stores
  from public.stores s
  where s.organization_id = p_organization_id
    and s.status = 'ACTIVE';

  if v_max_stores is not null and v_active_stores >= v_max_stores then
    raise exception using errcode = 'P0001', message = 'STORE_QUOTA_EXCEEDED';
  end if;

  return query
  insert into public.stores (
    organization_id,
    name,
    code,
    timezone,
    currency,
    store_mode,
    address,
    phone,
    tax_id,
    status
  )
  values (
    p_organization_id,
    trim(p_name),
    upper(trim(p_code)),
    coalesce(nullif(trim(p_timezone), ''), 'Asia/Bangkok'),
    upper(coalesce(nullif(trim(p_currency), ''), 'THB')),
    coalesce(nullif(trim(p_store_mode), ''), 'POS'),
    nullif(trim(p_address), ''),
    nullif(trim(p_phone), ''),
    nullif(trim(p_tax_id), ''),
    'ACTIVE'
  )
  returning stores.id, stores.organization_id, stores.name, stores.code, stores.timezone;
end;
$$;

revoke all on function public.hub_create_organization(uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.hub_create_store(uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.hub_create_organization(uuid, text, text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.hub_create_store(uuid, text, text, text, text, text, text, text, text) to service_role;

-- Production must not retain the historical unlimited-testing switch.
insert into public.system_settings (key, value)
values (
  'operating_mode',
  jsonb_build_object('mode', 'production', 'unlimited', false, 'updated_at', timezone('utc', now()))
)
on conflict (key) do update set
  value = excluded.value,
  updated_at = timezone('utc', now());

-- Remove automated onboarding/test tenants. This is intentionally narrow:
-- only generated names/slugs owned by the test email domain are removed.
delete from public.organizations o
where (o.name ilike 'Arena & Cafe %' or o.name = 'Aevo Arena & Bistro')
  and exists (
    select 1
    from public.memberships m
    join public.user_profiles up on up.id = m.user_id
    where m.organization_id = o.id
      and lower(up.email) like '%@aevo.test'
  );

-- Remove any remaining flagged demo records from real tenants while retaining
-- the tenant, user identities, and production configuration.
delete from public.booking_waitlists bw
where bw.venue_id in (select v.id from public.venues v where v.is_demo_data = true);
delete from public.waitlist w
where w.customer_name ilike '%demo%';
delete from public.bookings b where b.is_demo_data = true;
delete from public.booking_pricing_rules r
where r.venue_id in (select v.id from public.venues v where v.is_demo_data = true);
delete from public.operating_hours h
where h.venue_id in (select v.id from public.venues v where v.is_demo_data = true);
delete from public.bookable_resources r
where r.venue_id in (select v.id from public.venues v where v.is_demo_data = true);
delete from public.venues where is_demo_data = true;

-- Orders are removed before catalog rows because order items retain product
-- references in production-safe schemas.
delete from public.orders where is_demo_data = true;

delete from public.inventory_movements m
where m.inventory_item_id in (select i.id from public.inventory_items i where i.sku like 'DEMO-%');
delete from public.inventory_items where sku like 'DEMO-%';

delete from public.menu_item_modifier_groups mmg
where mmg.menu_item_id in (
  select mi.id from public.menu_items mi
  where mi.menu_id in (select m.id from public.menus m where m.code like 'DEMO_%')
);
delete from public.menu_items
where menu_id in (select m.id from public.menus m where m.code like 'DEMO_%');
delete from public.menus where code like 'DEMO_%';

delete from public.modifiers
where modifier_group_id in (select g.id from public.modifier_groups g where g.code like 'DEMO_%');
delete from public.product_modifier_groups
where modifier_group_id in (select g.id from public.modifier_groups g where g.code like 'DEMO_%')
   or product_id in (select p.id from public.products p where p.is_demo_data = true);
delete from public.modifier_groups where code like 'DEMO_%';

delete from public.product_availability where product_id in (select p.id from public.products p where p.is_demo_data = true);
delete from public.product_variants where product_id in (select p.id from public.products p where p.is_demo_data = true);
delete from public.products where is_demo_data = true;
delete from public.categories where is_demo_data = true;
