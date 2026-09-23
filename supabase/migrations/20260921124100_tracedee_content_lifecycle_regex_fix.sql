-- regexp_matches returns one text[] row per match. Normalize its capture
-- group before resolving mention recipients.

do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tracedee_edit_content'
    and p.pronargs = 9
  order by p.oid desc
  limit 1;
  if v_definition is null then
    raise exception 'tracedee_edit_content function is not installed';
  end if;
  v_definition := replace(v_definition, 'up.id, matches.token', 'up.id, matches.token[1]');
  v_definition := replace(v_definition, 'lower(matches.token)', 'lower(matches.token[1])');
  execute v_definition;
end;
$migration$;
