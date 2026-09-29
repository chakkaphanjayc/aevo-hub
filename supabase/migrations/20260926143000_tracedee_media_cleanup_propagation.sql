-- Discovery UGC safety: propagate rejected/deleted media decisions to Storage.
--
-- The metadata row remains the audit record.  A rejected/deleted asset keeps a
-- bounded list of object paths for a server-only worker to remove.  No client
-- role receives access to this plan or to the Storage object API.

alter table public.tracedee_media_assets
  add column if not exists cleanup_paths text[] not null default '{}'::text[],
  add column if not exists cleanup_completed_at timestamptz;

create index if not exists tracedee_media_assets_cleanup_idx
  on public.tracedee_media_assets (status, cleanup_completed_at, updated_at)
  where status in ('REJECTED', 'DELETED');

create or replace function public.tracedee_moderate_media_asset(
  p_asset_id uuid,
  p_decision text,
  p_expected_version integer,
  p_reason text default '',
  p_approved_variant_path text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_decision text := upper(trim(coalesce(p_decision, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_variant text := nullif(trim(coalesce(p_approved_variant_path, '')), '');
  v_asset record;
  v_next_version integer;
  v_cleanup_paths text[] := '{}'::text[];
begin
  if p_asset_id is null or p_expected_version is null
     or v_decision not in ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'DELETED')
     or length(v_reason) > 500 then
    raise exception using errcode = 'P0001', message = 'MEDIA_DECISION_INVALID';
  end if;

  select * into v_asset
  from public.tracedee_media_assets
  where id = p_asset_id
  for update;
  if v_asset.id is null then
    raise exception using errcode = 'P0001', message = 'MEDIA_ASSET_NOT_FOUND';
  end if;
  if v_asset.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'MEDIA_VERSION_CONFLICT';
  end if;
  if v_asset.status = 'DELETED' and v_decision <> 'DELETED' then
    raise exception using errcode = 'P0001', message = 'MEDIA_ASSET_ALREADY_DELETED';
  end if;
  if v_decision = 'APPROVED' then
    if v_asset.status not in ('QUARANTINED', 'UNDER_REVIEW')
       or v_variant is null
       or v_variant not like 'approved/%'
       or v_variant like '%..%' then
      raise exception using errcode = 'P0001', message = 'MEDIA_APPROVAL_REQUIRES_APPROVED_VARIANT';
    end if;
  elsif v_variant is not null then
    raise exception using errcode = 'P0001', message = 'MEDIA_VARIANT_NOT_ALLOWED';
  end if;

  if v_decision in ('REJECTED', 'DELETED') then
    select coalesce(array_agg(distinct path), '{}'::text[])
    into v_cleanup_paths
    from unnest(
      array_cat(
        coalesce(v_asset.cleanup_paths, '{}'::text[]),
        array[v_asset.object_path, v_asset.approved_variant_path]
      )
    ) as paths(path)
    where path is not null
      and length(trim(path)) between 10 and 500
      and (path like 'quarantine/%' or path like 'approved/%')
      and path not like '%..%';
  end if;

  v_next_version := v_asset.version + 1;
  update public.tracedee_media_assets
  set status = v_decision,
      approved_variant_path = case when v_decision = 'APPROVED' then v_variant else null end,
      cleanup_paths = case when v_decision in ('REJECTED', 'DELETED') then v_cleanup_paths else cleanup_paths end,
      cleanup_completed_at = case when v_decision in ('REJECTED', 'DELETED') then null else cleanup_completed_at end,
      moderation_reason = v_reason,
      version = v_next_version,
      moderated_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = p_asset_id;

  return jsonb_build_object(
    'ok', true,
    'assetId', p_asset_id,
    'status', v_decision,
    'version', v_next_version,
    'approvedVariantPath', case when v_decision = 'APPROVED' then v_variant else null end,
    'cleanupRequired', v_decision in ('REJECTED', 'DELETED') and cardinality(v_cleanup_paths) > 0,
    'cleanupPaths', to_jsonb(v_cleanup_paths),
    'changed', true
  );
end;
$$;

create or replace function public.tracedee_get_media_cleanup_plan(
  p_asset_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_asset record;
begin
  if p_asset_id is null then
    raise exception using errcode = 'P0001', message = 'MEDIA_ASSET_NOT_FOUND';
  end if;

  select id, bucket_id, status, version, cleanup_paths, cleanup_completed_at
  into v_asset
  from public.tracedee_media_assets
  where id = p_asset_id;
  if v_asset.id is null then
    raise exception using errcode = 'P0001', message = 'MEDIA_ASSET_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'ok', true,
    'assetId', v_asset.id,
    'bucketId', v_asset.bucket_id,
    'status', v_asset.status,
    'version', v_asset.version,
    'cleanupRequired', v_asset.status in ('REJECTED', 'DELETED')
      and v_asset.cleanup_completed_at is null
      and cardinality(coalesce(v_asset.cleanup_paths, '{}'::text[])) > 0,
    'cleanupPaths', case
      when v_asset.status in ('REJECTED', 'DELETED') and v_asset.cleanup_completed_at is null
        then to_jsonb(coalesce(v_asset.cleanup_paths, '{}'::text[]))
      else '[]'::jsonb
    end,
    'cleanupCompletedAt', v_asset.cleanup_completed_at
  );
end;
$$;

create or replace function public.tracedee_complete_media_cleanup(
  p_asset_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_asset record;
begin
  if p_asset_id is null or p_expected_version is null then
    raise exception using errcode = 'P0001', message = 'MEDIA_CLEANUP_INPUT_INVALID';
  end if;

  select id, status, version, cleanup_completed_at
  into v_asset
  from public.tracedee_media_assets
  where id = p_asset_id
  for update;
  if v_asset.id is null then
    raise exception using errcode = 'P0001', message = 'MEDIA_ASSET_NOT_FOUND';
  end if;
  if v_asset.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'MEDIA_VERSION_CONFLICT';
  end if;
  if v_asset.status not in ('REJECTED', 'DELETED') then
    raise exception using errcode = 'P0001', message = 'MEDIA_CLEANUP_NOT_REQUIRED';
  end if;
  if v_asset.cleanup_completed_at is not null then
    return jsonb_build_object(
      'ok', true,
      'assetId', p_asset_id,
      'status', v_asset.status,
      'version', v_asset.version,
      'cleanupCompletedAt', v_asset.cleanup_completed_at,
      'changed', false
    );
  end if;

  update public.tracedee_media_assets
  set cleanup_completed_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = p_asset_id;

  select id, status, version, cleanup_completed_at
  into v_asset
  from public.tracedee_media_assets
  where id = p_asset_id;

  return jsonb_build_object(
    'ok', true,
    'assetId', v_asset.id,
    'status', v_asset.status,
    'version', v_asset.version,
    'cleanupCompletedAt', v_asset.cleanup_completed_at,
    'changed', true
  );
end;
$$;

revoke all on function public.tracedee_moderate_media_asset(uuid, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.tracedee_get_media_cleanup_plan(uuid) from public, anon, authenticated;
revoke all on function public.tracedee_complete_media_cleanup(uuid, integer) from public, anon, authenticated;
grant execute on function public.tracedee_moderate_media_asset(uuid, text, integer, text, text) to service_role;
grant execute on function public.tracedee_get_media_cleanup_plan(uuid) to service_role;
grant execute on function public.tracedee_complete_media_cleanup(uuid, integer) to service_role;

comment on column public.tracedee_media_assets.cleanup_paths is
  'Server-only bounded Storage paths retained for rejected/deleted object cleanup.';
comment on column public.tracedee_media_assets.cleanup_completed_at is
  'Server-only timestamp recorded after the Storage cleanup worker has completed.';
