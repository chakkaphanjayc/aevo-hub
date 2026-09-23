-- The notification aggregation trigger is only an internal database trigger.
-- It must not be callable through the exposed PostgREST RPC surface.
revoke all on function public.tracedee_prepare_notification() from public, anon, authenticated;
grant execute on function public.tracedee_prepare_notification() to service_role;
