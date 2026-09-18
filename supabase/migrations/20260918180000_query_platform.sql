-- Aevo Universal Data Query Platform v1.
--
-- Query metadata describes canonical Aevo tables. User input is persisted as a
-- versioned Query AST, never as SQL. All definition and job tables remain
-- tenant-scoped and protected by RLS for direct Data API access.

insert into public.permissions (code, description) values
  ('query.read', 'Search and read queryable records'),
  ('query.manage', 'Create and share saved queries and templates'),
  ('query.import', 'Upload and import data through validated query metadata'),
  ('query.export', 'Export data through validated query metadata'),
  ('query.bulk_edit', 'Perform permission-checked bulk edits')
on conflict (code) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join public.permissions p
where r.code in ('OWNER', 'ADMIN')
  and p.code in ('query.read', 'query.manage', 'query.import', 'query.export', 'query.bulk_edit')
on conflict do nothing;

create table if not exists public.query_models (
  id uuid primary key default gen_random_uuid(),
  technical_name text not null unique check (technical_name ~ '^[a-z][a-z0-9_.-]{1,120}$'),
  table_name text not null unique check (table_name ~ '^[a-z][a-z0-9_]{1,120}$'),
  label text not null check (length(trim(label)) between 1 and 160),
  module text not null check (length(trim(module)) between 1 and 80),
  description text not null default '',
  tenant_scope text not null check (tenant_scope in ('ORGANIZATION', 'STORE', 'PLATFORM')),
  read_permission text not null default 'query.read',
  default_search_fields jsonb not null default '[]'::jsonb,
  default_order jsonb not null default '[]'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (jsonb_typeof(default_search_fields) = 'array'),
  check (jsonb_typeof(default_order) = 'array')
);

create table if not exists public.query_model_fields (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.query_models(id) on delete cascade,
  path text not null check (path ~ '^[a-z][a-z0-9_.-]{0,160}$'),
  label text not null check (length(trim(label)) between 1 and 160),
  field_type text not null check (field_type in (
    'char', 'text', 'integer', 'decimal', 'money', 'boolean', 'date', 'datetime', 'time',
    'selection', 'many2one', 'one2many', 'many2many', 'json', 'file', 'image', 'reference',
    'geo', 'duration', 'percentage', 'rating', 'color', 'phone', 'email'
  )),
  column_name text not null check (column_name ~ '^[a-z][a-z0-9_]{0,120}$'),
  relation_model text,
  relation_path text,
  capabilities jsonb not null default '{"search":false,"filter":false,"sort":false,"group":false,"export":false,"import":false}'::jsonb,
  operators jsonb not null default '[]'::jsonb,
  read_permission text,
  write_permission text,
  sequence integer not null default 0 check (sequence >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (model_id, path),
  check (jsonb_typeof(capabilities) = 'object'),
  check (jsonb_typeof(operators) = 'array')
);

create table if not exists public.query_saved_queries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  model text not null references public.query_models(technical_name) on delete restrict,
  scope text not null check (scope in ('PRIVATE', 'TEAM', 'STORE', 'ORGANIZATION', 'SYSTEM')),
  query_definition jsonb not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, owner_user_id, name),
  foreign key (organization_id, store_id)
    references public.stores(organization_id, id) on delete cascade,
  check (jsonb_typeof(query_definition) = 'object'),
  check (scope <> 'STORE' or store_id is not null),
  check (scope <> 'SYSTEM' or owner_user_id is not null)
);

create table if not exists public.query_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  model text not null references public.query_models(technical_name) on delete restrict,
  query_definition jsonb not null,
  result_count integer not null default 0 check (result_count >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (organization_id, store_id)
    references public.stores(organization_id, id) on delete cascade
);

create table if not exists public.query_import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid,
  created_by uuid not null references auth.users(id) on delete cascade,
  model text not null references public.query_models(technical_name) on delete restrict,
  status text not null default 'UPLOADED' check (status in ('UPLOADED', 'ANALYZING', 'MAPPING', 'VALIDATING', 'READY', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  source_object_path text,
  source_file_name text not null check (length(trim(source_file_name)) between 1 and 255),
  source_content_type text,
  idempotency_key text not null check (length(trim(idempotency_key)) between 8 and 200),
  total_rows integer not null default 0 check (total_rows >= 0),
  valid_rows integer not null default 0 check (valid_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  processed_rows integer not null default 0 check (processed_rows >= 0),
  query_definition jsonb,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  unique (organization_id, idempotency_key),
  foreign key (organization_id, store_id)
    references public.stores(organization_id, id) on delete cascade,
  check (query_definition is null or jsonb_typeof(query_definition) = 'object')
);

create table if not exists public.query_import_columns (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.query_import_jobs(id) on delete cascade,
  column_index integer not null check (column_index >= 0),
  source_name text not null check (length(trim(source_name)) between 1 and 255),
  inferred_type text,
  sample_values jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (job_id, column_index),
  check (jsonb_typeof(sample_values) = 'array')
);

create table if not exists public.query_import_mappings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.query_import_jobs(id) on delete cascade,
  source_column_id uuid not null references public.query_import_columns(id) on delete cascade,
  field_path text not null,
  confidence numeric(5, 4) check (confidence is null or confidence between 0 and 1),
  transform_definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (job_id, source_column_id),
  check (jsonb_typeof(transform_definition) = 'object')
);

create table if not exists public.query_import_errors (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.query_import_jobs(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  field_path text,
  error_code text not null,
  message text not null,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  check (jsonb_typeof(source_data) = 'object')
);

create table if not exists public.query_export_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid,
  created_by uuid not null references auth.users(id) on delete cascade,
  model text not null references public.query_models(technical_name) on delete restrict,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  query_definition jsonb not null,
  selected_fields jsonb not null default '[]'::jsonb,
  format text not null default 'CSV' check (format in ('CSV', 'JSON', 'XLSX')),
  output_object_path text,
  total_rows integer not null default 0 check (total_rows >= 0),
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  foreign key (organization_id, store_id)
    references public.stores(organization_id, id) on delete cascade,
  check (jsonb_typeof(query_definition) = 'object'),
  check (jsonb_typeof(selected_fields) = 'array')
);

create table if not exists public.query_export_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id uuid,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  model text not null references public.query_models(technical_name) on delete restrict,
  scope text not null check (scope in ('PRIVATE', 'TEAM', 'STORE', 'ORGANIZATION', 'SYSTEM')),
  query_definition jsonb not null,
  selected_fields jsonb not null default '[]'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, owner_user_id, name),
  foreign key (organization_id, store_id)
    references public.stores(organization_id, id) on delete cascade,
  check (jsonb_typeof(query_definition) = 'object'),
  check (jsonb_typeof(selected_fields) = 'array'),
  check (scope <> 'STORE' or store_id is not null)
);

create index if not exists query_models_status_idx on public.query_models(status, technical_name);
create index if not exists query_model_fields_model_sequence_idx on public.query_model_fields(model_id, sequence, path);
create index if not exists query_saved_queries_org_scope_idx on public.query_saved_queries(organization_id, scope, status, updated_at desc);
create index if not exists query_history_org_created_idx on public.query_history(organization_id, created_at desc);
create index if not exists query_import_jobs_status_idx on public.query_import_jobs(organization_id, status, created_at desc);
create index if not exists query_import_errors_job_idx on public.query_import_errors(job_id, row_number);
create index if not exists query_export_jobs_status_idx on public.query_export_jobs(organization_id, status, created_at desc);
create index if not exists query_export_templates_org_scope_idx on public.query_export_templates(organization_id, scope, status, updated_at desc);

drop trigger if exists query_models_set_updated_at on public.query_models;
create trigger query_models_set_updated_at before update on public.query_models for each row execute function public.set_updated_at();
drop trigger if exists query_model_fields_set_updated_at on public.query_model_fields;
create trigger query_model_fields_set_updated_at before update on public.query_model_fields for each row execute function public.set_updated_at();
drop trigger if exists query_saved_queries_set_updated_at on public.query_saved_queries;
create trigger query_saved_queries_set_updated_at before update on public.query_saved_queries for each row execute function public.set_updated_at();
drop trigger if exists query_import_jobs_set_updated_at on public.query_import_jobs;
create trigger query_import_jobs_set_updated_at before update on public.query_import_jobs for each row execute function public.set_updated_at();
drop trigger if exists query_export_jobs_set_updated_at on public.query_export_jobs;
create trigger query_export_jobs_set_updated_at before update on public.query_export_jobs for each row execute function public.set_updated_at();
drop trigger if exists query_export_templates_set_updated_at on public.query_export_templates;
create trigger query_export_templates_set_updated_at before update on public.query_export_templates for each row execute function public.set_updated_at();

insert into public.query_models (technical_name, table_name, label, module, description, tenant_scope, read_permission, default_search_fields, default_order, status)
values
  ('product.product', 'products', 'Products', 'catalog', 'Organization catalog products', 'ORGANIZATION', 'catalog.read', '["name", "sku", "description"]'::jsonb, '[{"field":"name","direction":"asc"}]'::jsonb, 'ACTIVE'),
  ('sale.order', 'orders', 'Orders', 'ordering', 'Unified POS, QR, kiosk, pickup, and staff orders', 'STORE', 'order.read', '["order_number", "customer_name", "customer_phone", "customer_email"]'::jsonb, '[{"field":"created_at","direction":"desc"}]'::jsonb, 'ACTIVE'),
  ('res.store', 'stores', 'Stores', 'workspace', 'Organization operating locations', 'ORGANIZATION', 'store.read', '["name", "code"]'::jsonb, '[{"field":"name","direction":"asc"}]'::jsonb, 'ACTIVE')
on conflict (technical_name) do update set
  table_name = excluded.table_name,
  label = excluded.label,
  module = excluded.module,
  description = excluded.description,
  tenant_scope = excluded.tenant_scope,
  read_permission = excluded.read_permission,
  default_search_fields = excluded.default_search_fields,
  default_order = excluded.default_order,
  status = excluded.status,
  updated_at = timezone('utc', now());

insert into public.query_model_fields (model_id, path, label, field_type, column_name, capabilities, operators, sequence)
select m.id, v.path, v.label, v.field_type, v.column_name, v.capabilities, v.operators, v.sequence
from public.query_models m
join (values
  ('product.product', 'sku', 'SKU', 'char', 'sku', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","neq","starts_with","ends_with"]'::jsonb, 1),
  ('product.product', 'name', 'Name', 'char', 'name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","neq","starts_with","ends_with"]'::jsonb, 2),
  ('product.product', 'description', 'Description', 'text', 'description', '{"search":true,"filter":true,"sort":false,"group":false,"export":true,"import":true}'::jsonb, '["contains","not_contains","is_empty","is_not_empty"]'::jsonb, 3),
  ('product.product', 'base_price_minor', 'Price', 'money', 'base_price_minor', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":true}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, 4),
  ('product.product', 'currency', 'Currency', 'char', 'currency', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 5),
  ('product.product', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 6),
  ('product.product', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between"]'::jsonb, 7),
  ('sale.order', 'order_number', 'Order number', 'char', 'order_number', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 1),
  ('sale.order', 'customer_name', 'Customer name', 'char', 'customer_name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","is_empty","is_not_empty"]'::jsonb, 2),
  ('sale.order', 'customer_phone', 'Customer phone', 'phone', 'customer_phone', '{"search":true,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 3),
  ('sale.order', 'customer_email', 'Customer email', 'email', 'customer_email', '{"search":true,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 4),
  ('sale.order', 'store_id', 'Store', 'many2one', 'store_id', '{"search":false,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 5),
  ('sale.order', 'channel', 'Channel', 'selection', 'channel', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 6),
  ('sale.order', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 7),
  ('sale.order', 'payment_status', 'Payment status', 'selection', 'payment_status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 8),
  ('sale.order', 'total_minor', 'Total', 'money', 'total_minor', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, 9),
  ('sale.order', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between"]'::jsonb, 10),
  ('res.store', 'code', 'Code', 'char', 'code', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 1),
  ('res.store', 'name', 'Name', 'char', 'name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 2),
  ('res.store', 'timezone', 'Timezone', 'char', 'timezone', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["eq","neq","contains"]'::jsonb, 3),
  ('res.store', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 4),
  ('res.store', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between"]'::jsonb, 5)
) as v(model_name, path, label, field_type, column_name, capabilities, operators, sequence)
  on v.model_name = m.technical_name
on conflict (model_id, path) do update set
  label = excluded.label,
  field_type = excluded.field_type,
  column_name = excluded.column_name,
  capabilities = excluded.capabilities,
  operators = excluded.operators,
  sequence = excluded.sequence,
  updated_at = timezone('utc', now());

alter table public.query_models enable row level security;
alter table public.query_model_fields enable row level security;
alter table public.query_saved_queries enable row level security;
alter table public.query_history enable row level security;
alter table public.query_import_jobs enable row level security;
alter table public.query_import_columns enable row level security;
alter table public.query_import_mappings enable row level security;
alter table public.query_import_errors enable row level security;
alter table public.query_export_jobs enable row level security;
alter table public.query_export_templates enable row level security;

drop policy if exists query_models_authenticated_read on public.query_models;
create policy query_models_authenticated_read on public.query_models
for select to authenticated using (status = 'ACTIVE');
drop policy if exists query_model_fields_authenticated_read on public.query_model_fields;
create policy query_model_fields_authenticated_read on public.query_model_fields
for select to authenticated using (exists (select 1 from public.query_models m where m.id = model_id and m.status = 'ACTIVE'));

drop policy if exists query_saved_queries_read on public.query_saved_queries;
create policy query_saved_queries_read on public.query_saved_queries
for select to authenticated using (
  owner_user_id = auth.uid()
  or scope = 'SYSTEM'
  or (private.is_org_member(organization_id) and (
    scope in ('TEAM', 'ORGANIZATION')
    or (scope = 'STORE' and (
      private.has_org_permission(organization_id, 'store.read')
      or exists (
        select 1 from public.memberships m
        join public.membership_stores ms on ms.membership_id = m.id
        where m.organization_id = query_saved_queries.organization_id
          and m.user_id = auth.uid()
          and m.status = 'ACTIVE'
          and ms.store_id = query_saved_queries.store_id
      )
    ))
  ))
);
drop policy if exists query_saved_queries_manage on public.query_saved_queries;
create policy query_saved_queries_manage on public.query_saved_queries
for all to authenticated using (
  owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage')
)
with check (
  private.is_org_member(organization_id)
  and (owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage'))
);

drop policy if exists query_history_owner_read on public.query_history;
create policy query_history_owner_read on public.query_history
for select to authenticated using (user_id = auth.uid() or private.is_org_member(organization_id));

drop policy if exists query_import_jobs_read on public.query_import_jobs;
create policy query_import_jobs_read on public.query_import_jobs
for select to authenticated using (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.import'));
drop policy if exists query_import_jobs_manage on public.query_import_jobs;
create policy query_import_jobs_manage on public.query_import_jobs
for all to authenticated using (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.import'))
with check (private.is_org_member(organization_id) and (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.import')));

drop policy if exists query_import_columns_read on public.query_import_columns;
create policy query_import_columns_read on public.query_import_columns
for select to authenticated using (exists (select 1 from public.query_import_jobs j where j.id = job_id and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))));
drop policy if exists query_import_columns_manage on public.query_import_columns;
create policy query_import_columns_manage on public.query_import_columns
for all to authenticated using (exists (select 1 from public.query_import_jobs j where j.id = job_id and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))))
with check (exists (select 1 from public.query_import_jobs j where j.id = job_id and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))));

drop policy if exists query_import_mappings_read on public.query_import_mappings;
create policy query_import_mappings_read on public.query_import_mappings
for select to authenticated using (exists (select 1 from public.query_import_jobs j where j.id = job_id and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))));
drop policy if exists query_import_mappings_manage on public.query_import_mappings;
create policy query_import_mappings_manage on public.query_import_mappings
for all to authenticated using (exists (select 1 from public.query_import_jobs j where j.id = job_id and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))))
with check (exists (select 1 from public.query_import_jobs j where j.id = job_id and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))));

drop policy if exists query_import_errors_read on public.query_import_errors;
create policy query_import_errors_read on public.query_import_errors
for select to authenticated using (exists (select 1 from public.query_import_jobs j where j.id = job_id and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))));

drop policy if exists query_export_jobs_read on public.query_export_jobs;
create policy query_export_jobs_read on public.query_export_jobs
for select to authenticated using (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.export'));
drop policy if exists query_export_jobs_manage on public.query_export_jobs;
create policy query_export_jobs_manage on public.query_export_jobs
for all to authenticated using (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.export'))
with check (private.is_org_member(organization_id) and (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.export')));

drop policy if exists query_export_templates_read on public.query_export_templates;
create policy query_export_templates_read on public.query_export_templates
for select to authenticated using (owner_user_id = auth.uid() or scope = 'SYSTEM' or (private.is_org_member(organization_id) and scope in ('TEAM', 'ORGANIZATION', 'STORE')));
drop policy if exists query_export_templates_manage on public.query_export_templates;
create policy query_export_templates_manage on public.query_export_templates
for all to authenticated using (owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage'))
with check (private.is_org_member(organization_id) and (owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage')));

grant select on public.query_models, public.query_model_fields to authenticated;
grant select, insert, update, delete on
  public.query_saved_queries,
  public.query_history,
  public.query_import_jobs,
  public.query_import_columns,
  public.query_import_mappings,
  public.query_import_errors,
  public.query_export_jobs,
  public.query_export_templates
to authenticated;
grant all on
  public.query_models,
  public.query_model_fields,
  public.query_saved_queries,
  public.query_history,
  public.query_import_jobs,
  public.query_import_columns,
  public.query_import_mappings,
  public.query_import_errors,
  public.query_export_jobs,
  public.query_export_templates
to service_role;
