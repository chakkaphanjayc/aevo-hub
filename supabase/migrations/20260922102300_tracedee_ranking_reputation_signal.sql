-- Use the replayable reputation projection as a bounded creator-quality signal
-- for personalized scoring. Deterministic ordering remains unchanged so the
-- SHADOW comparison stays meaningful.
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

  if position('coalesce((select count(*) from public.tracedee_content_reports' in v_definition) = 0 then
    raise exception 'tracedee_discovery_feed quality boundary was not found';
  end if;

  v_definition := replace(
    v_definition,
    'coalesce((select count(*) from public.tracedee_content_reports r where r.entity_type = ''TRACE'' and r.entity_id = t.id and r.status in (''OPEN'', ''REVIEWING'')), 0)::numeric as open_report_count,',
    'coalesce((select count(*) from public.tracedee_content_reports r where r.entity_type = ''TRACE'' and r.entity_id = t.id and r.status in (''OPEN'', ''REVIEWING'')), 0)::numeric as open_report_count,' || chr(10) || '      coalesce((select ps.reputation from public.tracedee_profile_scores ps where ps.profile_id = t.creator_id order by ps.score_version desc limit 1), 0)::numeric as creator_reputation,'
  );

  if position('+ b.freshness_score' in v_definition) = 0 then
    raise exception 'tracedee_discovery_feed freshness score boundary was not found';
  end if;

  v_definition := replace(
    v_definition,
    '+ b.freshness_score' || chr(10) || '        + case when cardinality(b.matched_topics)',
    '+ b.freshness_score' || chr(10) || '        + greatest(-20, least(20, b.creator_reputation * 0.2))' || chr(10) || '        + case when cardinality(b.matched_topics)'
  );

  v_definition := replace(
    v_definition,
    '''qualityConfidence'', s.quality_confidence,',
    '''qualityConfidence'', s.quality_confidence,' || chr(10) || '      ''creatorReputationSignal'', case when s.ranking_mode = ''PERSONALIZED'' or s.ranking_mode = ''SHADOW'' then s.creator_reputation else 0 end,'
  );

  execute v_definition;
end;
$$;

revoke all on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) to service_role;

commit;
