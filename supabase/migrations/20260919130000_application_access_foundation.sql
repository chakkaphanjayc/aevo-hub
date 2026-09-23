-- Aevocado application-boundary foundation.
--
-- `public.apps` remains the commercial catalog used for subscriptions and
-- entitlements. This registry is a server-only runtime/application registry:
-- it owns app codes, app-scoped sessions, and organization-member assignments.
-- The trusted gateway uses the service role for these tables; no browser or
-- publishable-key client should read them directly.

create table if not exists public.application_registry (
  code text primary key check (code in ('HUB', 'ADMIN', 'PLAY', 'POS', 'KIOSK', 'QUEUE', 'GO')),
  name text not null check (length(trim(name)) between 1 and 120),
  kind text not null check (kind in ('CONTROL_PLANE', 'PLATFORM_ADMIN', 'OPERATIONS', 'CONSUMER')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.application_registry (code, name, kind)
values
  ('HUB', 'Aevo Hub', 'CONTROL_PLANE'),
  ('ADMIN', 'Aevo Admin', 'PLATFORM_ADMIN'),
  ('PLAY', 'Aevo Play', 'CONSUMER'),
  ('POS', 'Aevo POS', 'OPERATIONS'),
  ('KIOSK', 'Aevo Kiosk', 'OPERATIONS'),
  ('QUEUE', 'Aevo Queue', 'OPERATIONS'),
  ('GO', 'Aevo Go', 'CONSUMER')
on conflict (code) do update set
  name = excluded.name,
  kind = excluded.kind,
  updated_at = timezone('utc', now());

-- Sessions are application-scoped. Existing Hub sessions are explicitly
-- backfilled before the column becomes mandatory, preserving rollback safety.
alter table public.app_sessions
  add column if not exists app_code text;

update public.app_sessions
set app_code = 'HUB'
where app_code is null;

alter table public.app_sessions
  alter column app_code set default 'HUB',
  alter column app_code set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'app_sessions_app_code_fkey'
      and conrelid = 'public.app_sessions'::regclass
  ) then
    alter table public.app_sessions
      add constraint app_sessions_app_code_fkey
      foreign key (app_code) references public.application_registry(code)
      on update cascade on delete restrict;
  end if;
end;
$$;

create index if not exists app_sessions_app_code_active_idx
  on public.app_sessions (app_code, user_id, revoked_at, absolute_expires_at);

-- An assignment grants a member entry to one first-party application. The
-- existing membership role remains the organization RBAC source of truth;
-- optional app roles/scopes narrow the application boundary further.
create table if not exists public.member_app_assignments (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.memberships(id) on delete cascade,
  application_code text not null references public.application_registry(code) on update cascade on delete restrict,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  starts_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (membership_id, application_code),
  check (expires_at is null or expires_at > starts_at)
);

-- Existing organization members already have access to the Hub control plane.
-- Backfill that compatibility assignment; future application access remains
-- explicit and must be granted by the server-side membership workflow.
insert into public.member_app_assignments (membership_id, application_code, status)
select m.id, 'HUB', 'ACTIVE'
from public.memberships m
where m.status = 'ACTIVE'
on conflict (membership_id, application_code) do nothing;

-- Keep the compatibility Hub assignment present for memberships created after
-- this migration. Other application assignments remain explicit grants.
create or replace function public.assign_default_hub_application()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'ACTIVE' then
    insert into public.member_app_assignments (membership_id, application_code, status)
    values (new.id, 'HUB', 'ACTIVE')
    on conflict (membership_id, application_code) do update
      set status = 'ACTIVE', updated_at = timezone('utc', now());
  end if;
  return new;
end;
$$;

drop trigger if exists memberships_default_hub_application on public.memberships;
create trigger memberships_default_hub_application
after insert or update of status on public.memberships
for each row
when (new.status = 'ACTIVE')
execute function public.assign_default_hub_application();

create table if not exists public.member_app_scopes (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.member_app_assignments(id) on delete cascade,
  scope_type text not null check (scope_type in ('ORGANIZATION', 'STORE', 'RESOURCE', 'DEVICE_GROUP')),
  scope_ref text not null check (length(trim(scope_ref)) between 1 and 160),
  created_at timestamptz not null default timezone('utc', now()),
  unique (assignment_id, scope_type, scope_ref)
);

create table if not exists public.member_app_roles (
  assignment_id uuid not null references public.member_app_assignments(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (assignment_id, role_id)
);

create index if not exists member_app_assignments_lookup_idx
  on public.member_app_assignments (membership_id, application_code, status, starts_at, expires_at);
create index if not exists member_app_assignments_application_idx
  on public.member_app_assignments (application_code, status, expires_at);
create index if not exists member_app_scopes_lookup_idx
  on public.member_app_scopes (assignment_id, scope_type, scope_ref);
create index if not exists member_app_roles_lookup_idx
  on public.member_app_roles (assignment_id, role_id);

-- These are intentionally server-only tables. RLS is enabled as defense in
-- depth, while the trusted API boundary receives the only table grants.
alter table public.application_registry enable row level security;
alter table public.member_app_assignments enable row level security;
alter table public.member_app_scopes enable row level security;
alter table public.member_app_roles enable row level security;

revoke all on table public.application_registry from public, anon, authenticated;
revoke all on table public.member_app_assignments from public, anon, authenticated;
revoke all on table public.member_app_scopes from public, anon, authenticated;
revoke all on table public.member_app_roles from public, anon, authenticated;

grant all on table public.application_registry to service_role;
grant all on table public.member_app_assignments to service_role;
grant all on table public.member_app_scopes to service_role;
grant all on table public.member_app_roles to service_role;
