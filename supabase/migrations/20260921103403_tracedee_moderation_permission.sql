-- TraceDee community/moderation is now a deliberate, auditable product slice.
-- OPS can operate the queue; public/customer roles still receive no direct
-- table or RPC access.

update public.platform_roles
set permissions = permissions || '["content.moderate"]'::jsonb
where role = 'OPS'
  and not (permissions @> '["content.moderate"]'::jsonb);

update public.tracedee_feature_flags
set enabled = true,
    rollout_percent = 100,
    config = config || '{"version":2,"communitySurface":"posts-comments-helpful-v1"}'::jsonb,
    updated_at = timezone('utc', now())
where flag_key = 'comments_v2';
