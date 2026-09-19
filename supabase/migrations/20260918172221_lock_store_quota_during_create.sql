-- Serialize store quota checks per organization so concurrent creates cannot exceed max_stores.
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
    and o.status = 'ACTIVE'
  for update;

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
