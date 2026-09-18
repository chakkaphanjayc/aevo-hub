-- Relation registry for metadata-driven nested search and projections.
-- PostgREST discovers foreign keys, but the application still owns which
-- relations are exposed, searchable, groupable, and exportable.

create table if not exists public.query_model_relations (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.query_models(id) on delete cascade,
  path text not null check (path ~ '^[a-z][a-z0-9_.-]{0,120}$'),
  related_model text not null references public.query_models(technical_name) on delete restrict,
  related_table text not null check (related_table ~ '^[a-z][a-z0-9_]{0,120}$'),
  embed_name text not null check (embed_name ~ '^[a-z][a-z0-9_]{0,120}$'),
  source_column text not null check (source_column ~ '^[a-z][a-z0-9_]{0,120}$'),
  target_column text not null check (target_column ~ '^[a-z][a-z0-9_]{0,120}$'),
  foreign_key text,
  cardinality text not null check (cardinality in ('many_to_one', 'one_to_many', 'one_to_one')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (model_id, path)
);

create index if not exists query_model_relations_model_path_idx
  on public.query_model_relations(model_id, path);

drop trigger if exists query_model_relations_set_updated_at on public.query_model_relations;
create trigger query_model_relations_set_updated_at
before update on public.query_model_relations
for each row execute function public.set_updated_at();

insert into public.query_models (
  technical_name, table_name, label, module, description, tenant_scope,
  read_permission, default_search_fields, default_order, status
)
values (
  'product.category', 'categories', 'Product Categories', 'catalog',
  'Organization product categories', 'ORGANIZATION', 'catalog.read',
  '["name", "code", "slug"]'::jsonb,
  '[{"field":"name","direction":"asc"}]'::jsonb,
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
  model_id, path, label, field_type, column_name, capabilities, operators, sequence
)
select m.id, v.path, v.label, v.field_type, v.column_name, v.capabilities, v.operators, v.sequence
from public.query_models m
join (values
  ('product.category', 'code', 'Code', 'char', 'code', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 1),
  ('product.category', 'name', 'Name', 'char', 'name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 2),
  ('product.category', 'slug', 'Slug', 'char', 'slug', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":true}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 3),
  ('product.category', 'sort_order', 'Sort order', 'integer', 'sort_order', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":true}'::jsonb, '["eq","neq","gt","gte","lt","lte"]'::jsonb, 4),
  ('product.category', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 5),
  ('product.category', 'parent.name', 'Parent name', 'char', 'name', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","is_empty","is_not_empty"]'::jsonb, 6)
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

insert into public.query_model_relations (
  model_id, path, related_model, related_table, embed_name,
  source_column, target_column, foreign_key, cardinality
)
select m.id, v.path, v.related_model, v.related_table, v.embed_name,
  v.source_column, v.target_column, v.foreign_key, v.cardinality
from public.query_models m
join (values
  ('product.product', 'category', 'product.category', 'categories', 'category', 'category_id', 'id', 'products_organization_id_category_id_fkey', 'many_to_one'),
  ('product.category', 'parent', 'product.category', 'categories', 'parent', 'parent_id', 'id', 'categories_organization_id_parent_id_fkey', 'many_to_one'),
  ('sale.order', 'store', 'res.store', 'stores', 'store', 'store_id', 'id', 'orders_organization_id_store_id_fkey', 'many_to_one')
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
  ('product.product', 'category.name', 'Category name', 'char', 'name', 'product.category', 'category', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","is_empty","is_not_empty"]'::jsonb, 8),
  ('product.product', 'category.code', 'Category code', 'char', 'code', 'product.category', 'category', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 9),
  ('sale.order', 'store.name', 'Store name', 'char', 'name', 'res.store', 'store', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 11),
  ('sale.order', 'store.code', 'Store code', 'char', 'code', 'res.store', 'store', '{"search":true,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 12)
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

update public.query_models
set default_search_fields = case technical_name
  when 'product.product' then '["name", "sku", "description", "category.name"]'::jsonb
  when 'sale.order' then '["order_number", "customer_name", "customer_phone", "customer_email", "store.name"]'::jsonb
  else default_search_fields
end,
updated_at = timezone('utc', now())
where technical_name in ('product.product', 'sale.order');

alter table public.query_model_relations enable row level security;

drop policy if exists query_model_relations_authenticated_read on public.query_model_relations;
create policy query_model_relations_authenticated_read on public.query_model_relations
for select to authenticated using (
  exists (
    select 1 from public.query_models m
    where m.id = model_id and m.status = 'ACTIVE'
  )
);

grant select on public.query_model_relations to authenticated;
grant all on public.query_model_relations to service_role;
