-- Canonical production-safe defaults for new and existing deployments.
-- Platform operators can explicitly enable testing mode from the protected
-- administration surface after this migration has been applied.

INSERT INTO public.system_settings (key, value)
VALUES (
  'operating_mode',
  jsonb_build_object('mode', 'production', 'unlimited', false, 'updated_at', timezone('utc', now()))
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = timezone('utc', now());
