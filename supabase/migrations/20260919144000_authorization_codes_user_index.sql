-- Keep the user foreign-key lookup covered on deployments where the base
-- authorization-code migration has already been applied.
create index if not exists app_authorization_codes_user_idx
  on public.app_authorization_codes (user_id, app_code, expires_at);
