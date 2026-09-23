-- The first hold function used a RETURNS TABLE output named resource_id. In
-- PL/pgSQL that name can shadow the resource_id column in the cleanup UPDATE.
-- Recompile the already-deployed function with the table alias qualified.
DO $migration$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'create_booking_slot_hold'
    AND pg_get_function_identity_arguments(p.oid) = 'p_organization_id uuid, p_venue_id uuid, p_resource_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_party_size integer, p_requested_amount_minor integer, p_idempotency_key text';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'create_booking_slot_hold function was not found';
  END IF;

  v_definition := replace(
    v_definition,
    E'UPDATE public.booking_slot_holds\n  SET status = ''EXPIRED'', updated_at = v_now\n  WHERE organization_id = p_organization_id\n    AND resource_id = p_resource_id\n    AND status = ''HELD''\n    AND expires_at <= v_now;',
    E'UPDATE public.booking_slot_holds AS h\n  SET status = ''EXPIRED'', updated_at = v_now\n  WHERE h.organization_id = p_organization_id\n    AND h.resource_id = p_resource_id\n    AND h.status = ''HELD''\n    AND h.expires_at <= v_now;'
  );

  EXECUTE v_definition;
END;
$migration$;
