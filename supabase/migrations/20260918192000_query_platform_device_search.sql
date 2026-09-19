-- Register hardware terminals as a first-class Query Platform model so the
-- workspace device list uses the same search/filter contract as every other
-- tenant list. The model is intentionally read-only through this surface.

insert into public.query_models (
  technical_name,
  table_name,
  label,
  module,
  description,
  tenant_scope,
  read_permission,
  default_search_fields,
  default_order,
  status
)
values (
  'device.device',
  'devices',
  'Hardware Terminals',
  'workspace',
  'Registered POS, kiosk, KDS, and queue display terminals',
  'STORE',
  'store.read',
  '["name", "mode"]'::jsonb,
  '[{"field":"created_at","direction":"desc"}]'::jsonb,
  'ACTIVE'
)
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
  model_id,
  path,
  label,
  field_type,
  column_name,
  capabilities,
  operators,
  sequence
)
select m.id, v.path, v.label, v.field_type, v.column_name, v.capabilities, v.operators, v.sequence
from public.query_models m
join (values
  ('device.device', 'name', 'Terminal name', 'char', 'name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 1),
  ('device.device', 'mode', 'Mode', 'selection', 'mode', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 2),
  ('device.device', 'store_id', 'Store', 'many2one', 'store_id', '{"search":false,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 3),
  ('device.device', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 4),
  ('device.device', 'last_seen_at', 'Last active', 'datetime', 'last_seen_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 5),
  ('device.device', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 6)
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

-- IDs are safe, read-only list fields. Keeping them in the shared metadata
-- lets each contextual list retain stable row identity for navigation/actions.
insert into public.query_model_fields (
  model_id,
  path,
  label,
  field_type,
  column_name,
  capabilities,
  operators,
  sequence
)
select m.id,
  'id',
  'ID',
  'char',
  'id',
  '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb,
  '["eq","neq","in","not_in"]'::jsonb,
  0
from public.query_models m
where m.technical_name in ('res.store', 'device.device')
on conflict (model_id, path) do update set
  label = excluded.label,
  field_type = excluded.field_type,
  column_name = excluded.column_name,
  capabilities = excluded.capabilities,
  operators = excluded.operators,
  sequence = excluded.sequence,
  updated_at = timezone('utc', now());

insert into public.query_model_relations (
  model_id,
  path,
  related_model,
  related_table,
  embed_name,
  source_column,
  target_column,
  foreign_key,
  cardinality
)
select m.id, 'store', 'res.store', 'stores', 'store', 'store_id', 'id',
  'devices_organization_id_store_id_fkey', 'many_to_one'
from public.query_models m
where m.technical_name = 'device.device'
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
  model_id,
  path,
  label,
  field_type,
  column_name,
  relation_model,
  relation_path,
  capabilities,
  operators,
  sequence
)
select m.id, 'store.name', 'Store name', 'char', 'name', 'res.store', 'store',
  '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb,
  '["contains","eq","starts_with"]'::jsonb,
  7
from public.query_models m
where m.technical_name = 'device.device'
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

insert into public.query_model_views (
  model_id,
  view_key,
  label,
  view_type,
  columns,
  default_order,
  default_group_by,
  status
)
select m.id,
  'list',
  'List',
  'LIST',
  '["id","name","mode","store.name","last_seen_at","status"]'::jsonb,
  m.default_order,
  '[]'::jsonb,
  'ACTIVE'
from public.query_models m
where m.technical_name = 'device.device'
on conflict (model_id, view_key) do update set
  columns = excluded.columns,
  default_order = excluded.default_order,
  status = excluded.status,
  updated_at = timezone('utc', now());

insert into public.query_search_definitions (
  model_id,
  definition_key,
  label,
  default_search_fields,
  default_order,
  operator_overrides,
  status,
  is_system
)
select m.id, 'default', 'Default search', m.default_search_fields, m.default_order, '{}'::jsonb, 'ACTIVE', true
from public.query_models m
where m.technical_name = 'device.device'
on conflict (model_id, definition_key) do update set
  default_search_fields = excluded.default_search_fields,
  default_order = excluded.default_order,
  status = excluded.status,
  is_system = excluded.is_system,
  updated_at = timezone('utc', now());

create index if not exists devices_org_status_created_idx
  on public.devices (organization_id, status, created_at desc);
