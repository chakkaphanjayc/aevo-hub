-- Customer account favorites are separate from Hub navigation favorites.
-- The Customer Gateway is the only normal reader/writer; guest intent stays
-- in Aevo Go local storage until an account session exists.
create table if not exists public.customer_favorites (
  customer_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (customer_id, store_id)
);

create index if not exists customer_favorites_customer_created_idx
  on public.customer_favorites (customer_id, created_at desc);

alter table public.customer_favorites enable row level security;
revoke all on table public.customer_favorites from anon, authenticated;

drop policy if exists customer_favorites_no_direct_browser_access on public.customer_favorites;
create policy customer_favorites_no_direct_browser_access
  on public.customer_favorites
  for all
  to anon, authenticated
  using (false)
  with check (false);
