-- TraceDee Phase 4: draft remixes with bounded, replayable lineage.
-- A remix is cloned as a private draft. The lineage edge and creator
-- attribution become public only after the remixer publishes it.

create index if not exists tracedee_traces_root_lineage_idx
  on public.tracedee_traces (root_trace_id, lineage_depth, created_at desc);
create index if not exists tracedee_traces_source_lineage_idx
  on public.tracedee_traces (source_trace_id, created_at desc);

create or replace function public.tracedee_create_remix(
  p_actor_id uuid,
  p_source_trace_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_title text default null,
  p_description text default null,
  p_slug text default null,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_source record;
  v_existing record;
  v_idempotency_id uuid;
  v_remix_id uuid;
  v_slug_base text;
  v_slug text;
  v_root_trace_id uuid;
  v_lineage_depth integer;
  v_stop_count integer := 0;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_response jsonb;
  v_scope text := 'tracedee:remix:create:' || p_source_trace_id::text;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (
    p_actor_id,
    v_scope,
    trim(p_idempotency_key),
    trim(p_request_hash),
    timezone('utc', now()) + interval '24 hours'
  )
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id and scope = v_scope and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  select id, slug, title, description, creator_id, revision, root_trace_id,
    lineage_depth, cover_place_id, area, topic_tags, estimated_minutes,
    estimated_budget_minor, status, visibility
  into v_source
  from public.tracedee_traces
  where id = p_source_trace_id
    and status = 'PUBLISHED'
    and visibility = 'PUBLIC';
  if not found then
    raise exception using errcode = 'P0001', message = 'SOURCE_TRACE_NOT_FOUND';
  end if;

  if v_source.lineage_depth >= 20 then
    raise exception using errcode = 'P0001', message = 'REMIX_LINEAGE_LIMIT';
  end if;

  v_root_trace_id := coalesce(v_source.root_trace_id, v_source.id);
  v_lineage_depth := v_source.lineage_depth + 1;
  v_slug_base := lower(trim(coalesce(nullif(trim(p_slug), ''), v_source.slug || '-remix')));
  v_slug_base := regexp_replace(v_slug_base, '[^a-z0-9]+', '-', 'g');
  v_slug_base := regexp_replace(v_slug_base, '(^-+|-+$)', '', 'g');
  v_slug_base := left(coalesce(nullif(v_slug_base, ''), 'remix'), 100);
  v_slug := v_slug_base || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);

  insert into public.tracedee_traces (
    creator_id, slug, title, description, status, visibility, revision,
    root_trace_id, source_trace_id, lineage_depth, cover_place_id, area,
    topic_tags, estimated_minutes, estimated_budget_minor
  )
  values (
    p_actor_id,
    v_slug,
    left(coalesce(nullif(trim(p_title), ''), 'Remix: ' || v_source.title), 180),
    left(coalesce(p_description, v_source.description), 6000),
    'DRAFT',
    'PRIVATE',
    1,
    v_root_trace_id,
    v_source.id,
    v_lineage_depth,
    v_source.cover_place_id,
    v_source.area,
    v_source.topic_tags,
    v_source.estimated_minutes,
    v_source.estimated_budget_minor
  )
  returning id into v_remix_id;

  insert into public.tracedee_trace_stops (
    trace_id, place_id, position, note, duration_minutes, transport_mode, budget_minor
  )
  select v_remix_id, s.place_id, s.position, s.note, s.duration_minutes, s.transport_mode, s.budget_minor
  from public.tracedee_trace_stops s
  where s.trace_id = v_source.id
  order by s.position asc;
  get diagnostics v_stop_count = row_count;
  if v_stop_count = 0 then
    raise exception using errcode = 'P0001', message = 'TRACE_HAS_NO_STOPS';
  end if;

  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  )
  values (
    'trace_remixed',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-go'),
    p_session_id,
    'TRACE',
    v_remix_id,
    jsonb_build_object(
      'stage', 'DRAFT_CREATED',
      'sourceTraceId', v_source.id,
      'rootTraceId', v_root_trace_id,
      'lineageDepth', v_lineage_depth,
      'stopCount', v_stop_count
    ),
    v_tracking_token,
    v_correlation_id,
    'trace-remix-create:' || p_actor_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true,
    'remixTraceId', v_remix_id,
    'remixSlug', v_slug,
    'sourceTraceId', v_source.id,
    'rootTraceId', v_root_trace_id,
    'remixerId', p_actor_id,
    'lineageDepth', v_lineage_depth,
    'status', 'DRAFT',
    'revision', 1,
    'stopCount', v_stop_count,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys
  set response_status = 200, response_body = v_response
  where id = v_idempotency_id;
  return v_response;
end;
$$;

create or replace function public.tracedee_update_remix(
  p_actor_id uuid,
  p_trace_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_expected_revision integer default null,
  p_title text default null,
  p_description text default null,
  p_area text default null,
  p_topic_tags text[] default null,
  p_estimated_minutes integer default null,
  p_estimated_budget_minor integer default null,
  p_stops jsonb default null,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_trace record;
  v_existing record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_stop_count integer := 0;
  v_item jsonb;
  v_scope text := 'tracedee:remix:update:' || p_trace_id::text;
  v_response jsonb;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, v_scope, trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id and scope = v_scope and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  select id, creator_id, status, revision
  into v_trace
  from public.tracedee_traces
  where id = p_trace_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TRACE_NOT_FOUND';
  end if;
  if v_trace.creator_id <> p_actor_id then
    raise exception using errcode = 'P0001', message = 'REMIX_NOT_OWNER';
  end if;
  if v_trace.status <> 'DRAFT' then
    raise exception using errcode = 'P0001', message = 'REMIX_NOT_EDITABLE';
  end if;
  if p_expected_revision is not null and p_expected_revision <> v_trace.revision then
    raise exception using errcode = 'P0001', message = 'TRACE_REVISION_CONFLICT';
  end if;

  if p_stops is not null then
    if jsonb_typeof(p_stops) <> 'array' or jsonb_array_length(p_stops) < 1 or jsonb_array_length(p_stops) > 30 then
      raise exception using errcode = 'P0001', message = 'REMIX_STOPS_INVALID';
    end if;
    for v_item in select value from jsonb_array_elements(p_stops) loop
      if not (v_item ? 'placeId') or (v_item->>'placeId') !~ '^[0-9a-fA-F-]{36}$' then
        raise exception using errcode = 'P0001', message = 'REMIX_STOP_PLACE_INVALID';
      end if;
      if v_item ? 'durationMinutes' and jsonb_typeof(v_item->'durationMinutes') <> 'number' then
        raise exception using errcode = 'P0001', message = 'REMIX_STOP_DURATION_INVALID';
      end if;
      if v_item ? 'budgetMinor' and jsonb_typeof(v_item->'budgetMinor') <> 'number' then
        raise exception using errcode = 'P0001', message = 'REMIX_STOP_BUDGET_INVALID';
      end if;
      if v_item ? 'transportMode' and coalesce(v_item->>'transportMode', '') not in ('WALK', 'BIKE', 'TRANSIT', 'CAR', 'RIDE_HAIL', 'OTHER') then
        raise exception using errcode = 'P0001', message = 'REMIX_STOP_TRANSPORT_INVALID';
      end if;
      if not exists (
        select 1 from public.tracedee_places p where p.id = (v_item->>'placeId')::uuid
      ) then
        raise exception using errcode = 'P0001', message = 'REMIX_PLACE_NOT_FOUND';
      end if;
    end loop;
    if (
      select count(*) from jsonb_array_elements(p_stops)
    ) <> (
      select count(distinct value->>'placeId') from jsonb_array_elements(p_stops)
    ) then
      raise exception using errcode = 'P0001', message = 'REMIX_STOP_DUPLICATE';
    end if;
  end if;

  update public.tracedee_traces
  set title = coalesce(nullif(trim(p_title), ''), title),
      description = coalesce(p_description, description),
      area = coalesce(p_area, area),
      topic_tags = coalesce(p_topic_tags, topic_tags),
      estimated_minutes = coalesce(p_estimated_minutes, estimated_minutes),
      estimated_budget_minor = coalesce(p_estimated_budget_minor, estimated_budget_minor),
      revision = revision + 1,
      updated_at = timezone('utc', now())
  where id = p_trace_id;

  if p_stops is not null then
    delete from public.tracedee_trace_stops where trace_id = p_trace_id;
    insert into public.tracedee_trace_stops (
      trace_id, place_id, position, note, duration_minutes, transport_mode, budget_minor
    )
    select
      p_trace_id,
      (item->>'placeId')::uuid,
      (elements.ordinality - 1)::integer,
      left(coalesce(item->>'note', ''), 2000),
      nullif(item->>'durationMinutes', '')::integer,
      nullif(item->>'transportMode', ''),
      nullif(item->>'budgetMinor', '')::integer
    from jsonb_array_elements(p_stops) with ordinality as elements(item, ordinality);
    get diagnostics v_stop_count = row_count;
  else
    select count(*) into v_stop_count from public.tracedee_trace_stops where trace_id = p_trace_id;
  end if;

  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  )
  values (
    'trace_remixed',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-go'),
    p_session_id,
    'TRACE',
    p_trace_id,
    jsonb_build_object('stage', 'DRAFT_UPDATED', 'traceId', p_trace_id, 'revision', v_trace.revision + 1, 'stopCount', v_stop_count),
    v_tracking_token,
    v_correlation_id,
    'trace-remix-update:' || p_actor_id::text || ':' || p_trace_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'ok', true,
    'traceId', p_trace_id,
    'status', 'DRAFT',
    'revision', v_trace.revision + 1,
    'stopCount', v_stop_count,
    'changed', true,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

create or replace function public.tracedee_publish_remix(
  p_actor_id uuid,
  p_trace_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_trace record;
  v_source record;
  v_existing record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_stop_count integer;
  v_response jsonb;
  v_scope text := 'tracedee:remix:publish:' || p_trace_id::text;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, v_scope, trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id and scope = v_scope and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  select id, creator_id, slug, title, status, visibility, source_trace_id, root_trace_id, lineage_depth, revision
  into v_trace
  from public.tracedee_traces
  where id = p_trace_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TRACE_NOT_FOUND';
  end if;
  if v_trace.creator_id <> p_actor_id then
    raise exception using errcode = 'P0001', message = 'REMIX_NOT_OWNER';
  end if;
  if v_trace.status <> 'DRAFT' or v_trace.source_trace_id is null then
    raise exception using errcode = 'P0001', message = 'REMIX_NOT_PUBLISHABLE';
  end if;
  select id, creator_id, slug, title
  into v_source
  from public.tracedee_traces
  where id = v_trace.source_trace_id
    and status = 'PUBLISHED'
    and visibility = 'PUBLIC';
  if not found then
    raise exception using errcode = 'P0001', message = 'SOURCE_TRACE_NOT_FOUND';
  end if;
  select count(*) into v_stop_count from public.tracedee_trace_stops where trace_id = p_trace_id;
  if v_stop_count = 0 then
    raise exception using errcode = 'P0001', message = 'TRACE_HAS_NO_STOPS';
  end if;

  update public.tracedee_traces
  set status = 'PUBLISHED',
      visibility = 'PUBLIC',
      published_at = timezone('utc', now()),
      revision = revision + 1,
      updated_at = timezone('utc', now())
  where id = p_trace_id;

  insert into public.tracedee_trace_remixes (source_trace_id, remix_trace_id, remixer_id, lineage_depth)
  values (v_source.id, p_trace_id, p_actor_id, v_trace.lineage_depth)
  on conflict (remix_trace_id) do nothing;

  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  )
  values (
    'trace_remixed',
    p_actor_id,
    coalesce(nullif(trim(p_source), ''), 'aevo-go'),
    p_session_id,
    'TRACE',
    p_trace_id,
    jsonb_build_object(
      'stage', 'PUBLISHED',
      'sourceTraceId', v_source.id,
      'rootTraceId', v_trace.root_trace_id,
      'lineageDepth', v_trace.lineage_depth,
      'stopCount', v_stop_count
    ),
    v_tracking_token,
    v_correlation_id,
    'trace-remix-publish:' || p_actor_id::text || ':' || p_trace_id::text || ':' || trim(p_idempotency_key)
  )
  returning id into v_event_id;
  insert into public.tracedee_event_outbox (event_id) values (v_event_id);

  if v_source.creator_id <> p_actor_id then
    insert into public.tracedee_notifications (recipient_id, actor_id, event_type, entity_type, entity_id, payload)
    values (
      v_source.creator_id,
      p_actor_id,
      'trace_remixed',
      'TRACE',
      p_trace_id,
      jsonb_build_object(
        'sourceTraceId', v_source.id,
        'sourceTraceSlug', v_source.slug,
        'sourceTraceTitle', v_source.title,
        'remixTraceId', p_trace_id,
        'remixTraceSlug', v_trace.slug,
        'remixTraceTitle', v_trace.title,
        'lineageDepth', v_trace.lineage_depth
      )
    );
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'traceId', p_trace_id,
    'status', 'PUBLISHED',
    'revision', v_trace.revision + 1,
    'sourceTraceId', v_source.id,
    'rootTraceId', v_trace.root_trace_id,
    'lineageDepth', v_trace.lineage_depth,
    'stopCount', v_stop_count,
    'changed', true,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

create or replace function public.tracedee_get_trace_lineage(
  p_trace_id uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_trace record;
  v_source_node jsonb;
  v_root_node jsonb;
  v_trace_node jsonb;
  v_ancestors jsonb;
  v_descendants jsonb;
  v_root_id uuid;
begin
  select id, slug, title, creator_id, status, visibility, revision, root_trace_id, source_trace_id,
    lineage_depth, published_at, created_at
  into v_trace
  from public.tracedee_traces
  where id = p_trace_id
    and (
      (status = 'PUBLISHED' and visibility = 'PUBLIC')
      or creator_id = p_actor_id
    );
  if not found then
    raise exception using errcode = 'P0001', message = 'TRACE_NOT_FOUND';
  end if;

  v_root_id := coalesce(v_trace.root_trace_id, v_trace.id);
  v_trace_node := jsonb_build_object(
    'id', v_trace.id,
    'slug', v_trace.slug,
    'title', v_trace.title,
    'creatorId', v_trace.creator_id,
    'status', v_trace.status,
    'visibility', v_trace.visibility,
    'revision', v_trace.revision,
    'rootTraceId', v_trace.root_trace_id,
    'sourceTraceId', v_trace.source_trace_id,
    'lineageDepth', v_trace.lineage_depth,
    'publishedAt', v_trace.published_at,
    'createdAt', v_trace.created_at
  );

  select jsonb_build_object(
    'id', t.id,
    'slug', t.slug,
    'title', t.title,
    'creatorId', t.creator_id,
    'status', t.status,
    'visibility', t.visibility,
    'revision', t.revision,
    'rootTraceId', t.root_trace_id,
    'sourceTraceId', t.source_trace_id,
    'lineageDepth', t.lineage_depth,
    'publishedAt', t.published_at,
    'createdAt', t.created_at
  )
  into v_source_node
  from public.tracedee_traces t
  where t.id = v_trace.source_trace_id
    and ((t.status = 'PUBLISHED' and t.visibility = 'PUBLIC') or t.creator_id = p_actor_id);

  select jsonb_build_object(
    'id', t.id,
    'slug', t.slug,
    'title', t.title,
    'creatorId', t.creator_id,
    'status', t.status,
    'visibility', t.visibility,
    'revision', t.revision,
    'rootTraceId', t.root_trace_id,
    'sourceTraceId', t.source_trace_id,
    'lineageDepth', t.lineage_depth,
    'publishedAt', t.published_at,
    'createdAt', t.created_at
  )
  into v_root_node
  from public.tracedee_traces t
  where t.id = v_root_id
    and ((t.status = 'PUBLISHED' and t.visibility = 'PUBLIC') or t.creator_id = p_actor_id);

  with recursive ancestors as (
    select t.id, t.slug, t.title, t.creator_id, t.status, t.visibility, t.revision,
      t.root_trace_id, t.source_trace_id, t.lineage_depth, t.published_at, t.created_at, 1 as hops
    from public.tracedee_traces t
    where t.id = v_trace.source_trace_id
      and ((t.status = 'PUBLISHED' and t.visibility = 'PUBLIC') or t.creator_id = p_actor_id)
    union all
    select parent.id, parent.slug, parent.title, parent.creator_id, parent.status, parent.visibility,
      parent.revision, parent.root_trace_id, parent.source_trace_id, parent.lineage_depth,
      parent.published_at, parent.created_at, ancestors.hops + 1
    from public.tracedee_traces parent
    join ancestors on parent.id = ancestors.source_trace_id
    where ancestors.hops < 20
      and ((parent.status = 'PUBLISHED' and parent.visibility = 'PUBLIC') or parent.creator_id = p_actor_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'slug', slug, 'title', title, 'creatorId', creator_id,
    'status', status, 'visibility', visibility, 'revision', revision,
    'rootTraceId', root_trace_id, 'sourceTraceId', source_trace_id,
    'lineageDepth', lineage_depth, 'publishedAt', published_at, 'createdAt', created_at
  ) order by hops desc), '[]'::jsonb)
  into v_ancestors
  from ancestors;

  with recursive descendants as (
    select t.id, t.slug, t.title, t.creator_id, t.status, t.visibility, t.revision,
      t.root_trace_id, t.source_trace_id, t.lineage_depth, t.published_at, t.created_at, 1 as hops
    from public.tracedee_traces t
    where t.source_trace_id = p_trace_id
      and ((t.status = 'PUBLISHED' and t.visibility = 'PUBLIC') or t.creator_id = p_actor_id)
    union all
    select child.id, child.slug, child.title, child.creator_id, child.status, child.visibility,
      child.revision, child.root_trace_id, child.source_trace_id, child.lineage_depth,
      child.published_at, child.created_at, descendants.hops + 1
    from public.tracedee_traces child
    join descendants on child.source_trace_id = descendants.id
    where descendants.hops < 20
      and ((child.status = 'PUBLISHED' and child.visibility = 'PUBLIC') or child.creator_id = p_actor_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'slug', slug, 'title', title, 'creatorId', creator_id,
    'status', status, 'visibility', visibility, 'revision', revision,
    'rootTraceId', root_trace_id, 'sourceTraceId', source_trace_id,
    'lineageDepth', lineage_depth, 'publishedAt', published_at, 'createdAt', created_at
  ) order by hops asc, created_at asc), '[]'::jsonb)
  into v_descendants
  from descendants;

  return jsonb_build_object(
    'ok', true,
    'trace', v_trace_node,
    'source', coalesce(v_source_node, 'null'::jsonb),
    'root', coalesce(v_root_node, 'null'::jsonb),
    'ancestors', coalesce(v_ancestors, '[]'::jsonb),
    'descendants', coalesce(v_descendants, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.tracedee_create_remix(uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_create_remix(uuid, uuid, text, text, text, text, text, text, text) to service_role;
revoke all on function public.tracedee_update_remix(uuid, uuid, text, text, integer, text, text, text, text[], integer, integer, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_update_remix(uuid, uuid, text, text, integer, text, text, text, text[], integer, integer, jsonb, text, text) to service_role;
revoke all on function public.tracedee_publish_remix(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_publish_remix(uuid, uuid, text, text, text, text) to service_role;
revoke all on function public.tracedee_get_trace_lineage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tracedee_get_trace_lineage(uuid, uuid) to service_role;
