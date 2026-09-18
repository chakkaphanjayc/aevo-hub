-- Server-managed application sessions.
--
-- Supabase Auth remains the identity provider, but browser sessions are
-- represented by an opaque application token. Supabase access/refresh tokens
-- are encrypted by the gateway before they are stored here. This keeps
-- browser JavaScript from ever receiving a bearer token and gives the app a
-- revocable session record for rotation, idle expiry, and audit metadata.

alter table public.organizations
  add column if not exists timezone text not null default 'Asia/Bangkok',
  add column if not exists country text not null default 'TH';

create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  csrf_token_hash text not null,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  access_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid references public.app_sessions(id) on delete set null,
  check (idle_expires_at <= absolute_expires_at),
  check (access_expires_at <= absolute_expires_at)
);

create index if not exists app_sessions_user_active_idx
  on public.app_sessions (user_id, revoked_at, absolute_expires_at);
create index if not exists app_sessions_expiry_idx
  on public.app_sessions (idle_expires_at, absolute_expires_at);

alter table public.app_sessions enable row level security;
revoke all on table public.app_sessions from public, anon, authenticated;
