create index if not exists user_navigation_favorites_organization_store_fk_idx
  on public.user_navigation_favorites (organization_id, store_id);
