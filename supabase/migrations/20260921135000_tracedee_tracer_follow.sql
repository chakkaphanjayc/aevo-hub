-- TraceDee keeps following a tracer distinct from following a Trace.
-- The mutation is idempotent, event-first, and not inferred from UI state.

create or replace function public.tracedee_tracer_action(
  p_actor_id uuid,
  p_tracer_id uuid,
  p_action text,
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
  v_existing record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := gen_random_uuid();
  v_action text := upper(trim(coalesce(p_action, '')));
  v_following boolean := false;
  v_changed boolean := false;
  v_rows integer := 0;
  v_follower_count integer := 0;
  v_response jsonb;
  v_scope text := 'tracedee:tracer:' || p_tracer_id::text;
begin
  if p_actor_id is null or p_tracer_id is null then
    raise exception using errcode = 'P0001', message = 'TRACER_FOLLOW_INPUT_INVALID';
  end if;
  if p_actor_id = p_tracer_id then
    raise exception using errcode = 'P0001', message = 'TRACER_FOLLOW_SELF_INVALID';
  end if;
  if v_action not in ('FOLLOW', 'UNFOLLOW') then
    raise exception using errcode = 'P0001', message = 'TRACER_FOLLOW_ACTION_NOT_SUPPORTED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;
  if not exists (select 1 from auth.users where id = p_tracer_id) then
    raise exception using errcode = 'P0001', message = 'TRACER_NOT_FOUND';
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

  if v_action = 'FOLLOW' then
    insert into public.tracedee_tracer_follows (follower_id, tracer_id)
    values (p_actor_id, p_tracer_id)
    on conflict (follower_id, tracer_id) do nothing;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
    v_following := true;
  else
    delete from public.tracedee_tracer_follows
    where follower_id = p_actor_id and tracer_id = p_tracer_id;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
    v_following := false;
  end if;

  select count(*)::integer
  into v_follower_count
  from public.tracedee_tracer_follows
  where tracer_id = p_tracer_id;

  if v_changed then
    insert into public.tracedee_activity_events (
      event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
      tracking_token, correlation_id, dedupe_key
    )
    values (
      case when v_following then 'tracer_followed' else 'tracer_unfollowed' end,
      p_actor_id,
      coalesce(nullif(trim(p_source), ''), 'aevo-go'),
      p_session_id,
      'PROFILE',
      p_tracer_id,
      jsonb_build_object('tracerId', p_tracer_id, 'followerId', p_actor_id),
      v_tracking_token,
      v_correlation_id,
      'tracer-action:' || p_actor_id::text || ':' || p_tracer_id::text || ':' || lower(v_action) || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);

    if v_following then
      insert into public.tracedee_notifications (recipient_id, actor_id, event_type, entity_type, entity_id, payload)
      values (
        p_tracer_id,
        p_actor_id,
        'tracer_followed',
        'PROFILE',
        p_tracer_id,
        jsonb_build_object('tracerId', p_tracer_id, 'followerId', p_actor_id)
      );
    end if;
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'tracerId', p_tracer_id,
    'following', v_following,
    'followerCount', v_follower_count,
    'changed', v_changed,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );
  update public.tracedee_idempotency_keys set response_status = 200, response_body = v_response where id = v_idempotency_id;
  return v_response;
end;
$$;

revoke all on function public.tracedee_tracer_action(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_tracer_action(uuid, uuid, text, text, text, text, text) to service_role;
