-- Prevent accidental reuse of an idempotency key for a different request.
-- Existing jobs remain readable; new submissions persist a canonical payload
-- fingerprint and the gateway rejects key/payload mismatches.

alter table public.query_import_jobs
  add column if not exists request_fingerprint text;

alter table public.query_export_jobs
  add column if not exists request_fingerprint text;

create index if not exists query_import_jobs_org_fingerprint_idx
  on public.query_import_jobs(organization_id, request_fingerprint)
  where request_fingerprint is not null;

create index if not exists query_export_jobs_org_fingerprint_idx
  on public.query_export_jobs(organization_id, request_fingerprint)
  where request_fingerprint is not null;
