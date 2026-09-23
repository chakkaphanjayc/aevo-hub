-- Customer booking phase: server-owned slot holds, party size, and an opaque
-- reservation token that can be used to read/poll a reservation without
-- exposing the bookings table to the browser.

CREATE TABLE IF NOT EXISTS public.booking_slot_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES public.bookable_resources(id) ON DELETE CASCADE,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  party_size integer NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 999),
  amount_minor integer NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
  expires_at timestamptz NOT NULL,
  consumed_booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CHECK (start_at < end_at)
);

CREATE INDEX IF NOT EXISTS booking_slot_holds_resource_window_idx
  ON public.booking_slot_holds (resource_id, start_at, end_at, status);

CREATE INDEX IF NOT EXISTS booking_slot_holds_expiry_idx
  ON public.booking_slot_holds (status, expires_at);

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS party_size integer NOT NULL DEFAULT 1;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_party_size_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_party_size_check CHECK (party_size BETWEEN 1 AND 999);

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS public_tracking_token text;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS slot_hold_id uuid REFERENCES public.booking_slot_holds(id) ON DELETE SET NULL;

UPDATE public.bookings
SET public_tracking_token = gen_random_uuid()::text
WHERE public_tracking_token IS NULL;

ALTER TABLE public.bookings
  ALTER COLUMN public_tracking_token SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN public_tracking_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_public_tracking_token_idx
  ON public.bookings (public_tracking_token);

CREATE INDEX IF NOT EXISTS bookings_slot_hold_idx
  ON public.bookings (slot_hold_id)
  WHERE slot_hold_id IS NOT NULL;

DROP TRIGGER IF EXISTS booking_slot_holds_set_updated_at ON public.booking_slot_holds;
CREATE TRIGGER booking_slot_holds_set_updated_at
  BEFORE UPDATE ON public.booking_slot_holds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.booking_slot_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_slot_holds FROM anon, authenticated;

DROP POLICY IF EXISTS booking_slot_holds_no_direct_browser_access ON public.booking_slot_holds;
CREATE POLICY booking_slot_holds_no_direct_browser_access
  ON public.booking_slot_holds
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.create_booking_slot_hold(
  p_organization_id uuid,
  p_venue_id uuid,
  p_resource_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_party_size integer DEFAULT 1,
  p_requested_amount_minor integer DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS TABLE(
  hold_id uuid,
  venue_id uuid,
  resource_id uuid,
  start_at timestamptz,
  end_at timestamptz,
  party_size integer,
  amount_minor integer,
  expires_at timestamptz,
  server_time timestamptz,
  idempotent boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_existing_id uuid;
  v_venue_timezone text;
  v_capacity integer;
  v_amount_minor integer;
  v_hold record;
BEGIN
  IF v_key IS NULL OR length(v_key) < 8 OR length(v_key) > 200 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Idempotency-Key must be between 8 and 200 characters';
  END IF;
  IF p_start_at IS NULL OR p_end_at IS NULL OR p_start_at >= p_end_at THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Booking start and end times are invalid';
  END IF;
  IF p_start_at <= v_now THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Booking slot must start in the future';
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > 999 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Party size must be between 1 and 999';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_resource_id::text, 0));

  SELECT v.timezone, r.capacity, r.base_price_minor
    INTO v_venue_timezone, v_capacity, v_amount_minor
  FROM public.bookable_resources r
  JOIN public.venues v ON v.id = r.venue_id AND v.organization_id = r.organization_id
  WHERE r.organization_id = p_organization_id
    AND r.venue_id = p_venue_id
    AND r.id = p_resource_id
    AND r.status = 'ACTIVE'
    AND v.status = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '23503', message = 'Venue resource was not found or is inactive';
  END IF;
  IF p_party_size > v_capacity THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Party size exceeds resource capacity';
  END IF;

  INSERT INTO public.idempotency_keys (organization_id, user_id, scope, key, expires_at)
  VALUES (p_organization_id, NULL, 'booking.hold.create', v_key, v_now + interval '1 day')
  ON CONFLICT (organization_id, scope, key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT i.resource_id INTO v_existing_id
    FROM public.idempotency_keys i
    WHERE i.organization_id = p_organization_id
      AND i.scope = 'booking.hold.create'
      AND i.key = v_key
    FOR UPDATE;
    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION USING errcode = '40001', message = 'The previous hold request is still in progress';
    END IF;
    SELECT h.id, h.venue_id, h.resource_id, h.start_at, h.end_at, h.party_size,
           h.amount_minor, h.expires_at
      INTO v_hold
    FROM public.booking_slot_holds h
    WHERE h.organization_id = p_organization_id AND h.id = v_existing_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING errcode = '40001', message = 'The idempotent hold no longer exists';
    END IF;
    RETURN QUERY SELECT v_hold.id, v_hold.venue_id, v_hold.resource_id,
      v_hold.start_at, v_hold.end_at, v_hold.party_size, v_hold.amount_minor,
      v_hold.expires_at, v_now, true;
    RETURN;
  END IF;

  UPDATE public.booking_slot_holds
  SET status = 'EXPIRED', updated_at = v_now
  WHERE organization_id = p_organization_id
    AND resource_id = p_resource_id
    AND status = 'HELD'
    AND expires_at <= v_now;

  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.organization_id = p_organization_id
      AND b.resource_id = p_resource_id
      AND b.status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
      AND b.start_at < p_end_at
      AND b.end_at > p_start_at
  ) OR EXISTS (
    SELECT 1 FROM public.booking_slot_holds h
    WHERE h.organization_id = p_organization_id
      AND h.resource_id = p_resource_id
      AND h.status = 'HELD'
      AND h.expires_at > v_now
      AND h.start_at < p_end_at
      AND h.end_at > p_start_at
  ) THEN
    RAISE EXCEPTION USING errcode = 'P0001', message = 'BOOKING_HOLD_CONFLICT';
  END IF;

  v_expires_at := v_now + interval '10 minutes';
  INSERT INTO public.booking_slot_holds (
    organization_id, venue_id, resource_id, start_at, end_at,
    party_size, amount_minor, expires_at
  ) VALUES (
    p_organization_id, p_venue_id, p_resource_id, p_start_at, p_end_at,
    p_party_size, v_amount_minor, v_expires_at
  ) RETURNING id INTO v_existing_id;

  UPDATE public.idempotency_keys
  SET resource_id = v_existing_id,
      response_status = 201,
      response_body = jsonb_build_object('holdId', v_existing_id, 'expiresAt', v_expires_at)
  WHERE organization_id = p_organization_id
    AND scope = 'booking.hold.create'
    AND key = v_key;

  RETURN QUERY SELECT v_existing_id, p_venue_id, p_resource_id, p_start_at,
    p_end_at, p_party_size, v_amount_minor, v_expires_at, v_now, false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_booking_slot_hold(
  p_hold_id uuid,
  p_customer_name text,
  p_customer_phone text DEFAULT NULL,
  p_customer_email text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS TABLE(booking_id uuid, idempotent boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_now timestamptz := clock_timestamp();
  v_booking_id uuid;
  v_existing_id uuid;
  v_hold record;
BEGIN
  IF v_key IS NULL OR length(v_key) < 8 OR length(v_key) > 200 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Idempotency-Key must be between 8 and 200 characters';
  END IF;
  IF p_customer_name IS NULL OR length(btrim(p_customer_name)) = 0 OR length(p_customer_name) > 160 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Customer name is required and must be at most 160 characters';
  END IF;
  IF p_customer_phone IS NOT NULL AND length(p_customer_phone) > 40 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Customer phone is too long';
  END IF;
  IF p_customer_email IS NOT NULL AND length(p_customer_email) > 320 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Customer email is too long';
  END IF;
  IF p_notes IS NOT NULL AND length(p_notes) > 2000 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Booking notes are too long';
  END IF;

  SELECT h.organization_id, h.venue_id, h.resource_id, h.start_at, h.end_at,
         h.party_size, h.amount_minor, h.status, h.expires_at
    INTO v_hold
  FROM public.booking_slot_holds h
  WHERE h.id = p_hold_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = '23503', message = 'Booking hold was not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_hold.organization_id::text || ':' || v_hold.resource_id::text, 0));

  INSERT INTO public.idempotency_keys (organization_id, user_id, scope, key, expires_at)
  VALUES (v_hold.organization_id, p_created_by, 'booking.hold.confirm', v_key, v_now + interval '1 day')
  ON CONFLICT (organization_id, scope, key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT i.resource_id INTO v_existing_id
    FROM public.idempotency_keys i
    WHERE i.organization_id = v_hold.organization_id
      AND i.scope = 'booking.hold.confirm'
      AND i.key = v_key
    FOR UPDATE;
    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION USING errcode = '40001', message = 'The previous booking confirmation is still in progress';
    END IF;
    RETURN QUERY SELECT v_existing_id, true;
    RETURN;
  END IF;

  IF v_hold.status <> 'HELD' OR v_hold.expires_at <= v_now THEN
    IF v_hold.status = 'HELD' AND v_hold.expires_at <= v_now THEN
      UPDATE public.booking_slot_holds
      SET status = 'EXPIRED', updated_at = v_now
      WHERE id = p_hold_id;
    END IF;
    RAISE EXCEPTION USING errcode = 'P0001', message = 'BOOKING_HOLD_EXPIRED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.organization_id = v_hold.organization_id
      AND b.resource_id = v_hold.resource_id
      AND b.status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
      AND b.start_at < v_hold.end_at
      AND b.end_at > v_hold.start_at
  ) THEN
    RAISE EXCEPTION USING errcode = 'P0001', message = 'BOOKING_CONFLICT';
  END IF;

  INSERT INTO public.bookings (
    organization_id, venue_id, resource_id, slot_hold_id,
    customer_name, customer_phone, customer_email,
    start_at, end_at, party_size, status, amount_minor,
    checkin_code, notes
  ) VALUES (
    v_hold.organization_id, v_hold.venue_id, v_hold.resource_id, p_hold_id,
    btrim(p_customer_name), nullif(btrim(p_customer_phone), ''),
    nullif(lower(btrim(p_customer_email)), ''), v_hold.start_at, v_hold.end_at,
    v_hold.party_size, 'CONFIRMED', v_hold.amount_minor,
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    nullif(btrim(p_notes), '')
  ) RETURNING id INTO v_booking_id;

  UPDATE public.booking_slot_holds
  SET status = 'CONSUMED', consumed_booking_id = v_booking_id, updated_at = v_now
  WHERE id = p_hold_id;

  UPDATE public.idempotency_keys
  SET resource_id = v_booking_id,
      response_status = 201,
      response_body = jsonb_build_object('bookingId', v_booking_id)
  WHERE organization_id = v_hold.organization_id
    AND scope = 'booking.hold.confirm'
    AND key = v_key;

  RETURN QUERY SELECT v_booking_id, false;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_booking_slot_hold(uuid, uuid, uuid, timestamptz, timestamptz, integer, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_slot_hold(uuid, uuid, uuid, timestamptz, timestamptz, integer, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_booking_slot_hold(uuid, text, text, text, text, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_booking_slot_hold(uuid, text, text, text, text, text, uuid) TO service_role;
