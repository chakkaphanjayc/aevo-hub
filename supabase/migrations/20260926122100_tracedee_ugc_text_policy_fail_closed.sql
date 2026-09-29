-- A rejected policy decision must never map to a public status if a future
-- caller reuses the status helper without the creation guard.

create or replace function public.tracedee_content_status(p_body text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $$
  select case
    when public.tracedee_content_policy_decision(p_body)->>'action' in ('REVIEW', 'REJECT') then 'UNDER_REVIEW'
    else 'VISIBLE'
  end;
$$;

revoke all on function public.tracedee_content_status(text) from public, anon, authenticated;
grant execute on function public.tracedee_content_status(text) to service_role;
