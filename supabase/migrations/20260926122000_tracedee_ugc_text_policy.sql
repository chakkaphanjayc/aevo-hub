-- Discovery UGC safety: deterministic high-confidence text policy guard.
--
-- This is deliberately only the first layer of the policy boundary. It
-- rejects high-confidence explicit sexual/pornographic text before a post or
-- comment can become public, keeps promotional links under review, and does
-- not pretend to replace image moderation, appeals, or relevance review.

create or replace function public.tracedee_content_policy_decision(p_body text)
returns jsonb
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $$
  with normalized as (
    select lower(regexp_replace(trim(coalesce(p_body, '')), '[[:space:]]+', ' ', 'g')) as body
  )
  select case
    when body ~* '(^|[^[:alnum:]_])(porn|pornography|pornographic|nsfw|xxx|onlyfans|sex[[:space:]]+tape|nude|nudity|naked|blow[[:space:]]*job|hand[[:space:]]*job|deep[[:space:]]*throat|fetish|prostitute|sexual[[:space:]]+services|leaked[[:space:]]+(nude|sex)|โป๊|ลามก|อนาจาร|เปลือย|อวัยวะเพศ|หนังโป๊|คลิปหลุด|ขายบริการ)([^[:alnum:]_]|$)'
      then jsonb_build_object('action', 'REJECT', 'category', 'SEXUAL_EXPLICIT', 'policyVersion', 'ugc-safe-v1')
    when body ~* '(https?://|www\.)'
      then jsonb_build_object('action', 'REVIEW', 'category', 'PROMOTIONAL_LINK', 'policyVersion', 'ugc-safe-v1')
    else jsonb_build_object('action', 'ALLOW', 'category', 'NONE', 'policyVersion', 'ugc-safe-v1')
  end
  from normalized;
$$;

create or replace function public.tracedee_content_status(p_body text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog, public
as $$
  select case
    when public.tracedee_content_policy_decision(p_body)->>'action' = 'REVIEW' then 'UNDER_REVIEW'
    else 'VISIBLE'
  end;
$$;

revoke all on function public.tracedee_content_policy_decision(text) from public, anon, authenticated;
revoke all on function public.tracedee_content_status(text) from public, anon, authenticated;
grant execute on function public.tracedee_content_policy_decision(text) to service_role;
grant execute on function public.tracedee_content_status(text) to service_role;

do $migration$
declare
  v_name text;
  v_arg_count integer;
  v_definition text;
  v_old constant text := $$  v_status := case when v_body ~* '(https?://|www\.)' then 'UNDER_REVIEW' else 'VISIBLE' end;$$;
  v_new constant text := $$  if public.tracedee_content_policy_decision(v_body)->>'action' = 'REJECT' then
    raise exception using errcode = 'P0001', message = 'CONTENT_POLICY_REJECTED';
  end if;
  v_status := public.tracedee_content_status(v_body);$$;
begin
  for v_name, v_arg_count in
    select f.name, f.arg_count
    from (values
      ('tracedee_create_post'::text, 9),
      ('tracedee_create_comment'::text, 8),
      ('tracedee_edit_content'::text, 9)
    ) as f(name, arg_count)
  loop
    select pg_get_functiondef(p.oid)
      into v_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = v_name
      and p.pronargs = v_arg_count
    order by p.oid desc
    limit 1;

    if v_definition is null then
      raise exception 'Required TraceDee content function %/% is not installed', v_name, v_arg_count;
    end if;
    if position(v_old in v_definition) > 0 then
      execute replace(v_definition, v_old, v_new);
    elsif position('public.tracedee_content_status(v_body)' in v_definition) = 0 then
      raise exception 'TraceDee content function % does not have the expected status guard', v_name;
    end if;
  end loop;
end;
$migration$;
