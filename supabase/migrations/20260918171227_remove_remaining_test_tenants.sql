-- Remove tenant fixtures left by integration/security/query test runs. The
-- organizations table owns tenant data with cascading foreign keys; auth
-- identities remain untouched for account lifecycle and audit purposes.
delete from public.organizations
where name ilike 'Gateway Test Organization %'
   or name ilike 'Security Test Organization %'
   or name ilike 'Mapping QA %'
   or name ilike 'Manual Query Organization %';
