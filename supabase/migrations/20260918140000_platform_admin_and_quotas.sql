-- Migration: 20260918140000_platform_admin_and_quotas.sql
-- Adds tenant quota limits, feature flags, and sets default operating mode to production.

-- 1. Extend Organizations with Quotas and Feature Flags
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS max_users integer DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_stores integer DEFAULT 5,
  ADD COLUMN IF NOT EXISTS feature_flags jsonb DEFAULT '{"pos": true, "kiosk": true, "booking": true, "crm": true, "inventory": true, "odoo": false}'::jsonb;

-- 2. Ensure operating_mode exists in system_settings and default to production
INSERT INTO public.system_settings (key, value)
VALUES ('operating_mode', '{"mode": "production", "unlimited": false, "updated_at": "2026-09-18T00:00:00Z"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
