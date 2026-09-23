-- Worker-safe reputation rebuilds use the public profile projection. The
-- backend does not need direct SELECT access to auth.users for account trust.
begin;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.tracedee_rebuild_reputation_evidence(integer)'::regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'tracedee_rebuild_reputation_evidence definition is missing';
  end if;

  v_definition := replace(v_definition, 'left join auth.users u on u.id = a.profile_id', 'left join public.user_profiles u on u.id = a.profile_id');
  execute v_definition;
end;
$$;

revoke all on function public.tracedee_rebuild_reputation_evidence(integer) from public, anon, authenticated;
grant execute on function public.tracedee_rebuild_reputation_evidence(integer) to service_role;

commit;
