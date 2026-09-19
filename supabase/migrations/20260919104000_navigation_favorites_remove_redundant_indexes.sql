-- The composite index covers both organization_id foreign-key checks and the
-- (organization_id, store_id) store-scope foreign key.
drop index if exists public.user_navigation_favorites_organization_fk_idx;
drop index if exists public.user_navigation_favorites_store_fk_idx;
