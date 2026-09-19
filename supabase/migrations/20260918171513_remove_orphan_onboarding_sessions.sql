-- A deleted tenant intentionally nulls organization_id on its onboarding
-- session. Remove only those historical orphan sessions; active onboarding
-- sessions that belong to a tenant remain intact.
delete from public.onboarding_sessions
where organization_id is null
  and created_at < current_timestamp;
