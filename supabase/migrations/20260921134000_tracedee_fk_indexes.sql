-- Cover foreign-key columns introduced by moderation, lifecycle, and
-- notification extensions so deletes/joins remain bounded as data grows.
create index if not exists tracedee_comments_deleted_by_idx
  on public.tracedee_comments (deleted_by);
create index if not exists tracedee_content_reports_reviewed_by_idx
  on public.tracedee_content_reports (reviewed_by);
create index if not exists tracedee_moderation_audit_actor_id_idx
  on public.tracedee_moderation_audit (actor_id);
create index if not exists tracedee_notifications_last_actor_id_idx
  on public.tracedee_notifications (last_actor_id);
create index if not exists tracedee_posts_deleted_by_idx
  on public.tracedee_posts (deleted_by);
