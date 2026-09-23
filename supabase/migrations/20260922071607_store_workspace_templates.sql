-- Store workspace templates are organization-scoped configuration snapshots.
-- They are created and instantiated only through the trusted Gateway. The
-- snapshot deliberately references organization products by SKU so a branch
-- can reuse a catalog without attempting to duplicate globally unique SKUs.

create table if not exists public.store_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  source_store_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, id),
  unique (organization_id, name),
  foreign key (organization_id, source_store_id)
    references public.stores(organization_id, id)
    on delete set null (source_store_id)
);

create index if not exists store_templates_org_created_idx
  on public.store_templates (organization_id, created_at desc);

drop trigger if exists store_templates_set_updated_at on public.store_templates;
create trigger store_templates_set_updated_at
before update on public.store_templates
for each row execute function public.set_updated_at();

alter table public.store_templates enable row level security;
revoke all on table public.store_templates from public, anon, authenticated;
grant all on table public.store_templates to service_role;

create or replace function public.hub_create_store_from_template(
  p_organization_id uuid,
  p_template_id uuid,
  p_name text,
  p_code text,
  p_created_by uuid,
  p_public_slug text default null
)
returns table (
  id uuid,
  organization_id uuid,
  name text,
  code text,
  timezone text,
  currency text,
  store_mode text,
  address text,
  phone text,
  tax_id text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.store_templates%rowtype;
  v_snapshot jsonb;
  v_store_settings jsonb;
  v_store public.stores%rowtype;
  v_application jsonb;
  v_availability jsonb;
  v_menu jsonb;
  v_menu_item jsonb;
  v_product_id uuid;
  v_variant_id uuid;
  v_menu_id uuid;
  v_profile jsonb;
  v_profile_slug text;
begin
  select * into v_template
  from public.store_templates
  where store_templates.id = p_template_id
    and store_templates.organization_id = p_organization_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'STORE_TEMPLATE_NOT_FOUND';
  end if;

  v_snapshot := coalesce(v_template.snapshot, '{}'::jsonb);
  v_store_settings := coalesce(v_snapshot->'store', '{}'::jsonb);

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
  ) values (
    p_organization_id,
    trim(p_name),
    upper(trim(p_code)),
    coalesce(nullif(trim(v_store_settings->>'timezone'), ''), 'Asia/Bangkok'),
    upper(coalesce(nullif(trim(v_store_settings->>'currency'), ''), 'THB')),
    coalesce(nullif(trim(v_store_settings->>'storeMode'), ''), 'POS'),
    nullif(trim(v_store_settings->>'address'), ''),
    nullif(trim(v_store_settings->>'phone'), ''),
    nullif(trim(v_store_settings->>'taxId'), ''),
    'ACTIVE'
  ) returning * into v_store;

  for v_application in
    select value from jsonb_array_elements(coalesce(v_snapshot->'applications', '[]'::jsonb)) as value
  loop
    if v_application->>'applicationCode' in ('PLAY', 'POS', 'KIOSK', 'QUEUE') then
      insert into public.store_application_access (
        organization_id, store_id, application_code, status, updated_by
      ) values (
        p_organization_id,
        v_store.id,
        v_application->>'applicationCode',
        case when v_application->>'status' = 'ACTIVE' then 'ACTIVE' else 'DISABLED' end,
        p_created_by
      )
      on conflict on constraint store_application_access_pkey do update
      set status = excluded.status,
          updated_by = excluded.updated_by,
          updated_at = timezone('utc', now());
    end if;
  end loop;

  for v_availability in
    select value from jsonb_array_elements(coalesce(v_snapshot->'availability', '[]'::jsonb)) as value
  loop
    select products.id into v_product_id
    from public.products
    where products.organization_id = p_organization_id
      and products.sku = upper(trim(v_availability->>'sku'));
    if v_product_id is null then
      raise exception using errcode = 'P0001', message = 'STORE_TEMPLATE_PRODUCT_MISSING';
    end if;

    insert into public.product_availability (
      organization_id, store_id, product_id, channel, is_available, sold_out, price_override_minor
    ) values (
      p_organization_id,
      v_store.id,
      v_product_id,
      coalesce(v_availability->>'channel', 'POS'),
      coalesce((v_availability->>'isAvailable')::boolean, true),
      coalesce((v_availability->>'soldOut')::boolean, false),
      (v_availability->>'priceOverrideMinor')::integer
    )
    on conflict on constraint product_availability_pkey do update
    set is_available = excluded.is_available,
        sold_out = excluded.sold_out,
        price_override_minor = excluded.price_override_minor,
        updated_at = timezone('utc', now());
  end loop;

  for v_menu in
    select value from jsonb_array_elements(coalesce(v_snapshot->'menus', '[]'::jsonb)) as value
  loop
    insert into public.menus (
      organization_id, store_id, code, name, channel, status
    ) values (
      p_organization_id,
      v_store.id,
      upper(trim(v_menu->>'code')),
      trim(v_menu->>'name'),
      coalesce(v_menu->>'channel', 'POS'),
      case when v_menu->>'status' = 'INACTIVE' then 'INACTIVE' else 'ACTIVE' end
    ) returning menus.id into v_menu_id;

    for v_menu_item in
      select value from jsonb_array_elements(coalesce(v_menu->'items', '[]'::jsonb)) as value
    loop
      select products.id into v_product_id
      from public.products
      where products.organization_id = p_organization_id
        and products.sku = upper(trim(v_menu_item->>'sku'));
      if v_product_id is null then
        raise exception using errcode = 'P0001', message = 'STORE_TEMPLATE_PRODUCT_MISSING';
      end if;

      v_variant_id := null;
      if nullif(trim(v_menu_item->>'variantCode'), '') is not null then
        select product_variants.id into v_variant_id
        from public.product_variants
        where product_variants.organization_id = p_organization_id
          and product_variants.product_id = v_product_id
          and product_variants.code = upper(trim(v_menu_item->>'variantCode'));
        if v_variant_id is null then
          raise exception using errcode = 'P0001', message = 'STORE_TEMPLATE_VARIANT_MISSING';
        end if;
      end if;

      insert into public.menu_items (
        organization_id, menu_id, product_id, variant_id, price_override_minor,
        sort_order, is_available, sold_out
      ) values (
        p_organization_id,
        v_menu_id,
        v_product_id,
        v_variant_id,
        (v_menu_item->>'priceOverrideMinor')::integer,
        coalesce((v_menu_item->>'sortOrder')::integer, 0),
        coalesce((v_menu_item->>'isAvailable')::boolean, true),
        coalesce((v_menu_item->>'soldOut')::boolean, false)
      );
    end loop;
  end loop;

  v_profile := v_snapshot->'profile';
  v_profile_slug := nullif(lower(trim(coalesce(p_public_slug, concat_ws('-', v_profile->>'publicSlug', p_code)))), '');
  v_profile_slug := trim(both '-' from left(regexp_replace(v_profile_slug, '[^a-z0-9-]', '', 'g'), 63));
  if v_profile_slug is not null and exists (
    select 1 from public.customer_store_profiles
    where customer_store_profiles.public_slug = v_profile_slug
  ) then
    v_profile_slug := trim(both '-' from left(v_profile_slug, 55)) || '-' || substr(replace(v_store.id::text, '-', ''), 1, 7);
  end if;
  if v_profile_slug is not null and v_profile is not null and v_profile <> 'null'::jsonb then
    insert into public.customer_store_profiles (
      store_id, organization_id, public_slug, public_enabled, area, category,
      price_range, availability_label, description, image_url, media_urls,
      facilities, policy_summary, latitude, longitude, rating, review_count
    ) values (
      v_store.id,
      p_organization_id,
      v_profile_slug,
      coalesce((v_profile->>'publicEnabled')::boolean, false),
      coalesce(nullif(trim(v_profile->>'area'), ''), 'Unlisted'),
      coalesce(nullif(trim(v_profile->>'category'), ''), 'General'),
      coalesce(nullif(trim(v_profile->>'priceRange'), ''), '฿฿'),
      nullif(trim(v_profile->>'availabilityLabel'), ''),
      nullif(trim(v_profile->>'description'), ''),
      nullif(trim(v_profile->>'imageUrl'), ''),
      coalesce(v_profile->'mediaUrls', '[]'::jsonb),
      coalesce(v_profile->'facilities', '[]'::jsonb),
      nullif(trim(v_profile->>'policySummary'), ''),
      (v_profile->>'latitude')::numeric,
      (v_profile->>'longitude')::numeric,
      (v_profile->>'rating')::numeric,
      coalesce((v_profile->>'reviewCount')::integer, 0)
    );
  end if;

  return query
  select v_store.id, v_store.organization_id, v_store.name, v_store.code,
    v_store.timezone, v_store.currency, v_store.store_mode, v_store.address,
    v_store.phone, v_store.tax_id, v_store.status;
exception
  when unique_violation then
    raise;
end;
$function$;

revoke all on function public.hub_create_store_from_template(uuid, uuid, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.hub_create_store_from_template(uuid, uuid, text, text, uuid, text) to service_role;
