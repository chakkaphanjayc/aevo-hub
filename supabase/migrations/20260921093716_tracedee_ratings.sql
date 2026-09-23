-- TraceDee Phase 3: post-journey rating as a server-owned product signal.
-- Ratings are only accepted for a completed journey owned by the actor. The
-- mutation is idempotent and emits the activity/outbox pair in the same
-- transaction as the rating insert.

create index if not exists tracedee_trace_ratings_trace_created_idx
  on public.tracedee_trace_ratings (trace_id, created_at desc);

create or replace function public.tracedee_rate_trace(
  p_actor_id uuid,
  p_journey_id uuid,
  p_rating smallint,
  p_idempotency_key text,
  p_request_hash text,
  p_tags text[] default '{}'::text[],
  p_review text default '',
  p_source text default 'aevo-go',
  p_session_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_journey record;
  v_existing record;
  v_rating_row public.tracedee_trace_ratings%rowtype;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_tags text[] := '{}'::text[];
  v_review text := trim(coalesce(p_review, ''));
  v_changed boolean := false;
  v_moderation_status text;
  v_response jsonb;
  v_scope text := 'tracedee:trace:rating:' || p_journey_id::text;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception using errcode = 'P0001', message = 'RATING_INPUT_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;
  if length(v_review) > 3000 or coalesce(cardinality(p_tags), 0) > 8 then
    raise exception using errcode = 'P0001', message = 'RATING_INPUT_INVALID';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_tags, '{}'::text[])) as raw_tag(tag)
    where length(trim(coalesce(tag, ''))) < 1
      or length(trim(tag)) > 48
  ) then
    raise exception using errcode = 'P0001', message = 'RATING_INPUT_INVALID';
  end if;

  select coalesce(array_agg(tag order by tag), '{}'::text[])
  into v_tags
  from (
    select distinct lower(trim(tag)) as tag
    from unnest(coalesce(p_tags, '{}'::text[])) as raw_tag(tag)
  ) normalized_tags;

  select
    j.id,
    j.user_id,
    j.trace_id,
    j.status,
    c.id as completion_id,
    c.verification_status
  into v_journey
  from public.tracedee_journeys j
  left join public.tracedee_completions c on c.journey_id = j.id
  where j.id = p_journey_id
    and j.user_id = p_actor_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'JOURNEY_NOT_FOUND';
  end if;
  if v_journey.status <> 'COMPLETED'
     or v_journey.completion_id is null
     or v_journey.verification_status = 'REJECTED' then
    raise exception using errcode = 'P0001', message = 'RATING_NOT_ELIGIBLE';
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
    where actor_id = p_actor_id
      and scope = v_scope
      and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  v_moderation_status := case when v_review = '' then 'VISIBLE' else 'UNDER_REVIEW' end;
  insert into public.tracedee_trace_ratings (
    completion_id,
    trace_id,
    user_id,
    rating,
    tags,
    review,
    moderation_status
  )
  values (
    v_journey.completion_id,
    v_journey.trace_id,
    p_actor_id,
    p_rating,
    v_tags,
    v_review,
    v_moderation_status
  )
  on conflict do nothing
  returning * into v_rating_row;

  if v_rating_row.id is null then
    select *
    into v_rating_row
    from public.tracedee_trace_ratings
    where completion_id = v_journey.completion_id
       or (trace_id = v_journey.trace_id and user_id = p_actor_id)
    order by created_at asc
    limit 1;
  else
    v_changed := true;
  end if;

  if v_rating_row.id is null then
    raise exception using errcode = 'P0001', message = 'RATING_NOT_FOUND';
  end if;

  if v_changed then
    insert into public.tracedee_activity_events (
      event_type,
      actor_id,
      source,
      session_id,
      entity_type,
      entity_id,
      metadata,
      tracking_token,
      correlation_id,
      dedupe_key
    )
    values (
      'trace_rated',
      p_actor_id,
      coalesce(nullif(trim(p_source), ''), 'aevo-go'),
      p_session_id,
      'TRACE',
      v_journey.trace_id,
      jsonb_build_object(
        'journeyId', p_journey_id,
        'completionId', v_journey.completion_id,
        'rating', v_rating_row.rating,
        'tags', v_rating_row.tags,
        'hasReview', v_rating_row.review <> ''
      ),
      v_tracking_token,
      v_correlation_id,
      'trace-rating:' || p_actor_id::text || ':' || p_journey_id::text || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;

    insert into public.tracedee_event_outbox (event_id)
    values (v_event_id);
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'ratingId', v_rating_row.id,
    'completionId', v_rating_row.completion_id,
    'journeyId', p_journey_id,
    'traceId', v_rating_row.trace_id,
    'rating', v_rating_row.rating,
    'tags', v_rating_row.tags,
    'review', v_rating_row.review,
    'moderationStatus', v_rating_row.moderation_status,
    'changed', v_changed,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );

  update public.tracedee_idempotency_keys
  set response_status = 200,
      response_body = v_response
  where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_rate_trace(uuid, uuid, smallint, text, text, text[], text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_rate_trace(uuid, uuid, smallint, text, text, text[], text, text, text) to service_role;
