-- Account deletion must be compatible with the append-only activity ledger.
-- Preserve the event's type/entity/time for aggregate replay, but remove the
-- actor/session/metadata that can identify the deleted account before the
-- auth.users FK action sets actor_id to NULL.

create or replace function public.prevent_tracedee_activity_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if TG_OP = 'UPDATE'
     and current_setting('tracedee.account_delete_anonymize', true) = 'on'
     and NEW.id = OLD.id
     and NEW.event_type = OLD.event_type
     and NEW.source = OLD.source
     and NEW.entity_type = OLD.entity_type
     and NEW.entity_id is not distinct from OLD.entity_id
     and NEW.schema_version = OLD.schema_version
     and NEW.tracking_token = OLD.tracking_token
     and NEW.correlation_id = OLD.correlation_id
     and NEW.dedupe_key is not distinct from OLD.dedupe_key
     and NEW.occurred_at = OLD.occurred_at
     and NEW.created_at = OLD.created_at
     and NEW.actor_id is null
     and NEW.session_id is null
     and NEW.metadata = '{"accountDeleted": true}'::jsonb then
    return NEW;
  end if;

  raise exception using errcode = 'P0001', message = 'TRACEDEE_ACTIVITY_EVENT_IMMUTABLE';
end;
$$;

create or replace function public.tracedee_anonymize_profile_activity_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform set_config('tracedee.account_delete_anonymize', 'on', true);
  update public.tracedee_activity_events
  set actor_id = null,
      session_id = null,
      metadata = '{"accountDeleted": true}'::jsonb
  where actor_id = OLD.id;
  return OLD;
end;
$$;

revoke all on function public.tracedee_anonymize_profile_activity_events() from public, anon, authenticated;

drop trigger if exists tracedee_profile_delete_anonymize_events on auth.users;
create trigger tracedee_profile_delete_anonymize_events
before delete on auth.users
for each row execute function public.tracedee_anonymize_profile_activity_events();
