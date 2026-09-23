-- Keep the reputation contribution server-side. Customers receive the
-- explainable topic/area reason, not a creator score or internal weight.
begin;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.tracedee_discovery_feed(uuid,text,text,text,numeric,timestamptz,uuid,integer)'::regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'tracedee_discovery_feed definition is missing';
  end if;

  v_definition := replace(
    v_definition,
    chr(10) || '      ''creatorReputationSignal'', case when s.ranking_mode = ''PERSONALIZED'' or s.ranking_mode = ''SHADOW'' then s.creator_reputation else 0 end,',
    ''
  );

  execute v_definition;
end;
$$;

revoke all on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) to service_role;

commit;
