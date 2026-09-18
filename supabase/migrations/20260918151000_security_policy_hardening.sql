-- Remove broad onboarding/settings policies that would otherwise expose
-- tenant data to anonymous Supabase clients. The gateway still uses its
-- server-only key, but direct access must be tenant-safe as well.

alter table public.system_settings enable row level security;
alter table public.app_entitlements enable row level security;
alter table public.onboarding_sessions enable row level security;

drop policy if exists "system_settings_read" on public.system_settings;
create policy "system_settings_authenticated_read"
  on public.system_settings
  for select
  to authenticated
  using (true);

drop policy if exists "app_entitlements_read" on public.app_entitlements;
create policy "org_member_read_app_entitlements"
  on public.app_entitlements
  for select
  to authenticated
  using (private.is_org_member(organization_id));

drop policy if exists "onboarding_sessions_owner" on public.onboarding_sessions;
create policy "onboarding_sessions_owner"
  on public.onboarding_sessions
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
