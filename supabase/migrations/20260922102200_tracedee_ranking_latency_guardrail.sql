-- Ranking evaluations already record feed latency. Prefer that signal in the
-- guardrail report, while retaining interaction metadata as a compatibility
-- fallback for older clients.
begin;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.tracedee_ranking_guardrail_report(timestamptz,timestamptz)'::regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'tracedee_ranking_guardrail_report definition is missing';
  end if;

  if position('coalesce((select average_latency_ms from interaction_counts), 0)' in v_definition) = 0 then
    raise exception 'ranking guardrail latency expression was not found';
  end if;

  v_definition := replace(
    v_definition,
    'coalesce((select average_latency_ms from interaction_counts), 0)',
    'coalesce((select avg(nullif((e.metrics ->> ''latencyMs'')::numeric, 0)) from evaluations e), (select average_latency_ms from interaction_counts), 0)'
  );

  execute v_definition;
end;
$$;

revoke all on function public.tracedee_ranking_guardrail_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.tracedee_ranking_guardrail_report(timestamptz, timestamptz) to service_role;

commit;
