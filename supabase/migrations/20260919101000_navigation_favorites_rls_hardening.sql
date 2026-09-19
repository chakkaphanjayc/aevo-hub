-- Keep direct Supabase writes aligned with the gateway's tenant and store
-- access checks. The gateway remains authoritative for server-resolved hrefs,
-- while this policy prevents a client from pinning a store it cannot access.
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
