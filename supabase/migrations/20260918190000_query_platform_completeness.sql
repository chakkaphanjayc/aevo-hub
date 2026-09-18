-- Complete the Query Platform metadata contract for the canonical commerce,
-- inventory, and booking surfaces. This migration is additive and preserves
-- all existing query definitions and jobs.

create table if not exists public.query_model_views (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.query_models(id) on delete cascade,
  view_key text not null check (view_key ~ '^[a-z][a-z0-9_.-]{0,80}$'),
  label text not null check (length(trim(label)) between 1 and 160),
  view_type text not null check (view_type in ('LIST', 'KANBAN', 'PIVOT', 'CHART')),
  columns jsonb not null default '[]'::jsonb,
  default_order jsonb not null default '[]'::jsonb,
  default_group_by jsonb not null default '[]'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (model_id, view_key),
  check (jsonb_typeof(columns) = 'array'),
  check (jsonb_typeof(default_order) = 'array'),
  check (jsonb_typeof(default_group_by) = 'array')
);

create table if not exists public.query_search_definitions (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.query_models(id) on delete cascade,
  definition_key text not null check (definition_key ~ '^[a-z][a-z0-9_.-]{0,80}$'),
  label text not null check (length(trim(label)) between 1 and 160),
  default_search_fields jsonb not null default '[]'::jsonb,
  default_order jsonb not null default '[]'::jsonb,
  operator_overrides jsonb not null default '{}'::jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  is_system boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (model_id, definition_key),
  check (jsonb_typeof(default_search_fields) = 'array'),
  check (jsonb_typeof(default_order) = 'array'),
  check (jsonb_typeof(operator_overrides) = 'object')
);

create index if not exists query_model_views_active_idx
  on public.query_model_views(model_id, status, view_key);
create index if not exists query_search_definitions_active_idx
  on public.query_search_definitions(model_id, status, definition_key);

drop trigger if exists query_model_views_set_updated_at on public.query_model_views;
create trigger query_model_views_set_updated_at
before update on public.query_model_views
for each row execute function public.set_updated_at();
drop trigger if exists query_search_definitions_set_updated_at on public.query_search_definitions;
create trigger query_search_definitions_set_updated_at
before update on public.query_search_definitions
for each row execute function public.set_updated_at();

alter table public.query_model_views enable row level security;
alter table public.query_search_definitions enable row level security;

drop policy if exists query_model_views_authenticated_read on public.query_model_views;
create policy query_model_views_authenticated_read on public.query_model_views
for select to authenticated using (
  status = 'ACTIVE'
  and exists (select 1 from public.query_models m where m.id = model_id and m.status = 'ACTIVE')
);
drop policy if exists query_search_definitions_authenticated_read on public.query_search_definitions;
create policy query_search_definitions_authenticated_read on public.query_search_definitions
for select to authenticated using (
  status = 'ACTIVE'
  and exists (select 1 from public.query_models m where m.id = model_id and m.status = 'ACTIVE')
);
grant select on public.query_model_views, public.query_search_definitions to authenticated;
grant all on public.query_model_views, public.query_search_definitions to service_role;

alter table public.query_import_jobs
  add column if not exists attempt_count integer not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists processing_started_at timestamptz;

alter table public.query_export_jobs
  add column if not exists idempotency_key text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists processed_rows integer not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists processing_started_at timestamptz;

create unique index if not exists query_export_jobs_org_idempotency_idx
  on public.query_export_jobs(organization_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists query_import_jobs_worker_idx
  on public.query_import_jobs(status, next_attempt_at, created_at);
create index if not exists query_export_jobs_worker_idx
  on public.query_export_jobs(status, next_attempt_at, created_at);

insert into public.query_models (
  technical_name, table_name, label, module, description, tenant_scope,
  read_permission, default_search_fields, default_order, status
)
values
  ('product.variant', 'product_variants', 'Product Variants', 'catalog', 'Sellable product variants', 'ORGANIZATION', 'catalog.read', '[]'::jsonb, '[{"field":"sort_order","direction":"asc"}]'::jsonb, 'ACTIVE'),
  ('inventory.item', 'inventory_items', 'Inventory Items', 'inventory', 'Store-scoped inventory balances', 'STORE', 'catalog.read', '["sku", "name", "unit"]'::jsonb, '[{"field":"name","direction":"asc"}]'::jsonb, 'ACTIVE'),
  ('booking.venue', 'venues', 'Booking Venues', 'booking', 'Bookable venues attached to operating stores', 'STORE', 'booking.manage', '["name", "slug", "description"]'::jsonb, '[{"field":"name","direction":"asc"}]'::jsonb, 'ACTIVE')
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

insert into public.query_model_fields (
  model_id, path, label, field_type, column_name, relation_model,
  relation_path, capabilities, operators, read_permission, write_permission, sequence
)
select m.id, v.path, v.label, v.field_type, v.column_name, v.relation_model,
  v.relation_path, v.capabilities, v.operators, v.read_permission, v.write_permission, v.sequence
from public.query_models m
join (values
  ('product.variant', 'code', 'Code', 'char', 'code', null::text, null::text, '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","neq","starts_with"]'::jsonb, null::text, 'catalog.manage'::text, 1),
  ('product.variant', 'name', 'Name', 'char', 'name', null::text, null::text, '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","neq","starts_with"]'::jsonb, null::text, 'catalog.manage'::text, 2),
  ('product.variant', 'price_minor', 'Price', 'money', 'price_minor', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":true,"aggregate":true}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, null::text, 'price.override'::text, 3),
  ('product.variant', 'sort_order', 'Sort order', 'integer', 'sort_order', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":true}'::jsonb, '["eq","neq","gt","gte","lt","lte"]'::jsonb, null::text, 'catalog.manage'::text, 4),
  ('product.variant', 'status', 'Status', 'selection', 'status', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, null::text, null::text, 5),
  ('product.variant', 'created_at', 'Created', 'datetime', 'created_at', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, null::text, null::text, 6),
  ('inventory.item', 'sku', 'SKU', 'char', 'sku', null::text, null::text, '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","neq","starts_with"]'::jsonb, null::text, 'catalog.manage'::text, 1),
  ('inventory.item', 'name', 'Name', 'char', 'name', null::text, null::text, '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","neq","starts_with"]'::jsonb, null::text, 'catalog.manage'::text, 2),
  ('inventory.item', 'unit', 'Unit', 'char', 'unit', null::text, null::text, '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","neq","starts_with"]'::jsonb, null::text, 'catalog.manage'::text, 3),
  ('inventory.item', 'quantity_on_hand', 'Quantity on hand', 'decimal', 'quantity_on_hand', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":true,"aggregate":true}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, null::text, 'catalog.manage'::text, 4),
  ('inventory.item', 'reorder_point', 'Reorder point', 'decimal', 'reorder_point', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":true,"aggregate":true}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, null::text, 'catalog.manage'::text, 5),
  ('inventory.item', 'cost_per_unit_minor', 'Cost per unit', 'money', 'cost_per_unit_minor', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":true,"aggregate":true}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, 'price.override'::text, 'price.override'::text, 6),
  ('inventory.item', 'store_id', 'Store', 'many2one', 'store_id', null::text, null::text, '{"search":false,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, null::text, null::text, 7),
  ('inventory.item', 'updated_at', 'Updated', 'datetime', 'updated_at', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, null::text, null::text, 8),
  ('booking.venue', 'name', 'Name', 'char', 'name', null::text, null::text, '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq","starts_with"]'::jsonb, null::text, null::text, 1),
  ('booking.venue', 'slug', 'Slug', 'char', 'slug', null::text, null::text, '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq","starts_with"]'::jsonb, null::text, null::text, 2),
  ('booking.venue', 'description', 'Description', 'text', 'description', null::text, null::text, '{"search":true,"filter":true,"sort":false,"group":false,"export":true,"import":false}'::jsonb, '["contains","not_contains","is_empty","is_not_empty"]'::jsonb, null::text, null::text, 3),
  ('booking.venue', 'store_id', 'Store', 'many2one', 'store_id', null::text, null::text, '{"search":false,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, null::text, null::text, 4),
  ('booking.venue', 'timezone', 'Timezone', 'char', 'timezone', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","contains"]'::jsonb, null::text, null::text, 5),
  ('booking.venue', 'slot_duration_minutes', 'Slot duration', 'integer', 'slot_duration_minutes', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","gt","gte","lt","lte"]'::jsonb, null::text, null::text, 6),
  ('booking.venue', 'status', 'Status', 'selection', 'status', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, null::text, null::text, 7),
  ('booking.venue', 'created_at', 'Created', 'datetime', 'created_at', null::text, null::text, '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, null::text, null::text, 8)
) as v(model_name, path, label, field_type, column_name, relation_model, relation_path, capabilities, operators, read_permission, write_permission, sequence)
on v.model_name = m.technical_name
on conflict (model_id, path) do update set
  label = excluded.label,
  field_type = excluded.field_type,
  column_name = excluded.column_name,
  relation_model = excluded.relation_model,
  relation_path = excluded.relation_path,
  capabilities = excluded.capabilities,
  operators = excluded.operators,
  read_permission = excluded.read_permission,
  write_permission = excluded.write_permission,
  sequence = excluded.sequence,
  updated_at = timezone('utc', now());

insert into public.query_model_relations (
  model_id, path, related_model, related_table, embed_name,
  source_column, target_column, foreign_key, cardinality
)
select m.id, v.path, v.related_model, v.related_table, v.embed_name,
  v.source_column, v.target_column, v.foreign_key, v.cardinality
from public.query_models m
join (values
  ('product.variant', 'product', 'product.product', 'products', 'product', 'product_id', 'id', 'product_variants_organization_id_product_id_fkey', 'many_to_one'),
  ('inventory.item', 'store', 'res.store', 'stores', 'store', 'store_id', 'id', 'inventory_items_organization_id_store_id_fkey', 'many_to_one'),
  ('booking.venue', 'store', 'res.store', 'stores', 'store', 'store_id', 'id', 'venues_store_id_fkey', 'many_to_one')
) as v(model_name, path, related_model, related_table, embed_name, source_column, target_column, foreign_key, cardinality)
on v.model_name = m.technical_name
on conflict (model_id, path) do update set
  related_model = excluded.related_model,
  related_table = excluded.related_table,
  embed_name = excluded.embed_name,
  source_column = excluded.source_column,
  target_column = excluded.target_column,
  foreign_key = excluded.foreign_key,
  cardinality = excluded.cardinality,
  updated_at = timezone('utc', now());

insert into public.query_model_fields (
  model_id, path, label, field_type, column_name, relation_model,
  relation_path, capabilities, operators, sequence
)
select m.id, v.path, v.label, v.field_type, v.column_name, v.relation_model,
  v.relation_path, v.capabilities, v.operators, v.sequence
from public.query_models m
join (values
  ('product.variant', 'product.name', 'Product name', 'char', 'name', 'product.product', 'product', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 7),
  ('inventory.item', 'store.name', 'Store name', 'char', 'name', 'res.store', 'store', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 9),
  ('booking.venue', 'store.name', 'Store name', 'char', 'name', 'res.store', 'store', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 9)
) as v(model_name, path, label, field_type, column_name, relation_model, relation_path, capabilities, operators, sequence)
on v.model_name = m.technical_name
on conflict (model_id, path) do update set
  label = excluded.label,
  field_type = excluded.field_type,
  column_name = excluded.column_name,
  relation_model = excluded.relation_model,
  relation_path = excluded.relation_path,
  capabilities = excluded.capabilities,
  operators = excluded.operators,
  sequence = excluded.sequence,
  updated_at = timezone('utc', now());

update public.query_model_fields
set operators = operators || '["today","yesterday","this_week","this_month"]'::jsonb,
    updated_at = timezone('utc', now())
where field_type in ('date', 'datetime')
  and operators ? 'on'
  and not (operators ? 'today');

insert into public.query_model_views (model_id, view_key, label, view_type, columns, default_order, default_group_by, status)
select m.id, 'list', 'List', 'LIST',
  coalesce((select jsonb_agg(f.path order by f.sequence, f.path) from public.query_model_fields f where f.model_id = m.id and (f.capabilities ->> 'export')::boolean), '[]'::jsonb),
  m.default_order,
  '[]'::jsonb,
  'ACTIVE'
from public.query_models m
where m.status = 'ACTIVE'
on conflict (model_id, view_key) do update set
  columns = excluded.columns,
  default_order = excluded.default_order,
  status = excluded.status,
  updated_at = timezone('utc', now());

insert into public.query_search_definitions (model_id, definition_key, label, default_search_fields, default_order, operator_overrides, status, is_system)
select m.id, 'default', 'Default search', m.default_search_fields, m.default_order, '{}'::jsonb, 'ACTIVE', true
from public.query_models m
where m.status = 'ACTIVE'
on conflict (model_id, definition_key) do update set
  default_search_fields = excluded.default_search_fields,
  default_order = excluded.default_order,
  status = excluded.status,
  is_system = excluded.is_system,
  updated_at = timezone('utc', now());

update public.query_model_fields
set operators = operators || '["today","yesterday","this_week","this_month"]'::jsonb,
    updated_at = timezone('utc', now())
where path in ('created_at', 'updated_at')
  and field_type = 'datetime'
  and not (operators ? 'today');
