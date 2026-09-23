-- TraceDee remix editor read boundary.
-- The customer app may search public place projections and read only its own
-- private remix draft through the service-role Gateway boundary.

create or replace function public.tracedee_search_places(
  p_query text default null,
  p_area text default null,
  p_limit integer default 24
)
returns table (
  id uuid,
  slug text,
  name text,
  area text,
  category text,
  description text,
  image_url text,
  latitude numeric,
  longitude numeric
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    p.id,
    p.slug,
    p.name,
    p.area,
    p.category,
    p.description,
    p.image_url,
    p.latitude,
    p.longitude
  from public.tracedee_places p
  where p.moderation_status in ('VISIBLE', 'LIMITED')
    and (
      nullif(trim(coalesce(p_query, '')), '') is null
      or lower(concat_ws(' ', p.name, p.slug, p.area, p.category, p.description, array_to_string(p.topic_tags, ' ')))
        like '%' || lower(trim(p_query)) || '%'
    )
    and (
      nullif(trim(coalesce(p_area, '')), '') is null
      or lower(p.area) = lower(trim(p_area))
    )
  order by
    case when lower(p.name) = lower(trim(coalesce(p_query, ''))) then 0 else 1 end,
    p.name asc,
    p.id asc
  limit least(greatest(coalesce(p_limit, 24), 1), 48);
$$;

revoke all on function public.tracedee_search_places(text, text, integer) from public, anon, authenticated;
grant execute on function public.tracedee_search_places(text, text, integer) to service_role;
