-- Keep store-scoped booking aggregates index-friendly when a venue is joined
-- back to its owning store.
create index if not exists venues_org_store_status_idx
  on public.venues (organization_id, store_id, status);
