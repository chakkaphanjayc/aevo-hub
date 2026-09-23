-- Preserve the authoritative completion verification response on replay.
-- The function is rewritten from its already-installed definition so this
-- remains safe for both a fresh migration chain and the live project.

do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tracedee_complete_journey'
    and p.pronargs = 11
  order by p.oid desc
  limit 1;

  if v_definition is null then
    raise exception 'tracedee_complete_journey function is not installed';
  end if;

  v_definition := replace(
    v_definition,
    '  v_completion_id := nullif(v_result->>''completionId'', '''')::uuid;',
    '  if (v_result ? ''verificationStatus'') and (v_result ? ''verificationSummary'') then
    return v_result;
  end if;
  v_completion_id := nullif(v_result->>''completionId'', '''')::uuid;'
  );

  execute v_definition;
end;
$migration$;
