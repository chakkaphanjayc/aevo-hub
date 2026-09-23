-- TraceDee Product Loop Phase 0.
--
-- TraceDee deliberately owns a separate, prefixed domain surface. The
-- existing tenant-scoped `domain_events`/`outbox_events` tables require an
-- organization_id, while customer discovery events can be anonymous and
-- cross-tenant. Keeping this append-only event pipeline separate preserves
-- the platform boundary and makes replay/idempotency explicit.

create extension if not exists pgcrypto;
create extension if not exists postgis;

create table if not exists public.tracedee_feature_flags (
  flag_key text primary key check (flag_key in (
    'mixed_feed',
    'trace_journey',
    'comments_v2',
    'expertise_v1',
    'taste_ranking_v1'
  )),
  enabled boolean not null default false,
  rollout_percent integer not null default 0 check (rollout_percent between 0 and 100),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_places (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null default 'EXTERNAL' check (source_kind in ('STORE', 'EXTERNAL')),
  store_id uuid references public.stores(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete set null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  name text not null check (length(trim(name)) between 1 and 180),
  area text not null default '' check (length(area) <= 120),
  category text not null default '' check (length(category) <= 120),
  topic_tags text[] not null default '{}'::text[],
  description text not null default '' check (length(description) <= 4000),
  image_url text,
  latitude numeric(9,6) check (latitude between -90 and 90),
  longitude numeric(9,6) check (longitude between -180 and 180),
  location public.geography(point, 4326),
  moderation_status text not null default 'VISIBLE' check (moderation_status in ('VISIBLE', 'LIMITED', 'UNDER_REVIEW', 'REMOVED')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((latitude is null and longitude is null) or (latitude is not null and longitude is not null))
);

create table if not exists public.tracedee_traces (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete restrict,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  title text not null check (length(trim(title)) between 1 and 180),
  description text not null default '' check (length(description) <= 6000),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'UNDER_REVIEW', 'REMOVED', 'ARCHIVED')),
  visibility text not null default 'PUBLIC' check (visibility in ('PUBLIC', 'UNLISTED', 'PRIVATE')),
  revision integer not null default 1 check (revision > 0),
  root_trace_id uuid references public.tracedee_traces(id) on delete set null,
  source_trace_id uuid references public.tracedee_traces(id) on delete set null,
  lineage_depth integer not null default 0 check (lineage_depth between 0 and 20),
  cover_place_id uuid references public.tracedee_places(id) on delete set null,
  area text not null default '' check (length(area) <= 120),
  topic_tags text[] not null default '{}'::text[],
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes between 1 and 10080),
  estimated_budget_minor integer check (estimated_budget_minor is null or estimated_budget_minor >= 0),
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (root_trace_id is null or root_trace_id <> id),
  check (source_trace_id is null or source_trace_id <> id),
  check (status <> 'PUBLISHED' or published_at is not null),
  check (status <> 'PUBLISHED' or visibility = 'PUBLIC')
);

create table if not exists public.tracedee_trace_stops (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references public.tracedee_traces(id) on delete cascade,
  place_id uuid not null references public.tracedee_places(id) on delete restrict,
  position integer not null check (position >= 0),
  note text not null default '' check (length(note) <= 2000),
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  transport_mode text check (transport_mode is null or transport_mode in ('WALK', 'BIKE', 'TRANSIT', 'CAR', 'RIDE_HAIL', 'OTHER')),
  budget_minor integer check (budget_minor is null or budget_minor >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (trace_id, position)
);

create table if not exists public.tracedee_trace_saves (
  trace_id uuid not null references public.tracedee_traces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (trace_id, user_id)
);

create table if not exists public.tracedee_trace_follows (
  trace_id uuid not null references public.tracedee_traces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (trace_id, user_id)
);

create table if not exists public.tracedee_tracer_follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  tracer_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (follower_id, tracer_id),
  check (follower_id <> tracer_id)
);

create table if not exists public.tracedee_trace_remixes (
  id uuid primary key default gen_random_uuid(),
  source_trace_id uuid not null references public.tracedee_traces(id) on delete restrict,
  remix_trace_id uuid not null unique references public.tracedee_traces(id) on delete cascade,
  remixer_id uuid not null references auth.users(id) on delete restrict,
  lineage_depth integer not null check (lineage_depth between 1 and 20),
  created_at timestamptz not null default timezone('utc', now()),
  check (source_trace_id <> remix_trace_id)
);

create table if not exists public.tracedee_journeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trace_id uuid not null references public.tracedee_traces(id) on delete restrict,
  trace_revision integer not null check (trace_revision > 0),
  status text not null default 'PLANNED' check (status in ('PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED')),
  version integer not null default 1 check (version > 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (status <> 'COMPLETED' or completed_at is not null)
);

create table if not exists public.tracedee_journey_stops (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references public.tracedee_journeys(id) on delete cascade,
  trace_stop_id uuid not null references public.tracedee_trace_stops(id) on delete restrict,
  position integer not null check (position >= 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'COMPLETED', 'SKIPPED')),
  version integer not null default 1 check (version > 0),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (journey_id, position),
  unique (journey_id, trace_stop_id)
);

create table if not exists public.tracedee_completions (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null unique references public.tracedee_journeys(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  trace_id uuid not null references public.tracedee_traces(id) on delete restrict,
  completed_stop_count integer not null default 0 check (completed_stop_count >= 0),
  stop_count integer not null default 0 check (stop_count >= 0),
  completion_ratio numeric(5,4) not null default 0 check (completion_ratio between 0 and 1),
  verification_status text not null default 'SELF_REPORTED' check (verification_status in ('SELF_REPORTED', 'PARTIAL', 'VERIFIED', 'REJECTED')),
  verification_summary jsonb not null default '{}'::jsonb,
  completed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  check (completed_stop_count <= stop_count)
);

create table if not exists public.tracedee_trace_ratings (
  id uuid primary key default gen_random_uuid(),
  completion_id uuid not null unique references public.tracedee_completions(id) on delete restrict,
  trace_id uuid not null references public.tracedee_traces(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  tags text[] not null default '{}'::text[],
  review text not null default '' check (length(review) <= 3000),
  moderation_status text not null default 'VISIBLE' check (moderation_status in ('VISIBLE', 'LIMITED', 'UNDER_REVIEW', 'REMOVED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (trace_id, user_id)
);

create table if not exists public.tracedee_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete restrict,
  trace_id uuid references public.tracedee_traces(id) on delete set null,
  place_id uuid references public.tracedee_places(id) on delete set null,
  body text not null check (length(trim(body)) between 1 and 8000),
  status text not null default 'VISIBLE' check (status in ('VISIBLE', 'LIMITED', 'UNDER_REVIEW', 'REMOVED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_comment_threads (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null unique references public.tracedee_posts(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.tracedee_comment_threads(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete restrict,
  parent_id uuid references public.tracedee_comments(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 3000),
  depth smallint not null default 0 check (depth between 0 and 1),
  status text not null default 'VISIBLE' check (status in ('VISIBLE', 'LIMITED', 'UNDER_REVIEW', 'REMOVED')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((parent_id is null and depth = 0) or (parent_id is not null and depth = 1))
);

create table if not exists public.tracedee_comment_reactions (
  comment_id uuid not null references public.tracedee_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null check (reaction in ('HELPFUL', 'LIKE')),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (comment_id, user_id, reaction)
);

create table if not exists public.tracedee_content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('TRACE', 'PLACE', 'POST', 'COMMENT', 'PROFILE')),
  entity_id uuid not null,
  reason text not null check (length(trim(reason)) between 1 and 120),
  details text not null default '' check (length(details) <= 2000),
  status text not null default 'OPEN' check (status in ('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (reporter_id, entity_type, entity_id)
);

create table if not exists public.tracedee_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null check (length(trim(event_type)) between 1 and 120),
  entity_type text not null check (length(trim(entity_type)) between 1 and 80),
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_activity_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'feed_item_impressed',
    'feed_item_opened',
    'place_saved',
    'trace_saved',
    'trace_unsaved',
    'tracer_followed',
    'tracer_unfollowed',
    'trace_followed',
    'trace_unfollowed',
    'trace_started',
    'trace_stop_completed',
    'trace_stop_skipped',
    'trace_completed',
    'trace_remixed',
    'trace_rated',
    'post_created',
    'comment_created',
    'comment_marked_helpful',
    'content_reported'
  )),
  actor_id uuid references auth.users(id) on delete set null,
  source text not null default 'aevo-go' check (length(trim(source)) between 1 and 80),
  session_id text check (session_id is null or length(session_id) <= 200),
  entity_type text not null check (length(trim(entity_type)) between 1 and 80),
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1 check (schema_version > 0),
  tracking_token uuid not null default gen_random_uuid(),
  correlation_id uuid not null default gen_random_uuid(),
  dedupe_key text,
  occurred_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_event_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.tracedee_activity_events(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default timezone('utc', now()),
  locked_until timestamptz,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (length(trim(scope)) between 1 and 160),
  key text not null check (length(trim(key)) between 8 and 200),
  request_hash text not null check (length(trim(request_hash)) between 8 and 200),
  response_status integer,
  response_body jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (actor_id, scope, key)
);

create table if not exists public.tracedee_profile_scores (
  profile_id uuid primary key references auth.users(id) on delete cascade,
  score_version integer not null default 1 check (score_version > 0),
  xp integer not null default 0 check (xp >= 0),
  expertise numeric(10,4) not null default 0 check (expertise >= 0),
  reputation numeric(10,4) not null default 0,
  confidence numeric(10,4) not null default 0 check (confidence between 0 and 1),
  components jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_expertise_scores (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references auth.users(id) on delete cascade,
  topic text not null check (length(trim(topic)) between 1 and 120),
  score_version integer not null default 1 check (score_version > 0),
  score numeric(10,4) not null default 0,
  evidence_count integer not null default 0 check (evidence_count >= 0),
  confidence numeric(10,4) not null default 0 check (confidence between 0 and 1),
  components jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default timezone('utc', now()),
  unique (profile_id, topic, score_version)
);

create table if not exists public.tracedee_taste_affinities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references auth.users(id) on delete cascade,
  dimension_type text not null check (dimension_type in ('TOPIC', 'AREA', 'CATEGORY', 'PACE', 'BUDGET')),
  dimension_key text not null check (length(trim(dimension_key)) between 1 and 160),
  score_version integer not null default 1 check (score_version > 0),
  affinity numeric(10,4) not null default 0,
  evidence_count integer not null default 0 check (evidence_count >= 0),
  calculated_at timestamptz not null default timezone('utc', now()),
  unique (profile_id, dimension_type, dimension_key, score_version)
);

create table if not exists public.tracedee_content_quality_scores (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('TRACE', 'PLACE', 'POST', 'COMMENT')),
  entity_id uuid not null,
  score_version integer not null default 1 check (score_version > 0),
  score numeric(10,4) not null default 0,
  confidence numeric(10,4) not null default 0 check (confidence between 0 and 1),
  components jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default timezone('utc', now()),
  unique (entity_type, entity_id, score_version)
);

create table if not exists public.tracedee_feed_impressions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  item_type text not null check (item_type in ('PLACE', 'TRACE', 'POST', 'TRACER')),
  item_id uuid not null,
  tracking_token uuid not null,
  viewport_threshold numeric(4,3) not null default 0.5 check (viewport_threshold between 0 and 1),
  position integer check (position is null or position >= 0),
  occurred_at timestamptz not null default timezone('utc', now()),
  unique (tracking_token, item_type, item_id)
);

create table if not exists public.tracedee_feed_interactions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  item_type text not null check (item_type in ('PLACE', 'TRACE', 'POST', 'TRACER')),
  item_id uuid not null,
  interaction_type text not null check (interaction_type in ('OPENED', 'SAVED', 'FOLLOWED', 'DISMISSED', 'SHARED')),
  tracking_token uuid,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tracedee_recommendation_snapshots (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references auth.users(id) on delete cascade,
  model_version text not null check (length(trim(model_version)) between 1 and 120),
  context jsonb not null default '{}'::jsonb,
  item_ids jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz
);

create index if not exists tracedee_places_location_gist
  on public.tracedee_places using gist (location)
  where moderation_status in ('VISIBLE', 'LIMITED') and location is not null;
create index if not exists tracedee_places_status_area_idx
  on public.tracedee_places (moderation_status, area, created_at desc);
create index if not exists tracedee_traces_public_feed_idx
  on public.tracedee_traces (status, visibility, published_at desc, id desc);
create index if not exists tracedee_traces_creator_idx
  on public.tracedee_traces (creator_id, status, created_at desc);
create index if not exists tracedee_trace_stops_trace_position_idx
  on public.tracedee_trace_stops (trace_id, position);
create index if not exists tracedee_trace_saves_user_idx
  on public.tracedee_trace_saves (user_id, created_at desc);
create index if not exists tracedee_trace_follows_user_idx
  on public.tracedee_trace_follows (user_id, created_at desc);
create index if not exists tracedee_tracer_follows_tracer_idx
  on public.tracedee_tracer_follows (tracer_id, created_at desc);
create index if not exists tracedee_journeys_user_status_idx
  on public.tracedee_journeys (user_id, status, updated_at desc);
create unique index if not exists tracedee_journeys_one_active_idx
  on public.tracedee_journeys (user_id, trace_id)
  where status in ('PLANNED', 'ACTIVE', 'PAUSED');
create index if not exists tracedee_posts_trace_created_idx
  on public.tracedee_posts (trace_id, status, created_at desc);
create index if not exists tracedee_comments_thread_created_idx
  on public.tracedee_comments (thread_id, status, created_at asc);
create index if not exists tracedee_notifications_recipient_idx
  on public.tracedee_notifications (recipient_id, read_at, created_at desc);
create unique index if not exists tracedee_activity_events_dedupe_idx
  on public.tracedee_activity_events (dedupe_key)
  where dedupe_key is not null;
create index if not exists tracedee_activity_events_type_time_idx
  on public.tracedee_activity_events (event_type, occurred_at desc);
create index if not exists tracedee_activity_events_actor_time_idx
  on public.tracedee_activity_events (actor_id, occurred_at desc);
create index if not exists tracedee_event_outbox_pending_idx
  on public.tracedee_event_outbox (status, available_at, created_at);
create index if not exists tracedee_idempotency_expiry_idx
  on public.tracedee_idempotency_keys (expires_at);
create index if not exists tracedee_quality_entity_idx
  on public.tracedee_content_quality_scores (entity_type, entity_id, score_version desc);

create or replace function public.sync_tracedee_place_location()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.latitude is null or new.longitude is null then
    new.location := null;
  else
    new.location := st_setsrid(
      st_makepoint(new.longitude::double precision, new.latitude::double precision),
      4326
    )::public.geography;
  end if;
  return new;
end;
$$;

drop trigger if exists tracedee_places_sync_location on public.tracedee_places;
create trigger tracedee_places_sync_location
before insert or update of latitude, longitude on public.tracedee_places
for each row execute function public.sync_tracedee_place_location();

update public.tracedee_places
set location = st_setsrid(
  st_makepoint(longitude::double precision, latitude::double precision),
  4326
)::public.geography
where latitude is not null and longitude is not null and location is null;

do $$
declare
  table_name text;
begin
  if to_regprocedure('public.set_updated_at()') is not null then
    for table_name in select unnest(array[
      'tracedee_feature_flags',
      'tracedee_places',
      'tracedee_traces',
      'tracedee_trace_stops',
      'tracedee_journeys',
      'tracedee_journey_stops',
      'tracedee_trace_ratings',
      'tracedee_posts',
      'tracedee_comments',
      'tracedee_event_outbox',
      'tracedee_profile_scores'
    ]) loop
      execute format('drop trigger if exists %I_set_updated_at on public.%I', table_name, table_name);
      execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name);
    end loop;
  end if;
end;
$$;

create or replace function public.prevent_tracedee_activity_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception using errcode = 'P0001', message = 'TRACEDEE_ACTIVITY_EVENT_IMMUTABLE';
end;
$$;

drop trigger if exists tracedee_activity_events_immutable on public.tracedee_activity_events;
create trigger tracedee_activity_events_immutable
before update or delete on public.tracedee_activity_events
for each row execute function public.prevent_tracedee_activity_event_mutation();

insert into public.tracedee_feature_flags (flag_key, enabled, rollout_percent, config)
values
  ('mixed_feed', true, 100, '{"composition":"trace_first","version":1}'::jsonb),
  ('trace_journey', true, 100, '{"maxStops":20,"version":1}'::jsonb),
  ('comments_v2', false, 0, '{"version":1}'::jsonb),
  ('expertise_v1', false, 0, '{"version":1}'::jsonb),
  ('taste_ranking_v1', false, 0, '{"version":1}'::jsonb)
on conflict (flag_key) do update set
  config = excluded.config,
  updated_at = timezone('utc', now());

-- The API is the only supported access path for this customer domain. No
-- browser role receives direct table access; the service role is held only by
-- the Gateway/worker runtime.
alter table public.tracedee_feature_flags enable row level security;
alter table public.tracedee_places enable row level security;
alter table public.tracedee_traces enable row level security;
alter table public.tracedee_trace_stops enable row level security;
alter table public.tracedee_trace_saves enable row level security;
alter table public.tracedee_trace_follows enable row level security;
alter table public.tracedee_tracer_follows enable row level security;
alter table public.tracedee_trace_remixes enable row level security;
alter table public.tracedee_journeys enable row level security;
alter table public.tracedee_journey_stops enable row level security;
alter table public.tracedee_completions enable row level security;
alter table public.tracedee_trace_ratings enable row level security;
alter table public.tracedee_posts enable row level security;
alter table public.tracedee_comment_threads enable row level security;
alter table public.tracedee_comments enable row level security;
alter table public.tracedee_comment_reactions enable row level security;
alter table public.tracedee_content_reports enable row level security;
alter table public.tracedee_notifications enable row level security;
alter table public.tracedee_activity_events enable row level security;
alter table public.tracedee_event_outbox enable row level security;
alter table public.tracedee_idempotency_keys enable row level security;
alter table public.tracedee_profile_scores enable row level security;
alter table public.tracedee_expertise_scores enable row level security;
alter table public.tracedee_taste_affinities enable row level security;
alter table public.tracedee_content_quality_scores enable row level security;
alter table public.tracedee_feed_impressions enable row level security;
alter table public.tracedee_feed_interactions enable row level security;
alter table public.tracedee_recommendation_snapshots enable row level security;

revoke all on table
  public.tracedee_feature_flags,
  public.tracedee_places,
  public.tracedee_traces,
  public.tracedee_trace_stops,
  public.tracedee_trace_saves,
  public.tracedee_trace_follows,
  public.tracedee_tracer_follows,
  public.tracedee_trace_remixes,
  public.tracedee_journeys,
  public.tracedee_journey_stops,
  public.tracedee_completions,
  public.tracedee_trace_ratings,
  public.tracedee_posts,
  public.tracedee_comment_threads,
  public.tracedee_comments,
  public.tracedee_comment_reactions,
  public.tracedee_content_reports,
  public.tracedee_notifications,
  public.tracedee_activity_events,
  public.tracedee_event_outbox,
  public.tracedee_idempotency_keys,
  public.tracedee_profile_scores,
  public.tracedee_expertise_scores,
  public.tracedee_taste_affinities,
  public.tracedee_content_quality_scores,
  public.tracedee_feed_impressions,
  public.tracedee_feed_interactions,
  public.tracedee_recommendation_snapshots
from public, anon, authenticated;

grant all on table
  public.tracedee_feature_flags,
  public.tracedee_places,
  public.tracedee_traces,
  public.tracedee_trace_stops,
  public.tracedee_trace_saves,
  public.tracedee_trace_follows,
  public.tracedee_tracer_follows,
  public.tracedee_trace_remixes,
  public.tracedee_journeys,
  public.tracedee_journey_stops,
  public.tracedee_completions,
  public.tracedee_trace_ratings,
  public.tracedee_posts,
  public.tracedee_comment_threads,
  public.tracedee_comments,
  public.tracedee_comment_reactions,
  public.tracedee_content_reports,
  public.tracedee_notifications,
  public.tracedee_activity_events,
  public.tracedee_event_outbox,
  public.tracedee_idempotency_keys,
  public.tracedee_profile_scores,
  public.tracedee_expertise_scores,
  public.tracedee_taste_affinities,
  public.tracedee_content_quality_scores,
  public.tracedee_feed_impressions,
  public.tracedee_feed_interactions,
  public.tracedee_recommendation_snapshots
to service_role;

create or replace function public.tracedee_trace_action(
  p_actor_id uuid,
  p_trace_id uuid,
  p_action text,
  p_idempotency_key text,
  p_request_hash text,
  p_source text default 'aevo-go',
  p_session_id text default null,
  p_tracking_token uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_trace record;
  v_existing record;
  v_idempotency_id uuid;
  v_event_id uuid;
  v_event_type text;
  v_correlation_id uuid := gen_random_uuid();
  v_tracking_token uuid := coalesce(p_tracking_token, gen_random_uuid());
  v_changed boolean := false;
  v_saved boolean := false;
  v_followed boolean := false;
  v_rows integer := 0;
  v_response jsonb;
begin
  if p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHORIZED';
  end if;
  if p_action not in ('SAVE', 'UNSAVE', 'FOLLOW', 'UNFOLLOW') then
    raise exception using errcode = 'P0001', message = 'TRACE_ACTION_NOT_SUPPORTED';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 200 then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if length(trim(coalesce(p_request_hash, ''))) < 8 or length(trim(p_request_hash)) > 200 then
    raise exception using errcode = 'P0001', message = 'REQUEST_HASH_INVALID';
  end if;

  select id, revision
  into v_trace
  from public.tracedee_traces
  where id = p_trace_id
    and status = 'PUBLISHED'
    and visibility = 'PUBLIC';
  if not found then
    raise exception using errcode = 'P0001', message = 'TRACE_NOT_FOUND';
  end if;

  insert into public.tracedee_idempotency_keys (actor_id, scope, key, request_hash, expires_at)
  values (p_actor_id, 'tracedee:trace:' || lower(p_action), trim(p_idempotency_key), trim(p_request_hash), timezone('utc', now()) + interval '24 hours')
  on conflict (actor_id, scope, key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select request_hash, response_body
    into v_existing
    from public.tracedee_idempotency_keys
    where actor_id = p_actor_id
      and scope = 'tracedee:trace:' || lower(p_action)
      and key = trim(p_idempotency_key);
    if v_existing.request_hash <> trim(p_request_hash) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_existing.response_body is null then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_existing.response_body;
  end if;

  if p_action = 'SAVE' then
    insert into public.tracedee_trace_saves (trace_id, user_id)
    values (p_trace_id, p_actor_id)
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
    v_event_type := 'trace_saved';
  elsif p_action = 'UNSAVE' then
    delete from public.tracedee_trace_saves where trace_id = p_trace_id and user_id = p_actor_id;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
    v_event_type := 'trace_unsaved';
  elsif p_action = 'FOLLOW' then
    insert into public.tracedee_trace_follows (trace_id, user_id)
    values (p_trace_id, p_actor_id)
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
    v_event_type := 'trace_followed';
  else
    delete from public.tracedee_trace_follows where trace_id = p_trace_id and user_id = p_actor_id;
    get diagnostics v_rows = row_count;
    v_changed := v_rows > 0;
    v_event_type := 'trace_unfollowed';
  end if;

  select exists(select 1 from public.tracedee_trace_saves where trace_id = p_trace_id and user_id = p_actor_id)
  into v_saved;
  select exists(select 1 from public.tracedee_trace_follows where trace_id = p_trace_id and user_id = p_actor_id)
  into v_followed;

  if v_changed then
    insert into public.tracedee_activity_events (
      event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
      tracking_token, correlation_id, dedupe_key
    )
    values (
      v_event_type, p_actor_id, coalesce(nullif(trim(p_source), ''), 'aevo-go'), p_session_id,
      'TRACE', p_trace_id,
      jsonb_build_object('action', lower(p_action), 'traceRevision', v_trace.revision),
      v_tracking_token, v_correlation_id,
      'trace-action:' || p_actor_id::text || ':' || lower(p_action) || ':' || trim(p_idempotency_key)
    )
    returning id into v_event_id;

    insert into public.tracedee_event_outbox (event_id)
    values (v_event_id);
  end if;

  v_response := jsonb_build_object(
    'ok', true,
    'traceId', p_trace_id,
    'action', lower(p_action),
    'saved', v_saved,
    'followed', v_followed,
    'changed', v_changed,
    'stateVersion', v_trace.revision,
    'eventId', v_event_id,
    'correlationId', v_correlation_id,
    'trackingToken', v_tracking_token
  );

  update public.tracedee_idempotency_keys
  set response_status = 200, response_body = v_response
  where id = v_idempotency_id;
  return v_response;
end;
$$;

create or replace function public.tracedee_record_activity_event(
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid default null,
  p_actor_id uuid default null,
  p_source text default 'aevo-go',
  p_session_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_tracking_token uuid default null,
  p_correlation_id uuid default null,
  p_dedupe_key text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_event_id uuid;
  v_tracking_token uuid := coalesce(p_tracking_token, gen_random_uuid());
  v_correlation_id uuid := coalesce(p_correlation_id, gen_random_uuid());
  v_inserted boolean := false;
begin
  if p_event_type not in (
    'feed_item_impressed', 'feed_item_opened', 'place_saved', 'trace_saved',
    'tracer_followed', 'trace_followed', 'trace_started', 'trace_stop_completed',
    'trace_stop_skipped', 'trace_completed', 'trace_remixed', 'trace_rated',
    'post_created', 'comment_created', 'comment_marked_helpful', 'content_reported'
  ) then
    raise exception using errcode = 'P0001', message = 'ACTIVITY_EVENT_NOT_SUPPORTED';
  end if;
  if length(trim(coalesce(p_entity_type, ''))) < 1 then
    raise exception using errcode = 'P0001', message = 'ACTIVITY_ENTITY_TYPE_INVALID';
  end if;

  insert into public.tracedee_activity_events (
    event_type, actor_id, source, session_id, entity_type, entity_id, metadata,
    tracking_token, correlation_id, dedupe_key
  )
  values (
    p_event_type, p_actor_id, coalesce(nullif(trim(p_source), ''), 'aevo-go'), p_session_id,
    trim(p_entity_type), p_entity_id, coalesce(p_metadata, '{}'::jsonb),
    v_tracking_token, v_correlation_id, nullif(trim(p_dedupe_key), '')
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_event_id;

  if v_event_id is null and p_dedupe_key is not null then
    select id, tracking_token, correlation_id
    into v_event_id, v_tracking_token, v_correlation_id
    from public.tracedee_activity_events
    where dedupe_key = nullif(trim(p_dedupe_key), '');
  else
    v_inserted := true;
    insert into public.tracedee_event_outbox (event_id) values (v_event_id);
  end if;

  return jsonb_build_object(
    'ok', true,
    'eventId', v_event_id,
    'trackingToken', v_tracking_token,
    'correlationId', v_correlation_id,
    'deduped', not v_inserted
  );
end;
$$;

create or replace function public.tracedee_discovery_feed(
  p_actor_id uuid default null,
  p_tab text default 'for_you',
  p_query text default null,
  p_area text default null,
  p_after_score numeric default null,
  p_after_published_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 20
)
returns table (
  item_type text,
  item_id uuid,
  slug text,
  title text,
  description text,
  creator_id uuid,
  creator_name text,
  status text,
  visibility text,
  cover_place_id uuid,
  area text,
  topic_tags text[],
  stop_count integer,
  follower_count bigint,
  save_count bigint,
  rank_score numeric,
  reason_code text,
  reason_params jsonb,
  tracking_token uuid,
  published_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with base as (
    select
      t.id,
      t.slug,
      t.title,
      t.description,
      t.creator_id,
      coalesce(nullif(up.display_name, ''), nullif(up.email, ''), 'Aevo member') as creator_name,
      t.status,
      t.visibility,
      t.cover_place_id,
      t.area,
      t.topic_tags,
      coalesce((select count(*) from public.tracedee_trace_stops s where s.trace_id = t.id), 0)::integer as stop_count,
      coalesce((select count(*) from public.tracedee_trace_follows f where f.trace_id = t.id), 0)::bigint as follower_count,
      coalesce((select count(*) from public.tracedee_trace_saves s where s.trace_id = t.id), 0)::bigint as save_count,
      coalesce((select q.score from public.tracedee_content_quality_scores q where q.entity_type = 'TRACE' and q.entity_id = t.id order by q.score_version desc limit 1), 0)::numeric
        + coalesce((select count(*) from public.tracedee_trace_saves s where s.trace_id = t.id), 0)::numeric * 10
        + coalesce((select count(*) from public.tracedee_trace_follows f where f.trace_id = t.id), 0)::numeric * 5
        + case when p_actor_id is not null and exists (
            select 1 from public.tracedee_tracer_follows tf
            where tf.follower_id = p_actor_id and tf.tracer_id = t.creator_id
          ) then 1000 else 0 end as computed_score,
      case
        when p_actor_id is not null and exists (
          select 1 from public.tracedee_tracer_follows tf
          where tf.follower_id = p_actor_id and tf.tracer_id = t.creator_id
        ) then 'FOLLOWING_TRACER'
        when (select count(*) from public.tracedee_trace_saves s where s.trace_id = t.id)
          + (select count(*) from public.tracedee_trace_follows f where f.trace_id = t.id) > 0 then 'POPULAR'
        else 'NEW_TRACE'
      end as computed_reason,
      coalesce(t.published_at, t.created_at) as effective_published_at
    from public.tracedee_traces t
    left join public.user_profiles up on up.id = t.creator_id
    where t.status = 'PUBLISHED'
      and t.visibility = 'PUBLIC'
      and (p_query is null or lower(concat_ws(' ', t.title, t.description, t.area, array_to_string(t.topic_tags, ' '))) like '%' || lower(trim(p_query)) || '%')
      and (p_area is null or lower(t.area) = lower(trim(p_area)))
      and (p_tab <> 'following' or (p_actor_id is not null and exists (
        select 1 from public.tracedee_tracer_follows tf
        where tf.follower_id = p_actor_id and tf.tracer_id = t.creator_id
      )))
  )
  select
    'TRACE'::text,
    b.id,
    b.slug,
    b.title,
    b.description,
    b.creator_id,
    b.creator_name,
    b.status,
    b.visibility,
    b.cover_place_id,
    b.area,
    b.topic_tags,
    b.stop_count,
    b.follower_count,
    b.save_count,
    b.computed_score,
    b.computed_reason,
    jsonb_build_object('area', b.area, 'stopCount', b.stop_count, 'creatorId', b.creator_id),
    gen_random_uuid(),
    b.effective_published_at
  from base b
  where (
    p_after_id is null
    or b.computed_score < p_after_score
    or (b.computed_score = p_after_score and b.effective_published_at < p_after_published_at)
    or (b.computed_score = p_after_score and b.effective_published_at = p_after_published_at and b.id < p_after_id)
  )
  order by b.computed_score desc, b.effective_published_at desc, b.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 48);
$$;

revoke all on function public.tracedee_trace_action(uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.tracedee_trace_action(uuid, uuid, text, text, text, text, text, uuid) to service_role;
revoke all on function public.tracedee_record_activity_event(text, text, uuid, uuid, text, text, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.tracedee_record_activity_event(text, text, uuid, uuid, text, text, jsonb, uuid, uuid, text) to service_role;
revoke all on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_discovery_feed(uuid, text, text, text, numeric, timestamptz, uuid, integer) to service_role;
