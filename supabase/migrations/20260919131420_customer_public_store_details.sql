-- Extend the opt-in customer projection with public-facing detail fields.
-- The trusted Customer Gateway is still the only public read path; this table
-- remains unavailable to anon/authenticated Data API callers directly.
alter table public.customer_store_profiles
  add column if not exists media_urls text[] not null default '{}',
  add column if not exists facilities text[] not null default '{}',
  add column if not exists policy_summary text;

alter table public.customer_store_profiles
  drop constraint if exists customer_store_profiles_policy_summary_length;

alter table public.customer_store_profiles
  add constraint customer_store_profiles_policy_summary_length
  check (policy_summary is null or length(policy_summary) <= 2000);
