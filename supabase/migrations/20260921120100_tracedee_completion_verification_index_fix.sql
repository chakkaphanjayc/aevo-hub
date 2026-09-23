-- The completion verification RPC uses an idempotent dedupe-key insert.
-- Keep the same null semantics while making the conflict target inferable by
-- PostgreSQL for that RPC.

drop index if exists public.tracedee_activity_events_dedupe_idx;
create unique index if not exists tracedee_activity_events_dedupe_idx
  on public.tracedee_activity_events (dedupe_key);
