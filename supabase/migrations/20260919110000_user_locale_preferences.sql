-- Store the user's durable UI language preference on the profile that owns
-- the application session. NULL intentionally means "not chosen yet": the
-- web shell can detect the device language once and persist that choice
-- without confusing it with an explicit English selection.
alter table public.user_profiles
  add column if not exists locale text;

update public.user_profiles
set locale = null
where locale is not null
  and locale not in ('en', 'th');

alter table public.user_profiles
  drop constraint if exists user_profiles_locale_check;

alter table public.user_profiles
  add constraint user_profiles_locale_check
  check (locale is null or locale in ('en', 'th'));

comment on column public.user_profiles.locale is
  'Per-user Aevo Hub interface locale. NULL is resolved from the device on first authenticated visit.';
