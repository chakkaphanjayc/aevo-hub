-- Platform Administration search models.
--
-- Admin lists use the same versioned Query AST as tenant lists, but these
-- models are explicitly PLATFORM scoped and are only exposed by the gateway's
-- platform-admin query surface. The metadata is read-only; mutations continue
-- to use the existing audit-logged admin endpoints.

drop view if exists public.admin_query_organizations;
drop view if exists public.admin_query_stores;
drop view if exists public.admin_query_subscriptions;
drop view if exists public.admin_query_users;

create view public.admin_query_organizations as
  select * from public.organizations;

create view public.admin_query_stores as
  select * from public.stores;

create view public.admin_query_subscriptions as
  select * from public.subscriptions;

create view public.admin_query_users as
  select * from public.user_profiles;

revoke all on public.admin_query_organizations,
  public.admin_query_stores,
  public.admin_query_subscriptions,
  public.admin_query_users
from anon, authenticated;
grant select on public.admin_query_organizations,
  public.admin_query_stores,
  public.admin_query_subscriptions,
  public.admin_query_users
to service_role;

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
values
  (
    'admin.organization',
    'admin_query_organizations',
    'Organizations',
    'admin',
    'Cross-tenant organization directory for platform administration',
    'PLATFORM',
    'organization.read',
    '["name", "slug", "legal_name", "contact_email"]'::jsonb,
    '[{"field":"created_at","direction":"desc"}]'::jsonb,
    'ACTIVE'
  ),
  (
    'admin.store',
    'admin_query_stores',
    'Stores',
    'admin',
    'Cross-tenant store and branch directory for platform administration',
    'PLATFORM',
    'organization.read',
    '["name", "code"]'::jsonb,
    '[{"field":"created_at","direction":"desc"}]'::jsonb,
    'ACTIVE'
  ),
  (
    'admin.subscription',
    'admin_query_subscriptions',
    'Subscriptions',
    'admin',
    'Cross-tenant commercial subscription directory',
    'PLATFORM',
    'subscription.read',
    '["plan_id", "provider", "status"]'::jsonb,
    '[{"field":"created_at","direction":"desc"}]'::jsonb,
    'ACTIVE'
  ),
  (
    'admin.user',
    'admin_query_users',
    'User accounts',
    'admin',
    'Cross-tenant user identity directory for platform administration',
    'PLATFORM',
    'organization.read',
    '["email", "display_name"]'::jsonb,
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
  ('admin.organization', 'id', 'Organization ID', 'char', 'id', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 0),
  ('admin.organization', 'name', 'Organization name', 'char', 'name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","ends_with"]'::jsonb, 1),
  ('admin.organization', 'slug', 'Slug', 'char', 'slug', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","ends_with"]'::jsonb, 2),
  ('admin.organization', 'legal_name', 'Legal name', 'char', 'legal_name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","is_empty","is_not_empty"]'::jsonb, 3),
  ('admin.organization', 'business_type', 'Business type', 'char', 'business_type', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 4),
  ('admin.organization', 'contact_email', 'Contact email', 'email', 'contact_email', '{"search":true,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","is_empty","is_not_empty"]'::jsonb, 5),
  ('admin.organization', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq","in","not_in"]'::jsonb, 6),
  ('admin.organization', 'currency', 'Currency', 'char', 'currency', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq","in","not_in"]'::jsonb, 7),
  ('admin.organization', 'timezone', 'Timezone', 'char', 'timezone', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","contains"]'::jsonb, 8),
  ('admin.organization', 'max_users', 'Max users', 'integer', 'max_users', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, 9),
  ('admin.organization', 'max_stores', 'Max stores', 'integer', 'max_stores', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","gt","gte","lt","lte","between"]'::jsonb, 10),
  ('admin.organization', 'feature_flags', 'Feature flags', 'json', 'feature_flags', '{"search":false,"filter":false,"sort":false,"group":false,"export":true,"import":false}'::jsonb, '[]'::jsonb, 11),
  ('admin.organization', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 12),

  ('admin.store', 'id', 'Store ID', 'char', 'id', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 0),
  ('admin.store', 'organization_id', 'Organization ID', 'many2one', 'organization_id', '{"search":false,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 1),
  ('admin.store', 'name', 'Store name', 'char', 'name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","ends_with"]'::jsonb, 2),
  ('admin.store', 'code', 'Store code', 'char', 'code', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","ends_with"]'::jsonb, 3),
  ('admin.store', 'timezone', 'Timezone', 'char', 'timezone', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq"]'::jsonb, 4),
  ('admin.store', 'currency', 'Currency', 'char', 'currency', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq"]'::jsonb, 5),
  ('admin.store', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq","in","not_in"]'::jsonb, 6),
  ('admin.store', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 7),

  ('admin.subscription', 'id', 'Subscription ID', 'char', 'id', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 0),
  ('admin.subscription', 'organization_id', 'Organization ID', 'many2one', 'organization_id', '{"search":false,"filter":true,"sort":false,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 1),
  ('admin.subscription', 'plan_id', 'Plan', 'char', 'plan_id', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with"]'::jsonb, 2),
  ('admin.subscription', 'provider', 'Provider', 'selection', 'provider', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 3),
  ('admin.subscription', 'status', 'Status', 'selection', 'status', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 4),
  ('admin.subscription', 'current_period_start', 'Period starts', 'datetime', 'current_period_start', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 5),
  ('admin.subscription', 'current_period_end', 'Period ends', 'datetime', 'current_period_end', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 6),
  ('admin.subscription', 'trial_end', 'Trial ends', 'datetime', 'trial_end', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 7),
  ('admin.subscription', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 8),

  ('admin.user', 'id', 'User ID', 'char', 'id', '{"search":false,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["eq","neq","in","not_in"]'::jsonb, 0),
  ('admin.user', 'email', 'Email', 'email', 'email', '{"search":true,"filter":true,"sort":true,"group":false,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","ends_with"]'::jsonb, 1),
  ('admin.user', 'display_name', 'Display name', 'char', 'display_name', '{"search":true,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","starts_with","ends_with","is_empty","is_not_empty"]'::jsonb, 2),
  ('admin.user', 'status', 'Status', 'selection', 'status', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["contains","eq","neq","in","not_in"]'::jsonb, 3),
  ('admin.user', 'created_at', 'Created', 'datetime', 'created_at', '{"search":false,"filter":true,"sort":true,"group":true,"export":true,"import":false}'::jsonb, '["before","after","on","between","today","yesterday","this_week","this_month"]'::jsonb, 4)
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
  coalesce((select jsonb_agg(f.path order by f.sequence, f.path)
    from public.query_model_fields f
    where f.model_id = m.id and (f.capabilities ->> 'export')::boolean), '[]'::jsonb),
  m.default_order,
  '[]'::jsonb,
  'ACTIVE'
from public.query_models m
where m.module = 'admin' and m.status = 'ACTIVE'
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
select m.id,
  'default',
  'Default search',
  m.default_search_fields,
  m.default_order,
  '{}'::jsonb,
  'ACTIVE',
  true
from public.query_models m
where m.module = 'admin' and m.status = 'ACTIVE'
on conflict (model_id, definition_key) do update set
  default_search_fields = excluded.default_search_fields,
  default_order = excluded.default_order,
  status = excluded.status,
  is_system = excluded.is_system,
  updated_at = timezone('utc', now());

-- The query compiler emits ILIKE predicates for free-text search. Trigram
-- indexes keep the Admin directory responsive as the tenant count grows.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create index if not exists organizations_name_trgm_idx on public.organizations using gin (name extensions.gin_trgm_ops);
create index if not exists organizations_slug_trgm_idx on public.organizations using gin (slug extensions.gin_trgm_ops);
create index if not exists organizations_legal_name_trgm_idx on public.organizations using gin (legal_name extensions.gin_trgm_ops);
create index if not exists stores_name_trgm_idx on public.stores using gin (name extensions.gin_trgm_ops);
create index if not exists stores_code_trgm_idx on public.stores using gin (code extensions.gin_trgm_ops);
create index if not exists user_profiles_email_trgm_idx on public.user_profiles using gin (email extensions.gin_trgm_ops);
create index if not exists user_profiles_display_name_trgm_idx on public.user_profiles using gin (display_name extensions.gin_trgm_ops);
