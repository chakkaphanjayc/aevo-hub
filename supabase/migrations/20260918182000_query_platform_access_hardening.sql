-- Align database-side query permissions with the canonical TypeScript role
-- matrix. Gateway checks remain mandatory, while these grants protect direct
-- Supabase clients and RLS-backed integrations as a second line of defense.

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
join (
  values
    ('OWNER', 'query.read'),
    ('OWNER', 'query.manage'),
    ('OWNER', 'query.import'),
    ('OWNER', 'query.export'),
    ('OWNER', 'query.bulk_edit'),
    ('ADMIN', 'query.read'),
    ('ADMIN', 'query.manage'),
    ('ADMIN', 'query.import'),
    ('ADMIN', 'query.export'),
    ('ADMIN', 'query.bulk_edit'),
    ('ORGANIZATION_MANAGER', 'query.read'),
    ('ORGANIZATION_MANAGER', 'query.manage'),
    ('ORGANIZATION_MANAGER', 'query.import'),
    ('ORGANIZATION_MANAGER', 'query.export'),
    ('ORGANIZATION_MANAGER', 'query.bulk_edit'),
    ('BRANCH_MANAGER', 'query.read'),
    ('BRANCH_MANAGER', 'query.export'),
    ('STORE_MANAGER', 'query.read'),
    ('STORE_MANAGER', 'query.manage'),
    ('STORE_MANAGER', 'query.import'),
    ('STORE_MANAGER', 'query.export'),
    ('STORE_MANAGER', 'query.bulk_edit'),
    ('CASHIER', 'query.read'),
    ('BOOKING_STAFF', 'query.read'),
    ('KIOSK_STAFF', 'query.read'),
    ('STAFF', 'query.read'),
    ('VIEWER', 'query.read')
) as matrix(role_code, permission_code) on matrix.role_code = r.code
join public.permissions p on p.code = matrix.permission_code
on conflict do nothing;

drop policy if exists query_saved_queries_read on public.query_saved_queries;
create policy query_saved_queries_read on public.query_saved_queries
for select to authenticated using (
  private.has_org_permission(organization_id, 'query.read')
  and (
    owner_user_id = auth.uid()
    or scope in ('SYSTEM', 'TEAM', 'ORGANIZATION')
    or (
      scope = 'STORE'
      and exists (
        select 1
        from public.memberships m
        join public.membership_stores ms on ms.membership_id = m.id
        where m.organization_id = query_saved_queries.organization_id
          and m.user_id = auth.uid()
          and m.status = 'ACTIVE'
          and ms.store_id = query_saved_queries.store_id
      )
    )
  )
);

drop policy if exists query_saved_queries_manage on public.query_saved_queries;
create policy query_saved_queries_manage on public.query_saved_queries
for all to authenticated using (
  private.has_org_permission(organization_id, 'query.read')
  and (owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage'))
)
with check (
  private.is_org_member(organization_id)
  and private.has_org_permission(organization_id, 'query.read')
  and (owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage'))
);

drop policy if exists query_history_owner_read on public.query_history;
create policy query_history_owner_read on public.query_history
for select to authenticated using (
  private.is_org_member(organization_id)
  and private.has_org_permission(organization_id, 'query.read')
  and (user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage'))
);

drop policy if exists query_import_jobs_read on public.query_import_jobs;
create policy query_import_jobs_read on public.query_import_jobs
for select to authenticated using (
  private.has_org_permission(organization_id, 'query.import')
  and (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.import'))
);
drop policy if exists query_import_jobs_manage on public.query_import_jobs;
create policy query_import_jobs_manage on public.query_import_jobs
for all to authenticated using (
  private.has_org_permission(organization_id, 'query.import')
)
with check (
  private.is_org_member(organization_id)
  and private.has_org_permission(organization_id, 'query.import')
  and (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.import'))
);

drop policy if exists query_import_columns_read on public.query_import_columns;
create policy query_import_columns_read on public.query_import_columns
for select to authenticated using (
  exists (
    select 1 from public.query_import_jobs j
    where j.id = job_id
      and private.has_org_permission(j.organization_id, 'query.import')
      and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))
  )
);
drop policy if exists query_import_columns_manage on public.query_import_columns;
create policy query_import_columns_manage on public.query_import_columns
for all to authenticated using (
  exists (
    select 1 from public.query_import_jobs j
    where j.id = job_id and private.has_org_permission(j.organization_id, 'query.import')
  )
)
with check (
  exists (
    select 1 from public.query_import_jobs j
    where j.id = job_id and private.has_org_permission(j.organization_id, 'query.import')
  )
);

drop policy if exists query_import_mappings_read on public.query_import_mappings;
create policy query_import_mappings_read on public.query_import_mappings
for select to authenticated using (
  exists (
    select 1 from public.query_import_jobs j
    where j.id = job_id
      and private.has_org_permission(j.organization_id, 'query.import')
      and (j.created_by = auth.uid() or private.has_org_permission(j.organization_id, 'query.import'))
  )
);
drop policy if exists query_import_mappings_manage on public.query_import_mappings;
create policy query_import_mappings_manage on public.query_import_mappings
for all to authenticated using (
  exists (
    select 1 from public.query_import_jobs j
    where j.id = job_id and private.has_org_permission(j.organization_id, 'query.import')
  )
)
with check (
  exists (
    select 1 from public.query_import_jobs j
    where j.id = job_id and private.has_org_permission(j.organization_id, 'query.import')
  )
);

drop policy if exists query_import_errors_read on public.query_import_errors;
create policy query_import_errors_read on public.query_import_errors
for select to authenticated using (
  exists (
    select 1 from public.query_import_jobs j
    where j.id = job_id and private.has_org_permission(j.organization_id, 'query.import')
  )
);

drop policy if exists query_export_jobs_read on public.query_export_jobs;
create policy query_export_jobs_read on public.query_export_jobs
for select to authenticated using (
  private.has_org_permission(organization_id, 'query.export')
  and (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.export'))
);
drop policy if exists query_export_jobs_manage on public.query_export_jobs;
create policy query_export_jobs_manage on public.query_export_jobs
for all to authenticated using (
  private.has_org_permission(organization_id, 'query.export')
)
with check (
  private.is_org_member(organization_id)
  and private.has_org_permission(organization_id, 'query.export')
  and (created_by = auth.uid() or private.has_org_permission(organization_id, 'query.export'))
);

drop policy if exists query_export_templates_read on public.query_export_templates;
create policy query_export_templates_read on public.query_export_templates
for select to authenticated using (
  private.has_org_permission(organization_id, 'query.read')
  and (
    owner_user_id = auth.uid()
    or scope in ('SYSTEM', 'TEAM', 'ORGANIZATION')
    or (
      scope = 'STORE'
      and exists (
        select 1
        from public.memberships m
        join public.membership_stores ms on ms.membership_id = m.id
        where m.organization_id = query_export_templates.organization_id
          and m.user_id = auth.uid()
          and m.status = 'ACTIVE'
          and ms.store_id = query_export_templates.store_id
      )
    )
  )
);
drop policy if exists query_export_templates_manage on public.query_export_templates;
create policy query_export_templates_manage on public.query_export_templates
for all to authenticated using (
  private.has_org_permission(organization_id, 'query.read')
  and (owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage'))
)
with check (
  private.is_org_member(organization_id)
  and private.has_org_permission(organization_id, 'query.read')
  and (owner_user_id = auth.uid() or private.has_org_permission(organization_id, 'query.manage'))
);
