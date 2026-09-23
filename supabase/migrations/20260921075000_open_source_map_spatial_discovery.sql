-- Aevocado Go open-source map spatial foundation.
--
-- PostGIS is already installed in the project's public schema. Keep that
-- ownership intact; do not relocate or recreate the extension as part of the
-- map rollout. The Customer Store Profile remains the canonical public
-- projection, while `location` provides an indexed spatial search boundary.

create extension if not exists postgis;

alter table public.customer_store_profiles
  add column if not exists location public.geography(point, 4326);

create or replace function public.sync_customer_store_profile_location()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.latitude is null or new.longitude is null then
    new.location := null;
  else
    new.location := st_setsrid(
      st_makepoint(new.longitude::double precision, new.latitude::double precision),
      4326
    )::public.geography;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_store_profiles_sync_location on public.customer_store_profiles;
create trigger customer_store_profiles_sync_location
before insert or update of latitude, longitude on public.customer_store_profiles
for each row execute function public.sync_customer_store_profile_location();

update public.customer_store_profiles
set location = st_setsrid(
  st_makepoint(longitude::double precision, latitude::double precision),
  4326
)::public.geography
where latitude is not null
  and longitude is not null
  and location is null;

create index if not exists customer_store_profiles_location_gist
  on public.customer_store_profiles using gist (location)
  where public_enabled = true and location is not null;

comment on column public.customer_store_profiles.location is
  'Canonical public discovery point; longitude is stored before latitude in the PostGIS point.';

-- The Gateway is the only public read path. This security-invoker function
-- stays unavailable to anon/authenticated Data API callers and returns only a
-- capped, lightweight public projection for a viewport.
create or replace function public.public_store_discovery_in_view(
  p_west double precision,
  p_south double precision,
  p_east double precision,
  p_north double precision,
  p_query text default null,
  p_area text default null,
  p_category_ids text[] default null,
  p_price_levels integer[] default null,
  p_available_at timestamptz default null,
  p_party_size integer default null,
  p_limit integer default 49,
  p_offset integer default 0
)
returns table (
  store_id uuid,
  organization_id uuid,
  public_slug text,
  store_code text,
  store_name text,
  venue_slug text,
  area text,
  category text,
  price_range text,
  availability_label text,
  description text,
  image_url text,
  media_urls text[],
  facilities text[],
  policy_summary text,
  latitude numeric,
  longitude numeric,
  rating numeric,
  review_count integer,
  venue_address text,
  venue_timezone text
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with candidates as (
    select
      p.store_id,
      p.organization_id,
      p.public_slug,
      s.code as store_code,
      s.name as store_name,
      venue.slug as venue_slug,
      p.area,
      p.category,
      p.price_range,
      p.availability_label,
      p.description,
      p.image_url,
      p.media_urls,
      p.facilities,
      p.policy_summary,
      p.latitude,
      p.longitude,
      p.rating,
      p.review_count,
      venue.address as venue_address,
      coalesce(venue.timezone, s.timezone, 'Asia/Bangkok') as venue_timezone,
      coalesce(
        nullif(regexp_replace(p.price_range, '[^0-9]', '', 'g'), '')::integer,
        nullif(length(regexp_replace(p.price_range, '[^฿$€£]', '', 'g')), 0)
      ) as price_level
    from public.customer_store_profiles p
    join public.stores s
      on s.id = p.store_id
     and s.organization_id = p.organization_id
    join public.organizations o
      on o.id = p.organization_id
    left join lateral (
      select v.slug, v.address, v.timezone
      from public.venues v
      where v.store_id = p.store_id
        and v.organization_id = p.organization_id
        and v.status = 'ACTIVE'
      order by v.slug asc
      limit 1
    ) venue on true
    where p.public_enabled = true
      and s.status = 'ACTIVE'
      and o.status = 'ACTIVE'
      and p.location is not null
      and p.location && st_makeenvelope(p_west, p_south, p_east, p_north, 4326)::public.geography
      and (
        p_query is null
        or lower(concat_ws(' ', s.name, s.code, p.area, p.category, p.description))
          like '%' || lower(p_query) || '%'
      )
      and (p_area is null or lower(p.area) = lower(p_area))
      and (
        p_category_ids is null
        or cardinality(p_category_ids) = 0
        or lower(p.category) = any (p_category_ids)
      )
      and (
        p_price_levels is null
        or cardinality(p_price_levels) = 0
        or coalesce(
          nullif(regexp_replace(p.price_range, '[^0-9]', '', 'g'), '')::integer,
          nullif(length(regexp_replace(p.price_range, '[^฿$€£]', '', 'g')), 0)
        ) = any (p_price_levels)
      )
      -- The current public projection exposes an operator-managed availability
      -- label, not a complete slot inventory read model. Keep the filter
      -- conservative until availability is promoted to a map-ready aggregate.
      and (p_available_at is null or p.availability_label is not null)
      and (
        p_party_size is null
        or exists (
          select 1
          from public.venues capacity_venue
          join public.bookable_resources resource
            on resource.venue_id = capacity_venue.id
           and resource.organization_id = capacity_venue.organization_id
           and resource.status = 'ACTIVE'
          where capacity_venue.store_id = p.store_id
            and capacity_venue.organization_id = p.organization_id
            and capacity_venue.status = 'ACTIVE'
            and resource.capacity >= p_party_size
        )
      )
  )
  select
    candidates.store_id,
    candidates.organization_id,
    candidates.public_slug,
    candidates.store_code,
    candidates.store_name,
    candidates.venue_slug,
    candidates.area,
    candidates.category,
    candidates.price_range,
    candidates.availability_label,
    candidates.description,
    candidates.image_url,
    candidates.media_urls,
    candidates.facilities,
    candidates.policy_summary,
    candidates.latitude,
    candidates.longitude,
    candidates.rating,
    candidates.review_count,
    candidates.venue_address,
    candidates.venue_timezone
  from candidates
  order by candidates.public_slug asc, candidates.store_id asc
  limit least(greatest(coalesce(p_limit, 49), 1), 49)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.public_store_discovery_in_view(
  double precision,
  double precision,
  double precision,
  double precision,
  text,
  text,
  text[],
  integer[],
  timestamptz,
  integer,
  integer,
  integer
) from public, anon, authenticated;
grant execute on function public.public_store_discovery_in_view(
  double precision,
  double precision,
  double precision,
  double precision,
  text,
  text,
  text[],
  integer[],
  timestamptz,
  integer,
  integer,
  integer
) to service_role;
