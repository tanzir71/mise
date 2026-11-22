-- Vault exposes its own key_id column. Bind both original secret UUID inputs
-- explicitly without changing the private signature, grants or configuration.
create or replace function private.kitchen_dispatch_configuration(config_id uuid,key_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare role_name text;raw text;cfg jsonb;credential text;
begin
 if config_id is null or key_id is null or config_id=key_id or
  to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null or
  to_regprocedure('cron.schedule(text,text,text)') is null or to_regprocedure('cron.unschedule(text)') is null or
  to_regclass('cron.job') is null or to_regclass('net.http_request_queue') is null or to_regclass('net._http_response') is null or
  to_regclass('vault.decrypted_secrets') is null or to_regclass('vault.secrets') is null or
  to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then
  raise exception using message='Scheduler dependencies and private configuration need review.';end if;
 foreach role_name in array array['anon','authenticated','service_role'] loop
  if not exists(select 1 from pg_roles r where r.rolname=role_name and not r.rolcanlogin) then
   raise exception using message='Scheduler API role access needs review.';end if;
 end loop;
 foreach role_name in array array['anon','authenticated'] loop
  if has_table_privilege(role_name,'vault.secrets','select') or has_table_privilege(role_name,'vault.decrypted_secrets','select') then
   raise exception using message='Private credential permissions need review.';end if;
 end loop;
 select s.decrypted_secret into raw from vault.decrypted_secrets s where s.id=kitchen_dispatch_configuration.config_id;
 if raw is null or octet_length(raw)>4096 then raise exception using message='Private scheduler configuration needs review.';end if;
 begin cfg:=raw::jsonb;exception when others then raise exception using message='Private scheduler configuration needs review.';end;
 if cfg is null or jsonb_typeof(cfg)<>'object' then raise exception using message='Private scheduler configuration needs review.';end if;
 if not(cfg?'apiUrl') or (select count(*) from jsonb_object_keys(cfg))<>1 or
  jsonb_typeof(cfg->'apiUrl')<>'string' or length(cfg->>'apiUrl')>2048 or
  (cfg->>'apiUrl')!~'^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' then
  raise exception using message='Private scheduler configuration needs review.';end if;
 select s.decrypted_secret into credential from vault.decrypted_secrets s where s.id=kitchen_dispatch_configuration.key_id;
 if credential is null or credential!~'^[A-Za-z0-9_-]{43}$' then raise exception using message='Private scheduler credential needs review.';end if;
 return jsonb_build_object('url',cfg->>'apiUrl','credential',credential);
end $$;
revoke all on function private.kitchen_dispatch_configuration(uuid,uuid) from public,anon,authenticated,service_role;
