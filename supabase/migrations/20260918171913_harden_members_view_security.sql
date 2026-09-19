-- Make the compatibility membership view obey the caller's RLS context.
alter view public.organization_members set (security_invoker = true);
