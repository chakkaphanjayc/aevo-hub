-- Aevo Go platform control plane.
--
-- This table stores only server-owned product configuration. Secrets, provider
-- credentials, and customer data stay in their existing managed boundaries.

create table if not exists public.aevo_go_settings (
  setting_key text primary key check (setting_key = 'default'),
  config jsonb not null default '{
    "discovery": {
      "searchEnabled": true,
      "mapEnabled": true,
      "defaultRadiusKm": 15,
      "maxResults": 50
    },
    "community": {
      "traceDeeEnabled": true,
      "commentsEnabled": false,
      "contributionsEnabled": true,
      "requireModeration": true
    },
    "booking": {
      "enabled": true,
      "holdMinutes": 10,
      "maxPartySize": 12
    },
    "notifications": {
      "pushEnabled": true,
      "marketingOptInRequired": true
    },
    "privacy": {
      "allowGuestBrowse": true,
      "requireAccountToSave": true
    },
    "analytics": {
      "enabled": true,
      "retentionDays": 90
    }
  }'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.aevo_go_settings (setting_key, config)
values (
  'default',
  '{
    "discovery": {"searchEnabled": true, "mapEnabled": true, "defaultRadiusKm": 15, "maxResults": 50},
    "community": {"traceDeeEnabled": true, "commentsEnabled": false, "contributionsEnabled": true, "requireModeration": true},
    "booking": {"enabled": true, "holdMinutes": 10, "maxPartySize": 12},
    "notifications": {"pushEnabled": true, "marketingOptInRequired": true},
    "privacy": {"allowGuestBrowse": true, "requireAccountToSave": true},
    "analytics": {"enabled": true, "retentionDays": 90}
  }'::jsonb
)
on conflict (setting_key) do nothing;

drop trigger if exists aevo_go_settings_set_updated_at on public.aevo_go_settings;
create trigger aevo_go_settings_set_updated_at
before update on public.aevo_go_settings
for each row execute function public.set_updated_at();

alter table public.aevo_go_settings enable row level security;
revoke all on table public.aevo_go_settings from public, anon, authenticated;
grant all on table public.aevo_go_settings to service_role;

-- A bounded, read-only aggregate for the Admin dashboard. The browser never
-- receives direct table access and the function is executable only by the
-- trusted gateway/worker runtime. It runs as the caller so it does not create
-- a second RLS bypass; the gateway calls it with the service-role client.
create or replace function public.aevo_go_admin_overview(p_days integer default 30)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  window_days integer := greatest(1, least(coalesce(p_days, 30), 90));
begin
  return jsonb_build_object(
    'asOf', timezone('utc', now()),
    'windowDays', window_days,
    'activePlaces', (
      select count(*)::integer
      from public.tracedee_places
      where moderation_status in ('VISIBLE', 'LIMITED')
    ),
    'publicStores', (
      select count(*)::integer
      from public.customer_store_profiles
      where public_enabled = true
    ),
    'publishedTraces', (
      select count(*)::integer
      from public.tracedee_traces
      where status = 'PUBLISHED' and visibility = 'PUBLIC'
    ),
    'totalJourneys', (
      select count(*)::integer
      from public.tracedee_journeys
    ),
    'completedJourneys', (
      select count(*)::integer
      from public.tracedee_journeys
      where status = 'COMPLETED'
    ),
    'bookingsCreated', (
      select count(*)::integer
      from public.bookings
      where is_demo_data = false
        and created_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'bookingsCompleted', (
      select count(*)::integer
      from public.bookings
      where is_demo_data = false
        and status = 'COMPLETED'
        and created_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'bookingsCancelled', (
      select count(*)::integer
      from public.bookings
      where is_demo_data = false
        and status = 'CANCELLED'
        and created_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'ordersCreated', (
      select count(*)::integer
      from public.orders
      where is_demo_data = false
        and created_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'ordersCompleted', (
      select count(*)::integer
      from public.orders
      where is_demo_data = false
        and status in ('SERVED', 'PICKED_UP', 'COMPLETED')
        and created_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'ratingsCount', (
      select count(*)::integer
      from public.tracedee_trace_ratings
      where moderation_status in ('VISIBLE', 'LIMITED')
    ),
    'averageRating', coalesce((
      select round(avg(rating)::numeric, 2)
      from public.tracedee_trace_ratings
      where moderation_status in ('VISIBLE', 'LIMITED')
    ), 0),
    'openReports', (
      select count(*)::integer
      from public.tracedee_content_reports
      where status in ('OPEN', 'REVIEWING')
    ),
    'activityEvents', (
      select count(*)::integer
      from public.tracedee_activity_events
      where source = 'aevo-go'
        and occurred_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'feedImpressions', (
      select count(*)::integer
      from public.tracedee_feed_impressions
      where occurred_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'feedInteractions', (
      select count(*)::integer
      from public.tracedee_feed_interactions
      where occurred_at >= timezone('utc', now()) - make_interval(days => window_days)
    ),
    'pendingOutbox', (
      select count(*)::integer
      from public.tracedee_event_outbox
      where status in ('PENDING', 'PROCESSING', 'FAILED')
    ),
    'enabledFeatureFlags', (
      select count(*)::integer
      from public.tracedee_feature_flags
      where enabled = true and rollout_percent > 0
    ),
    'featureFlagCount', (
      select count(*)::integer
      from public.tracedee_feature_flags
    ),
    'dailyActivity', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'date', series.day::date,
          'events', coalesce(activity.events, 0),
          'impressions', coalesce(activity.impressions, 0),
          'interactions', coalesce(activity.interactions, 0)
        )
        order by series.day
      )
      from generate_series(
        (timezone('utc', now())::date - (window_days - 1)),
        timezone('utc', now())::date,
        interval '1 day'
      ) as series(day)
      left join (
        select
          raw_activity.day,
          sum(raw_activity.events)::integer as events,
          sum(raw_activity.impressions)::integer as impressions,
          sum(raw_activity.interactions)::integer as interactions
        from (
          select
            timezone('utc', occurred_at)::date as day,
            count(*)::integer as events,
            0::integer as impressions,
            0::integer as interactions
          from public.tracedee_activity_events
          where source = 'aevo-go'
            and occurred_at >= timezone('utc', now()) - make_interval(days => window_days)
          group by timezone('utc', occurred_at)::date
          union all
          select
            timezone('utc', occurred_at)::date as day,
            0::integer as events,
            count(*)::integer as impressions,
            0::integer as interactions
          from public.tracedee_feed_impressions
          where occurred_at >= timezone('utc', now()) - make_interval(days => window_days)
          group by timezone('utc', occurred_at)::date
          union all
          select
            timezone('utc', occurred_at)::date as day,
            0::integer as events,
            0::integer as impressions,
            count(*)::integer as interactions
          from public.tracedee_feed_interactions
          where occurred_at >= timezone('utc', now()) - make_interval(days => window_days)
          group by timezone('utc', occurred_at)::date
        ) as raw_activity
        group by raw_activity.day
      ) as activity on activity.day = series.day::date
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.aevo_go_admin_overview(integer) from public, anon, authenticated;
grant execute on function public.aevo_go_admin_overview(integer) to service_role;

-- The overview is intentionally aggregate-only, but it is still a recurring
-- admin query. Keep its time/status predicates indexed as the TraceDee event
-- tables grow.
create index if not exists tracedee_journeys_status_idx
  on public.tracedee_journeys (status, updated_at desc);

create index if not exists tracedee_trace_ratings_moderation_idx
  on public.tracedee_trace_ratings (moderation_status, created_at desc);

create index if not exists tracedee_content_reports_status_idx
  on public.tracedee_content_reports (status, created_at desc);

create index if not exists tracedee_activity_events_source_time_idx
  on public.tracedee_activity_events (source, occurred_at desc);

create index if not exists tracedee_feed_impressions_occurred_idx
  on public.tracedee_feed_impressions (occurred_at desc);

create index if not exists tracedee_feed_interactions_occurred_idx
  on public.tracedee_feed_interactions (occurred_at desc);

create index if not exists bookings_customer_window_status_idx
  on public.bookings (created_at desc, status)
  where is_demo_data = false;

create index if not exists orders_customer_window_status_idx
  on public.orders (created_at desc, status)
  where is_demo_data = false;
