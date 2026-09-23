-- Platform permissions for the Aevo Go control plane.

update public.platform_roles
set permissions = (
  select jsonb_agg(to_jsonb(permission) order by permission)
  from (
    select distinct value as permission
    from jsonb_array_elements_text(permissions || '["go.analytics.read"]'::jsonb)
  ) as distinct_permissions
)
where role in ('SUPPORT', 'OPS', 'DEVELOPER');

update public.platform_roles
set permissions = (
  select jsonb_agg(to_jsonb(permission) order by permission)
  from (
    select distinct value as permission
    from jsonb_array_elements_text(permissions || '["go.settings.read"]'::jsonb)
  ) as distinct_permissions
)
where role in ('OPS', 'DEVELOPER');

-- Configuration writes intentionally remain SUPER_ADMIN-only in the first
-- control-plane slice. The static gateway role matrix also enforces this.
