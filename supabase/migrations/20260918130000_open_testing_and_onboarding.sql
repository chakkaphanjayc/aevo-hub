-- Migration: 20260918130000_open_testing_and_onboarding.sql
-- Supports Open Testing Mode (unlimited apps/branches/devices) and full onboarding lifecycle.

-- 1. System Settings Table (for global operating mode)
CREATE TABLE IF NOT EXISTS public.system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- Seed operating mode to 'testing'
INSERT INTO public.system_settings (key, value)
VALUES ('operating_mode', '{"mode": "testing", "unlimited": true, "updated_at": "2026-09-18T00:00:00Z"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 2. Extended Organization Profile Columns
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS business_type text DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'THB',
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'TH',
  ADD COLUMN IF NOT EXISTS onboarding_status text DEFAULT 'COMPLETED';

-- 3. Extended Store Columns
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS store_mode text DEFAULT 'POS',
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS tax_id text;

-- 4. App Entitlements Table (for granular testing limits & future subscriptions)
CREATE TABLE IF NOT EXISTS public.app_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED')),
  plan_id text NOT NULL DEFAULT 'TESTING_UNLIMITED',
  is_unlimited_testing boolean NOT NULL DEFAULT true,
  limits jsonb NOT NULL DEFAULT '{"max_stores": null, "max_devices": null, "max_members": null}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (organization_id, app_id)
);

-- 5. Onboarding Sessions Table
CREATE TABLE IF NOT EXISTS public.onboarding_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  current_step text NOT NULL DEFAULT 'WELCOME',
  objectives jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- 6. Add is_demo_data flag to entity tables
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_demo_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS is_demo_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_demo_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.venues ADD COLUMN IF NOT EXISTS is_demo_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_demo_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bookable_resources ADD COLUMN IF NOT EXISTS is_demo_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS is_demo_data boolean NOT NULL DEFAULT false;

-- 7. Indexes
CREATE INDEX IF NOT EXISTS idx_onboarding_user_id ON public.onboarding_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_app_entitlements_org ON public.app_entitlements (organization_id, app_id);
CREATE INDEX IF NOT EXISTS idx_products_demo ON public.products (organization_id, is_demo_data);

-- 8. Row Level Security Policies
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "system_settings_read" ON public.system_settings FOR SELECT USING (true);
CREATE POLICY "app_entitlements_read" ON public.app_entitlements FOR SELECT USING (true);
CREATE POLICY "onboarding_sessions_owner" ON public.onboarding_sessions FOR ALL USING (user_id = auth.uid() OR true);
