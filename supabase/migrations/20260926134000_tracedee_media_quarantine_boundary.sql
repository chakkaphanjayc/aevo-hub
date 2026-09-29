-- Discovery UGC safety: development media quarantine boundary.
--
-- Supabase Storage is used only as a private development quarantine bucket.
-- No client role receives Storage/table/function access, and this migration
-- does not create public URLs or claim automated image/video moderation.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'tracedee-quarantine',
  'tracedee-quarantine',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    updated_at = timezone('utc', now());

create table if not exists public.tracedee_media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete set null,
  source_type text not null check (source_type in ('POST', 'COMMENT', 'TRACE', 'PLACE')),
  source_id uuid not null,
  bucket_id text not null default 'tracedee-quarantine',
  object_path text not null check (
    length(trim(object_path)) between 12 and 500
    and object_path like 'quarantine/%'
    and object_path not like '%..%'
  ),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm')),
  byte_size bigint not null check (byte_size between 1 and 26214400),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'QUARANTINED' check (status in ('QUARANTINED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'DELETED')),
  approved_variant_path text check (
    approved_variant_path is null
    or (
      length(trim(approved_variant_path)) between 10 and 500
      and approved_variant_path like 'approved/%'
      and approved_variant_path not like '%..%'
    )
  ),
  moderation_reason text not null default '' check (length(moderation_reason) <= 500),
  version integer not null default 1 check (version >= 1),
  request_key text not null check (length(trim(request_key)) between 8 and 200),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  moderated_at timestamptz,
  unique (owner_id, request_key),
  unique (bucket_id, object_path)
);

alter table public.tracedee_media_assets enable row level security;

create index if not exists tracedee_media_assets_source_status_idx
  on public.tracedee_media_assets (source_type, source_id, status, created_at desc);
create index if not exists tracedee_media_assets_owner_created_idx
  on public.tracedee_media_assets (owner_id, created_at desc);

revoke all on table public.tracedee_media_assets from public, anon, authenticated;
grant select, insert, update on table public.tracedee_media_assets to service_role;

create or replace function public.tracedee_register_media_asset(
  p_actor_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_object_path text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256 text,
  p_request_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_source_type text := upper(trim(coalesce(p_source_type, '')));
  v_object_path text := trim(coalesce(p_object_path, ''));
  v_mime_type text := lower(trim(coalesce(p_mime_type, '')));
  v_sha256 text := lower(trim(coalesce(p_sha256, '')));
  v_request_key text := trim(coalesce(p_request_key, ''));
  v_existing record;
  v_asset record;
begin
  if p_actor_id is null or p_source_id is null
     or v_source_type not in ('POST', 'COMMENT', 'TRACE', 'PLACE')
     or length(v_object_path) < 12
     or v_object_path not like 'quarantine/%'
     or v_object_path like '%..%'
     or v_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm')
     or p_byte_size is null or p_byte_size < 1 or p_byte_size > 26214400
     or v_sha256 !~ '^[0-9a-f]{64}$'
     or length(v_request_key) < 8 or length(v_request_key) > 200 then
    raise exception using errcode = 'P0001', message = 'MEDIA_INPUT_INVALID';
  end if;

  if not (
    (v_source_type = 'POST' and exists (select 1 from public.tracedee_posts where id = p_source_id and deleted_at is null))
    or (v_source_type = 'COMMENT' and exists (select 1 from public.tracedee_comments where id = p_source_id and deleted_at is null))
    or (v_source_type = 'TRACE' and exists (select 1 from public.tracedee_traces where id = p_source_id))
    or (v_source_type = 'PLACE' and exists (
      select 1 from public.tracedee_places where id = p_source_id
      union all
      select 1 from public.customer_store_profiles where store_id = p_source_id
    ))
  ) then
    raise exception using errcode = 'P0001', message = 'MEDIA_SOURCE_NOT_FOUND';
  end if;

  select * into v_existing
  from public.tracedee_media_assets
  where owner_id = p_actor_id and request_key = v_request_key;
  if v_existing.id is not null then
    return jsonb_build_object(
      'ok', true,
      'assetId', v_existing.id,
      'status', v_existing.status,
      'version', v_existing.version,
      'approvedVariantPath', v_existing.approved_variant_path,
      'changed', false
    );
  end if;

  insert into public.tracedee_media_assets (
    owner_id, source_type, source_id, bucket_id, object_path, mime_type,
    byte_size, sha256, status, request_key
  )
  values (
    p_actor_id, v_source_type, p_source_id, 'tracedee-quarantine',
    v_object_path, v_mime_type, p_byte_size, v_sha256, 'QUARANTINED', v_request_key
  )
  returning * into v_asset;

  return jsonb_build_object(
    'ok', true,
    'assetId', v_asset.id,
    'status', v_asset.status,
    'version', v_asset.version,
    'approvedVariantPath', null,
    'changed', true
  );
end;
$$;

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

  v_next_version := v_asset.version + 1;
  update public.tracedee_media_assets
  set status = v_decision,
      approved_variant_path = case when v_decision = 'APPROVED' then v_variant else null end,
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
    'changed', true
  );
end;
$$;

revoke all on function public.tracedee_register_media_asset(uuid, text, uuid, text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.tracedee_moderate_media_asset(uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.tracedee_register_media_asset(uuid, text, uuid, text, text, bigint, text, text) to service_role;
grant execute on function public.tracedee_moderate_media_asset(uuid, text, integer, text, text) to service_role;
