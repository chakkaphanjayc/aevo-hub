-- Query Platform entitlement and quota defaults.
-- Query definitions remain permission-checked, while plan entitlements cap
-- data-heavy operations independently from the RBAC permission matrix.

insert into public.plan_entitlements (plan_id, feature_key, is_enabled, limit_value)
values
  ('starter', 'query_platform', true, null),
  ('starter', 'query_import', true, null),
  ('starter', 'query_export', true, null),
  ('starter', 'query_rows', true, 10000),
  ('starter', 'query_import_rows', true, 1000),
  ('starter', 'query_export_rows', true, 5000),
  ('business', 'query_platform', true, null),
  ('business', 'query_import', true, null),
  ('business', 'query_export', true, null),
  ('business', 'query_rows', true, 100000),
  ('business', 'query_import_rows', true, 25000),
  ('business', 'query_export_rows', true, 100000),
  ('enterprise', 'query_platform', true, null),
  ('enterprise', 'query_import', true, null),
  ('enterprise', 'query_export', true, null),
  ('enterprise', 'query_rows', true, null),
  ('enterprise', 'query_import_rows', true, null),
  ('enterprise', 'query_export_rows', true, null)
on conflict (plan_id, feature_key) do update set
  is_enabled = excluded.is_enabled,
  limit_value = excluded.limit_value;

insert into public.organization_entitlements (organization_id, feature_key, is_enabled, limit_value, custom_override)
select o.id, p.feature_key, p.is_enabled, p.limit_value, false
from public.organizations o
left join public.subscriptions s on s.organization_id = o.id
join public.plan_entitlements p on p.plan_id = coalesce(s.plan_id, 'starter')
where p.feature_key in ('query_platform', 'query_import', 'query_export', 'query_rows', 'query_import_rows', 'query_export_rows')
on conflict (organization_id, feature_key) do nothing;

update public.query_model_fields
set capabilities = capabilities || '{"aggregate": true}'::jsonb,
    updated_at = timezone('utc', now())
where (model_id, path) in (
  select m.id, v.path
  from public.query_models m
  join (values
    ('product.product', 'base_price_minor'),
    ('product.category', 'sort_order'),
    ('sale.order', 'total_minor')
  ) as v(model_name, path) on v.model_name = m.technical_name
);
