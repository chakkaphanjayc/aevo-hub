-- Migration: 20260918160000_security_and_entitlements_v2.sql
-- Production Security, Platform RBAC, Decoupled Plan/Entitlement Engine, and Impersonation

-- 1. Expand Organization Status to include DELETED
ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_status_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED', 'DELETED'));

-- 2. Audit Logs Hardening (Structured before/after diffs and Platform Admin tracking)
ALTER TABLE public.audit_logs
  ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS admin_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS platform_role text,
  ADD COLUMN IF NOT EXISTS target_type text,
  ADD COLUMN IF NOT EXISTS target_id text,
  ADD COLUMN IF NOT EXISTS before_state jsonb,
  ADD COLUMN IF NOT EXISTS after_state jsonb,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS ip_address text;

CREATE INDEX IF NOT EXISTS idx_audit_admin ON public.audit_logs (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON public.audit_logs (target_type, target_id);

-- 3. Platform Roles & Platform Users
CREATE TABLE IF NOT EXISTS public.platform_roles (
  role text PRIMARY KEY,
  description text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

INSERT INTO public.platform_roles (role, description, permissions)
VALUES
  ('SUPER_ADMIN', 'Full system access and emergency actions', '["*"]'::jsonb),
  ('SUPPORT', 'Customer support, read organizations and temporary impersonation', '["organization.read", "subscription.read", "user.impersonate", "audit.read"]'::jsonb),
  ('OPS', 'System operations, health check and jobs', '["system.health", "system.jobs", "system.errors", "audit.read"]'::jsonb),
  ('BILLING_ADMIN', 'Billing plans and subscription management', '["subscription.read", "subscription.manage", "plan.manage", "audit.read"]'::jsonb),
  ('DEVELOPER', 'Developer diagnostics and read-only integrations', '["system.errors", "webhook.read", "integration.read", "audit.read"]'::jsonb),
  ('AUDITOR', 'Compliance auditor with read-only access to audit logs', '["audit.read"]'::jsonb)
ON CONFLICT (role) DO UPDATE SET
  description = EXCLUDED.description,
  permissions = EXCLUDED.permissions;

CREATE TABLE IF NOT EXISTS public.platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL REFERENCES public.platform_roles(role) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_users_role ON public.platform_users (role, is_active);

-- 4. Plans & Plan Entitlements
CREATE TABLE IF NOT EXISTS public.plans (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description text NOT NULL,
  billing_interval text NOT NULL DEFAULT 'MONTHLY' CHECK (billing_interval IN ('MONTHLY', 'ANNUAL', 'LIFETIME')),
  price_minor integer NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency text NOT NULL DEFAULT 'THB',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DRAFT')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.plan_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id text NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  limit_value integer, -- NULL indicates unlimited
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (plan_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_plan_entitlements_plan ON public.plan_entitlements (plan_id);

-- Seed Canonical Plans
INSERT INTO public.plans (id, name, description, billing_interval, price_minor, currency, status)
VALUES
  ('starter', 'Aevo Starter', 'Essential point of sale and catalog management for single-branch stores', 'MONTHLY', 49900, 'THB', 'ACTIVE'),
  ('business', 'Aevo Business', 'Full suite including POS, Kiosk, Booking, and Advanced Analytics for growing businesses', 'MONTHLY', 129000, 'THB', 'ACTIVE'),
  ('enterprise', 'Aevo Enterprise', 'Unlimited stores, API access, Odoo integration, and dedicated support', 'MONTHLY', 299000, 'THB', 'ACTIVE')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_minor = EXCLUDED.price_minor,
  status = EXCLUDED.status;

-- Seed Plan Entitlements
INSERT INTO public.plan_entitlements (plan_id, feature_key, is_enabled, limit_value)
VALUES
  -- Starter
  ('starter', 'pos', true, NULL),
  ('starter', 'kiosk', false, 0),
  ('starter', 'booking', false, 0),
  ('starter', 'advanced_analytics', false, 0),
  ('starter', 'odoo_integration', false, 0),
  ('starter', 'api_access', false, 0),
  ('starter', 'max_stores', true, 1),
  ('starter', 'max_devices', true, 2),
  ('starter', 'max_members', true, 5),

  -- Business
  ('business', 'pos', true, NULL),
  ('business', 'kiosk', true, NULL),
  ('business', 'booking', true, NULL),
  ('business', 'advanced_analytics', true, NULL),
  ('business', 'odoo_integration', false, 0),
  ('business', 'api_access', false, 0),
  ('business', 'max_stores', true, 5),
  ('business', 'max_devices', true, 10),
  ('business', 'max_members', true, 25),

  -- Enterprise
  ('enterprise', 'pos', true, NULL),
  ('enterprise', 'kiosk', true, NULL),
  ('enterprise', 'booking', true, NULL),
  ('enterprise', 'advanced_analytics', true, NULL),
  ('enterprise', 'odoo_integration', true, NULL),
  ('enterprise', 'api_access', true, NULL),
  ('enterprise', 'max_stores', true, NULL),
  ('enterprise', 'max_devices', true, NULL),
  ('enterprise', 'max_members', true, NULL)
ON CONFLICT (plan_id, feature_key) DO UPDATE SET
  is_enabled = EXCLUDED.is_enabled,
  limit_value = EXCLUDED.limit_value;

-- 5. Subscriptions Table (Replacing single app-tied model with Org Plan Subscriptions)
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'STRIPE' CHECK (provider IN ('STRIPE', 'MANUAL', 'ENTERPRISE')),
  provider_customer_id text,
  provider_subscription_id text,
  status text NOT NULL DEFAULT 'TRIALING' CHECK (status IN (
    'TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED'
  )),
  trial_start timestamptz DEFAULT timezone('utc', now()),
  trial_end timestamptz DEFAULT (timezone('utc', now()) + interval '14 days'),
  current_period_start timestamptz NOT NULL DEFAULT timezone('utc', now()),
  current_period_end timestamptz NOT NULL DEFAULT (timezone('utc', now()) + interval '14 days'),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (organization_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON public.subscriptions (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider ON public.subscriptions (provider, provider_subscription_id);

-- 6. Organization Entitlements (Resolved & Custom overrides)
CREATE TABLE IF NOT EXISTS public.organization_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  custom_override boolean NOT NULL DEFAULT false,
  limit_value integer,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (organization_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_org_entitlements ON public.organization_entitlements (organization_id, feature_key);

-- 7. Usage Counters Table (Tracks real consumption vs limits)
CREATE TABLE IF NOT EXISTS public.usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  current_count integer NOT NULL DEFAULT 0 CHECK (current_count >= 0),
  period_start timestamptz NOT NULL DEFAULT timezone('utc', now()),
  period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (organization_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_org ON public.usage_counters (organization_id, feature_key);

-- 8. Impersonation Sessions Table
CREATE TABLE IF NOT EXISTS public.impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  impersonated_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_impersonation_admin ON public.impersonation_sessions (admin_user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_impersonation_token ON public.impersonation_sessions (token_hash) WHERE revoked_at IS NULL;

-- 9. Row Level Security Hardening
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impersonation_sessions ENABLE ROW LEVEL SECURITY;

-- Plans & Plan Entitlements: Public readable by authenticated users
CREATE POLICY "plans_read_policy" ON public.plans FOR SELECT USING (true);
CREATE POLICY "plan_entitlements_read_policy" ON public.plan_entitlements FOR SELECT USING (true);

-- Subscriptions: Readable by organization members
CREATE POLICY "org_member_read_subscriptions" ON public.subscriptions
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.memberships WHERE user_id = auth.uid()
  ));

-- Organization Entitlements: Readable by organization members
CREATE POLICY "org_member_read_org_entitlements" ON public.organization_entitlements
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.memberships WHERE user_id = auth.uid()
  ));

-- Usage Counters: Readable by organization members
CREATE POLICY "org_member_read_usage_counters" ON public.usage_counters
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.memberships WHERE user_id = auth.uid()
  ));

-- Impersonation Sessions: Only readable/manageable by platform admins or service role
CREATE POLICY "platform_admin_impersonation_policy" ON public.impersonation_sessions
  FOR ALL TO authenticated
  USING (admin_user_id = auth.uid());

-- 10. Backfill existing organizations into subscriptions and organization_entitlements
INSERT INTO public.subscriptions (
  organization_id,
  plan_id,
  provider,
  status,
  trial_start,
  trial_end,
  current_period_start,
  current_period_end
)
SELECT
  o.id,
  'business' AS plan_id,
  'MANUAL' AS provider,
  'ACTIVE' AS status,
  o.created_at,
  o.created_at + interval '365 days',
  o.created_at,
  o.created_at + interval '365 days'
FROM public.organizations o
ON CONFLICT (organization_id) DO NOTHING;

-- Populate organization_entitlements from plan_entitlements for all existing orgs
INSERT INTO public.organization_entitlements (
  organization_id,
  feature_key,
  is_enabled,
  custom_override,
  limit_value
)
SELECT
  s.organization_id,
  pe.feature_key,
  pe.is_enabled,
  false AS custom_override,
  pe.limit_value
FROM public.subscriptions s
JOIN public.plan_entitlements pe ON pe.plan_id = s.plan_id
ON CONFLICT (organization_id, feature_key) DO NOTHING;
