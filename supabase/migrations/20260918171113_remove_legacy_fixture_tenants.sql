-- Remove the historical onboarding fixtures created by the pre-production
-- test flows. Organization deletion cascades tenant-owned rows; Supabase Auth
-- identities are intentionally not touched.
delete from public.organizations
where slug = 'aevo-demo'
   or (name = 'Aevo Arena & Bistro' and slug like 'aevo-arena-bistro-mu%');
