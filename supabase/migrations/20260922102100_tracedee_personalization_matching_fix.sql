-- Keep explicit onboarding interests visible in ranking explanations and
-- prevent NULL entries in the preference key array produced by a left join.
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

  if position('coalesce(array_agg(i.dimension_type || '':'' || i.dimension_key order by i.position), ''{}''::text[]) as interest_keys' in v_definition) = 0 then
    raise exception 'tracedee_discovery_feed interest key expression was not found';
  end if;

  v_definition := replace(
    v_definition,
    'coalesce(array_agg(i.dimension_type || '':'' || i.dimension_key order by i.position), ''{}''::text[]) as interest_keys',
    'coalesce(array_agg(i.dimension_type || '':'' || i.dimension_key order by i.position) filter (where i.profile_id is not null), ''{}''::text[]) as interest_keys'
  );

  v_definition := replace(
    v_definition,
    'where exists (select 1 from public.tracedee_taste_affinities ta where ta.profile_id = p_actor_id and ta.dimension_type = ''TOPIC'' and ta.dimension_key = lower(trim(tag.value))))',
    'where exists (select 1 from public.tracedee_taste_affinities ta where ta.profile_id = p_actor_id and ta.dimension_type = ''TOPIC'' and ta.dimension_key = lower(trim(tag.value))) or exists (select 1 from public.tracedee_profile_interests pi where pi.profile_id = p_actor_id and pi.dimension_type = ''TOPIC'' and pi.dimension_key = lower(trim(tag.value))))'
  );

  v_definition := replace(
    v_definition,
    'case when p_actor_id is not null and exists (select 1 from public.tracedee_profile_interests pi where pi.profile_id = p_actor_id and pi.dimension_type = ''AREA'' and pi.dimension_key = lower(trim(t.area))) then array[lower(trim(t.area))]::text[] else ''{}''::text[] end as matched_areas',
    'case when p_actor_id is not null and (exists (select 1 from public.tracedee_profile_interests pi where pi.profile_id = p_actor_id and pi.dimension_type = ''AREA'' and pi.dimension_key = lower(trim(t.area))) or exists (select 1 from public.tracedee_taste_affinities ta where ta.profile_id = p_actor_id and ta.dimension_type = ''AREA'' and ta.dimension_key = lower(trim(t.area)))) then array[lower(trim(t.area))]::text[] else ''{}''::text[] end as matched_areas'
  );

  v_definition := replace(
    v_definition,
    'when s.ranking_mode = ''PERSONALIZED'' and (cardinality(s.matched_topics) > 0 or cardinality(s.matched_areas) > 0) then ''TASTE_MATCH''',
    'when s.ranking_mode in (''PERSONALIZED'', ''SHADOW'') and (cardinality(s.matched_topics) > 0 or cardinality(s.matched_areas) > 0) then ''TASTE_MATCH'''
  );

  execute v_definition;
end;
$$;

revoke all on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) to service_role;

commit;
