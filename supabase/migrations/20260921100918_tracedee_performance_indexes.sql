-- TraceDee performance hardening.
--
-- These indexes cover foreign-key columns that are used by journey/community
-- reads and by parent-row updates/deletes. They are intentionally additive and
-- keep the service-role Gateway's tenant-safe access pattern unchanged.

create index if not exists tracedee_comment_reactions_user_id_idx
  on public.tracedee_comment_reactions (user_id);

create index if not exists tracedee_comments_parent_id_idx
  on public.tracedee_comments (parent_id);

create index if not exists tracedee_feed_impressions_actor_id_idx
  on public.tracedee_feed_impressions (actor_id);

create index if not exists tracedee_feed_interactions_actor_id_idx
  on public.tracedee_feed_interactions (actor_id);

create index if not exists tracedee_journey_stops_trace_stop_id_idx
  on public.tracedee_journey_stops (trace_stop_id);

create index if not exists tracedee_journeys_trace_id_idx
  on public.tracedee_journeys (trace_id);

create index if not exists tracedee_notifications_actor_id_idx
  on public.tracedee_notifications (actor_id);

create index if not exists tracedee_places_organization_id_idx
  on public.tracedee_places (organization_id);

create index if not exists tracedee_places_store_id_idx
  on public.tracedee_places (store_id);

create index if not exists tracedee_posts_place_id_idx
  on public.tracedee_posts (place_id);

create index if not exists tracedee_recommendation_snapshots_profile_id_idx
  on public.tracedee_recommendation_snapshots (profile_id);

create index if not exists tracedee_trace_ratings_user_id_idx
  on public.tracedee_trace_ratings (user_id);

create index if not exists tracedee_trace_remixes_remixer_id_idx
  on public.tracedee_trace_remixes (remixer_id);

create index if not exists tracedee_trace_remixes_source_trace_id_idx
  on public.tracedee_trace_remixes (source_trace_id);

create index if not exists tracedee_trace_stops_place_id_idx
  on public.tracedee_trace_stops (place_id);

create index if not exists tracedee_traces_cover_place_id_idx
  on public.tracedee_traces (cover_place_id);

create index if not exists tracedee_traces_root_trace_id_idx
  on public.tracedee_traces (root_trace_id);

create index if not exists tracedee_traces_source_trace_id_idx
  on public.tracedee_traces (source_trace_id);
