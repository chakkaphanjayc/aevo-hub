-- Foreign-key checks and tenant cleanup need indexes whose leading columns
-- are the referenced keys. The user-scoped indexes remain the hot path for
-- listing a person's pins.
create index if not exists user_navigation_favorites_organization_fk_idx
  on public.user_navigation_favorites (organization_id);

create index if not exists user_navigation_favorites_store_fk_idx
  on public.user_navigation_favorites (store_id);

-- Keep SELECT isolated from write policies so Postgres does not combine two
-- permissive policies for every read. The scalar auth.uid() call also lets
-- PostgreSQL evaluate the current user once per statement instead of once per
-- row.
drop policy if exists user_navigation_favorites_read on public.user_navigation_favorites;
drop policy if exists user_navigation_favorites_manage on public.user_navigation_favorites;
drop policy if exists user_navigation_favorites_insert on public.user_navigation_favorites;
drop policy if exists user_navigation_favorites_update on public.user_navigation_favorites;
drop policy if exists user_navigation_favorites_delete on public.user_navigation_favorites;

create policy user_navigation_favorites_read on public.user_navigation_favorites
for select to authenticated
using (
  user_id = (select auth.uid())
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
          where m.user_id = (select auth.uid())
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
);

create policy user_navigation_favorites_insert on public.user_navigation_favorites
for insert to authenticated
with check (
  user_id = (select auth.uid())
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
          where m.user_id = (select auth.uid())
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
);

create policy user_navigation_favorites_update on public.user_navigation_favorites
for update to authenticated
using (
  user_id = (select auth.uid())
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
          where m.user_id = (select auth.uid())
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
)
with check (
  user_id = (select auth.uid())
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
          where m.user_id = (select auth.uid())
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
);

create policy user_navigation_favorites_delete on public.user_navigation_favorites
for delete to authenticated
using (
  user_id = (select auth.uid())
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
          where m.user_id = (select auth.uid())
            and m.organization_id = user_navigation_favorites.organization_id
            and m.status = 'ACTIVE'
            and ms.store_id = user_navigation_favorites.store_id
        )
      )
    )
  )
);
