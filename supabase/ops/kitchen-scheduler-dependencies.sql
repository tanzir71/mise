-- Privileged provisioning only. Creates no job or credential.
-- First review existing jobs/uses and confirm net/private are NOT exposed by
-- the actual Data API. Trust only managed administrators with SQL LOGIN.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Hosted Cron/Net belong to supabase_admin: tenant REVOKEs do not remove its
-- default grants. Never queue a reusable key. Dispatch uses an expiring HMAC
-- bound to a one-use private SQL grant; verify_jwt=false needs no API key.
-- https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16
do $$begin
 if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null or
  to_regprocedure('cron.schedule(text,text,text)') is null or
  to_regprocedure('cron.unschedule(text)') is null or
  to_regprocedure('extensions.hmac(bytea,bytea,text)') is null or
  exists(select 1 from pg_roles r where r.rolname in('anon','authenticated','service_role') and r.rolcanlogin) then
  raise exception using message='Review scheduler platform APIs and API-role access before configuration.';
 end if;
end $$;

-- Vault already exists on hosted projects. Do not grant client reads while
-- provisioning it. Store actual config/credential values through private input;
-- configure_kitchen_dispatch accepts only their private UUID references.
