-- Store-level application availability.
--
-- Member application assignments still decide which people may enter an app.
-- This table is the store-level ceiling: an app must also be enabled for the
-- target store before a store-scoped access decision can be ALLOWED.

create table if not exists public.store_application_access (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid not null,
  application_code text not null references public.application_registry(code) on update cascade on delete restrict,
  status text not null default 'DISABLED' check (status in ('ACTIVE', 'DISABLED')),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, store_id, application_code),
  foreign key (organization_id, store_id)
    references public.stores(organization_id, id)
    on delete cascade,
  check (application_code in ('PLAY', 'POS', 'KIOSK', 'QUEUE'))
);

create index if not exists store_application_access_store_idx
  on public.store_application_access (organization_id, store_id, status, application_code);

-- Preserve the current behavior for stores that already exist. Newly created
-- stores are intentionally disabled until an organization manager configures
-- their app surface from Hub.
insert into public.store_application_access (organization_id, store_id, application_code, status)
select
  s.organization_id,
  s.id,
  applications.application_code,
  'ACTIVE'
from public.stores s
cross join (values ('PLAY'), ('POS'), ('KIOSK'), ('QUEUE')) as applications(application_code)
where s.status = 'ACTIVE'
on conflict (organization_id, store_id, application_code) do nothing;

create or replace function public.initialize_store_application_access()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.store_application_access (organization_id, store_id, application_code, status)
  select new.organization_id, new.id, applications.application_code, 'DISABLED'
  from (values ('PLAY'), ('POS'), ('KIOSK'), ('QUEUE')) as applications(application_code)
  on conflict (organization_id, store_id, application_code) do nothing;
  return new;
end;
$$;

drop trigger if exists stores_initialize_application_access on public.stores;
create trigger stores_initialize_application_access
after insert on public.stores
for each row
execute function public.initialize_store_application_access();

alter table public.store_application_access enable row level security;

revoke all on table public.store_application_access from public, anon, authenticated;
grant all on table public.store_application_access to service_role;

revoke all on function public.initialize_store_application_access() from public, anon, authenticated;
