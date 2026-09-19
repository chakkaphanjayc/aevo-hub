-- Keep the Admin search accelerator extension out of public so Supabase's
-- security advisor does not treat it as an exposed extension surface.

create schema if not exists extensions;
alter extension pg_trgm set schema extensions;
