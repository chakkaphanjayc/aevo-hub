-- Runtime payloads for validated import previews and export job results.
-- Source/result data is protected by the parent job RLS policies and is only
-- an interim transport until object storage workers are connected.

alter table public.query_import_jobs
  add column if not exists source_rows jsonb not null default '[]'::jsonb;

alter table public.query_export_jobs
  add column if not exists result_payload jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.query_import_jobs'::regclass
      and conname = 'query_import_jobs_source_rows_array_check'
  ) then
    alter table public.query_import_jobs
      add constraint query_import_jobs_source_rows_array_check
      check (jsonb_typeof(source_rows) = 'array');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.query_export_jobs'::regclass
      and conname = 'query_export_jobs_result_payload_object_check'
  ) then
    alter table public.query_export_jobs
      add constraint query_export_jobs_result_payload_object_check
      check (result_payload is null or jsonb_typeof(result_payload) = 'object');
  end if;
end;
$$;
