-- User-owned navigation pins are intentionally separate from tenant data.
-- The gateway validates every target against the caller's effective
-- organization/store permissions before writing a row. RLS below provides a
-- second line of defense for direct Supabase clients.
create table if not exists public.user_navigation_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  store_id uuid,
  kind text not null check (kind in ('ORGANIZATION', 'STORE', 'MENU')),
  target_key text not null check (length(trim(target_key)) between 1 and 160),
  label text not null check (length(trim(label)) between 1 and 160),
  href text not null check (length(trim(href)) between 1 and 500),
  icon_key text not null default 'pin' check (length(trim(icon_key)) between 1 and 64),
  position integer not null default 0 check (position >= 0 and position <= 10000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint user_navigation_favorites_store_scope_check check (
    (kind = 'MENU' and organization_id is null and store_id is null)
    or (kind = 'ORGANIZATION' and organization_id is not null and store_id is null)
    or (kind = 'STORE' and organization_id is not null and store_id is not null)
  ),
  constraint user_navigation_favorites_store_fk
    foreign key (organization_id, store_id)
    references public.stores(organization_id, id)
    on delete cascade,
  constraint user_navigation_favorites_target_unique unique (user_id, target_key)
);

create index if not exists user_navigation_favorites_user_position_idx
  on public.user_navigation_favorites (user_id, position, created_at);

create index if not exists user_navigation_favorites_org_idx
  on public.user_navigation_favorites (user_id, organization_id)
  where organization_id is not null;

create index if not exists user_navigation_favorites_store_idx
  on public.user_navigation_favorites (user_id, store_id)
  where store_id is not null;

drop trigger if exists user_navigation_favorites_set_updated_at on public.user_navigation_favorites;
create trigger user_navigation_favorites_set_updated_at
before update on public.user_navigation_favorites
for each row execute function public.set_updated_at();

alter table public.user_navigation_favorites enable row level security;
revoke all on table public.user_navigation_favorites from anon, authenticated;
grant select, insert, update, delete on table public.user_navigation_favorites to authenticated;

drop policy if exists user_navigation_favorites_read on public.user_navigation_favorites;
create policy user_navigation_favorites_read on public.user_navigation_favorites
for select to authenticated
using (
  user_id = auth.uid()
  and (
    organization_id is null
    or (
      private.is_org_member(organization_id)
      and (
        store_id is null
        or private.has_org_permission(organization_id, 'store.read')
        or exists (
          select 1
          from public.memberships m
          join public.membership_stores ms on ms.membership_id = m.id
          where m.user_id = auth.uid()
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
);

drop policy if exists user_navigation_favorites_manage on public.user_navigation_favorites;
create policy user_navigation_favorites_manage on public.user_navigation_favorites
for all to authenticated
using (
  user_id = auth.uid()
  and (
    organization_id is null
    or (
      private.is_org_member(organization_id)
      and (
        store_id is null
        or private.has_org_permission(organization_id, 'store.read')
        or exists (
          select 1
          from public.memberships m
          join public.membership_stores ms on ms.membership_id = m.id
          where m.user_id = auth.uid()
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
)
with check (
  user_id = auth.uid()
  and (
    organization_id is null
    or (
      private.is_org_member(organization_id)
      and (
        store_id is null
        or private.has_org_permission(organization_id, 'store.read')
        or exists (
          select 1
          from public.memberships m
          join public.membership_stores ms on ms.membership_id = m.id
          where m.user_id = auth.uid()
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
);

comment on table public.user_navigation_favorites is
  'Per-user, tenant-aware navigation pins. Targets are server-resolved by the gateway.';
