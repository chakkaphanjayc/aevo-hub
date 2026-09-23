
-- Customer-facing store discovery is an explicit projection.  Do not derive
-- public search data from tenant-only address, phone, tax, or organization
-- records at request time: an operator must opt a store into this surface.
create table if not exists public.customer_store_profiles (
  store_id uuid primary key references public.stores(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  public_slug text not null unique check (public_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  public_enabled boolean not null default false,
  area text not null check (length(trim(area)) between 1 and 120),
  category text not null check (length(trim(category)) between 1 and 80),
  price_range text not null default '฿฿' check (length(trim(price_range)) between 1 and 16),
  availability_label text check (availability_label is null or length(trim(availability_label)) between 1 and 120),
  description text check (description is null or length(description) <= 1000),
  image_url text check (image_url is null or length(trim(image_url)) <= 2000),
  latitude numeric(9,6),
  longitude numeric(9,6),
  rating numeric(3,2) check (rating is null or (rating >= 0 and rating <= 5)),
  review_count integer not null default 0 check (review_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, store_id),
  foreign key (organization_id, store_id)
    references public.stores(organization_id, id) on delete cascade,
  check (
    (latitude is null and longitude is null)
    or (latitude between -90 and 90 and longitude between -180 and 180)
  )
);

create index if not exists customer_store_profiles_public_idx
  on public.customer_store_profiles (public_enabled, area, category, public_slug);

drop trigger if exists customer_store_profiles_set_updated_at on public.customer_store_profiles;
create trigger customer_store_profiles_set_updated_at
before update on public.customer_store_profiles
for each row execute function public.set_updated_at();

alter table public.customer_store_profiles enable row level security;

-- The public app reads this projection through the trusted Gateway only.  No
-- anonymous Data API access is granted; authenticated tenant access remains
-- explicitly organization-scoped for future Hub profile management screens.
revoke all on table public.customer_store_profiles from anon;
grant select, insert, update, delete on table public.customer_store_profiles to authenticated;

drop policy if exists customer_store_profiles_select_member on public.customer_store_profiles;
create policy customer_store_profiles_select_member on public.customer_store_profiles
for select to authenticated
using (private.is_org_member(organization_id));

drop policy if exists customer_store_profiles_manage on public.customer_store_profiles;
create policy customer_store_profiles_manage on public.customer_store_profiles
for all to authenticated
using (private.has_org_permission(organization_id, 'store.manage'))
with check (
  private.has_org_permission(organization_id, 'store.manage')
  and exists (
    select 1
    from public.stores s
    where s.id = customer_store_profiles.store_id
      and s.organization_id = customer_store_profiles.organization_id
  )
);
