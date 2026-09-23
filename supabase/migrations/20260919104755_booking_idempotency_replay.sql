-- Public booking confirmation must be replay-safe at the database boundary.
-- The Gateway calls this function with the server-only Supabase client; the
-- browser never receives a direct database function grant.
create or replace function public.create_booking(
  p_organization_id uuid,
  p_venue_id uuid,
  p_resource_id uuid,
  p_customer_name text,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null,
  p_requested_amount_minor integer default null,
  p_notes text default null,
  p_idempotency_key text default null,
  p_created_by uuid default null
)
returns table(booking_id uuid, idempotent boolean)
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_key text;
  v_existing_response jsonb;
  v_existing_resource_id uuid;
  v_booking_id uuid;
  v_checkin_code text;
  v_amount_minor integer;
begin
  v_key := nullif(btrim(p_idempotency_key), '');
  if v_key is null or length(v_key) < 8 or length(v_key) > 200 then
    raise exception using errcode = '22023', message = 'Idempotency-Key must be between 8 and 200 characters';
  end if;
  if p_customer_name is null or length(btrim(p_customer_name)) = 0 or length(p_customer_name) > 160 then
    raise exception using errcode = '22023', message = 'Customer name is required and must be at most 160 characters';
  end if;
  if p_start_at is null or p_end_at is null or p_start_at >= p_end_at then
    raise exception using errcode = '22023', message = 'Booking start and end times are invalid';
  end if;
  if p_customer_phone is not null and length(p_customer_phone) > 40 then
    raise exception using errcode = '22023', message = 'Customer phone is too long';
  end if;
  if p_customer_email is not null and length(p_customer_email) > 320 then
    raise exception using errcode = '22023', message = 'Customer email is too long';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception using errcode = '22023', message = 'Booking notes are too long';
  end if;

  -- Serialize confirmations per tenant/resource so the overlap check and
  -- insert cannot race. This also works on PostgreSQL versions without a
  -- btree_gist exclusion constraint on the legacy bookings table.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_resource_id::text, 0));

  select r.base_price_minor
    into v_amount_minor
  from public.bookable_resources r
  join public.venues v on v.id = r.venue_id and v.organization_id = r.organization_id
  where r.organization_id = p_organization_id
    and r.venue_id = p_venue_id
    and r.id = p_resource_id
    and r.status = 'ACTIVE'
    and v.status = 'ACTIVE';
  if not found then
    raise exception using errcode = '23503', message = 'Venue resource was not found or is inactive';
  end if;

  insert into public.idempotency_keys (organization_id, user_id, scope, key, expires_at)
  values (p_organization_id, p_created_by, 'booking.create', v_key, timezone('utc', now()) + interval '1 day')
  on conflict (organization_id, scope, key) do nothing;
  if not found then
    select i.resource_id, i.response_body
      into v_existing_resource_id, v_existing_response
    from public.idempotency_keys i
    where i.organization_id = p_organization_id
      and i.scope = 'booking.create'
      and i.key = v_key
    for update;

    v_booking_id := coalesce(v_existing_resource_id, nullif(v_existing_response->>'bookingId', '')::uuid);
    if v_booking_id is null then
      raise exception using errcode = '40001', message = 'The previous booking request is still in progress';
    end if;
    if not exists (
      select 1 from public.bookings b
      where b.organization_id = p_organization_id and b.id = v_booking_id
    ) then
      raise exception using errcode = '40001', message = 'The idempotent booking no longer exists';
    end if;
    return query select v_booking_id, true;
    return;
  end if;

  if exists (
    select 1
    from public.bookings b
    where b.organization_id = p_organization_id
      and b.resource_id = p_resource_id
      and b.status in ('HELD', 'CONFIRMED', 'CHECKED_IN')
      and b.start_at < p_end_at
      and b.end_at > p_start_at
  ) then
    raise exception using errcode = 'P0001', message = 'BOOKING_CONFLICT';
  end if;

  v_checkin_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into public.bookings (
    organization_id,
    venue_id,
    resource_id,
    customer_name,
    customer_phone,
    customer_email,
    start_at,
    end_at,
    status,
    amount_minor,
    checkin_code,
    notes
  ) values (
    p_organization_id,
    p_venue_id,
    p_resource_id,
    btrim(p_customer_name),
    nullif(btrim(p_customer_phone), ''),
    nullif(btrim(p_customer_email), ''),
    p_start_at,
    p_end_at,
    'CONFIRMED',
    v_amount_minor,
    v_checkin_code,
    nullif(btrim(p_notes), '')
  ) returning id into v_booking_id;

  update public.idempotency_keys
  set resource_id = v_booking_id,
      response_status = 201,
      response_body = jsonb_build_object('bookingId', v_booking_id)
  where organization_id = p_organization_id
    and scope = 'booking.create'
    and key = v_key;

  return query select v_booking_id, false;
end;
$function$;

revoke all on function public.create_booking(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_booking(uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, integer, text, text, uuid) to service_role;
