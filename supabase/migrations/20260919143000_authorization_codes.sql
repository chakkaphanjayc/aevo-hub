-- Short-lived, single-use authorization codes for first-party app entry.
-- The code is only a handoff credential. Supabase tokens remain encrypted in
-- the server-managed app_sessions rows and are never returned to a browser.

create table if not exists public.app_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  app_code text not null references public.application_registry(code) on update cascade on delete restrict,
  return_path text not null,
  state_hash text,
  code_challenge text,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  user_agent text,
  ip_address text,
  check (expires_at > created_at),
  check (return_path like '/%' and return_path not like '//%')
);

create index if not exists app_authorization_codes_active_idx
  on public.app_authorization_codes (app_code, expires_at, consumed_at);

create index if not exists app_authorization_codes_user_idx
  on public.app_authorization_codes (user_id, app_code, expires_at);

alter table public.app_authorization_codes enable row level security;
revoke all on table public.app_authorization_codes from public, anon, authenticated;
grant all on table public.app_authorization_codes to service_role;
