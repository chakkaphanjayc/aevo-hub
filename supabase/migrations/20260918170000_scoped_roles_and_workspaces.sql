-- Migration: Scoped Roles, Store Members, and Invitations Model
-- Refactors workspace context hierarchy into explicit Scoped RBAC:
-- OWNER (Org scope, exclusive delete/transfer) -> ORGANIZATION_MANAGER (Org scope) -> STORE_MANAGER (Store scope) -> STAFF (Store operational scope)
-- Workspace remains an Operating Scope / UI Context, NOT a database entity.

-- 1. Extend roles check constraint and add scope_type
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'roles_code_check' and conrelid = 'public.roles'::regclass
  ) then
    alter table public.roles drop constraint roles_code_check;
  end if;
end;
$$;

alter table public.roles
  add constraint roles_code_check
  check (code in (
    'OWNER', 'ADMIN', 'ORGANIZATION_MANAGER', 'BRANCH_MANAGER', 'STORE_MANAGER',
    'CASHIER', 'KITCHEN', 'BOOKING_STAFF', 'KIOSK_STAFF', 'STAFF', 'VIEWER'
  ));

alter table public.roles
  add column if not exists scope_type text not null default 'STORE'
  check (scope_type in ('PLATFORM', 'ORGANIZATION', 'STORE'));

-- Update existing scope_types
update public.roles set scope_type = 'ORGANIZATION' where code in ('OWNER', 'ADMIN');
update public.roles set scope_type = 'STORE' where code not in ('OWNER', 'ADMIN');

-- Insert newly introduced scoped system roles
insert into public.roles (code, name, scope_type, is_system)
values
  ('ORGANIZATION_MANAGER', 'Organization Manager', 'ORGANIZATION', true),
  ('STORE_MANAGER', 'Store Manager', 'STORE', true),
  ('BOOKING_STAFF', 'Booking Staff', 'STORE', true),
  ('KIOSK_STAFF', 'Kiosk Staff', 'STORE', true)
on conflict (code) do update set
  scope_type = excluded.scope_type,
  name = excluded.name;

-- 2. Organizations owner tracking
alter table public.organizations
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

-- Backfill owner_user_id from existing OWNER memberships
update public.organizations o
set owner_user_id = (
  select m.user_id
  from public.memberships m
  join public.roles r on m.role_id = r.id
  where m.organization_id = o.id and r.code = 'OWNER'
  order by m.created_at asc
  limit 1
)
where o.owner_user_id is null;

-- 3. Store Members Table (Scope: Store)
create table if not exists public.store_members (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  status text not null default 'ACTIVE' check (status in ('INVITED', 'ACTIVE', 'SUSPENDED')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (store_id, user_id, role_id)
);

-- Backfill store_members from existing membership_stores
insert into public.store_members (store_id, user_id, role_id, status, joined_at)
select
  ms.store_id,
  m.user_id,
  m.role_id,
  m.status,
  m.created_at
from public.membership_stores ms
join public.memberships m on ms.membership_id = m.id
on conflict (store_id, user_id, role_id) do nothing;

-- 4. Invitations Table (Hierarchical Scope Model)
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  email text not null check (length(email) between 3 and 320),
  role_id uuid not null references public.roles(id) on delete restrict,
  scope_type text not null check (scope_type in ('ORGANIZATION', 'STORE')),
  scope_id uuid not null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  expires_at timestamptz not null default (timezone('utc', now()) + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Index for rapid invitation queries
create index if not exists idx_invitations_org on public.invitations(organization_id, status);
create index if not exists idx_invitations_email on public.invitations(email, status);
create index if not exists idx_store_members_lookup on public.store_members(store_id, user_id);

-- 5. Canonical View: organization_members
create or replace view public.organization_members as
select
  id,
  organization_id,
  user_id,
  role_id,
  status,
  created_at as joined_at,
  updated_at
from public.memberships;

-- 6. Permissions & Grants
grant all on public.store_members to authenticated, service_role;
grant all on public.invitations to authenticated, service_role;
grant select on public.organization_members to authenticated, service_role;
