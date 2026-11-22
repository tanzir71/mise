-- Test-only API adapter for extensions not available in PGlite. It models
-- transactional queue writes, fixed Cron metadata and ACLs, not networking,
-- background execution or Vault encryption. Values are always synthetic.
create schema vault;
create table vault.secrets(id uuid primary key,secret text not null);
create view vault.decrypted_secrets as select id,secret as decrypted_secret from vault.secrets;
create schema net;
create unlogged table net.http_request_queue (
 id bigint generated always as identity primary key,method text not null,url text not null,
 headers jsonb not null,body bytea,timeout_milliseconds integer not null
);
create unlogged table net._http_response (
 id bigint,status_code integer,content_type text,headers jsonb,content text,timed_out boolean,error_msg text,
 created timestamptz not null default now()
);
create function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds integer default 2000) returns bigint
language sql volatile security definer set search_path='' as $$
 insert into net.http_request_queue(method,url,headers,body,timeout_milliseconds)
 values('POST',$1,$4,convert_to($2::text,'UTF8'),$5) returning id
$$;
create schema cron;
create table cron.job(jobid bigint generated always as identity primary key,jobname text unique not null,schedule text not null,command text not null,username text not null,active boolean not null default true);
create function cron.schedule(job_name text,schedule_text text,command_text text) returns bigint
language sql volatile security definer set search_path='' as $$
 insert into cron.job(jobname,schedule,command,username) values($1,$2,$3,current_user)
 on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,username=excluded.username returning jobid
$$;
create function cron.unschedule(job_name text) returns boolean language plpgsql volatile security definer set search_path='' as $$
begin delete from cron.job where jobname=job_name;return found;end $$;
grant usage on schema net,cron,vault to anon,authenticated,service_role;
revoke all on vault.secrets,vault.decrypted_secrets from public,anon,authenticated,service_role;
revoke all on all tables in schema net,cron from public,anon,authenticated,service_role;
revoke all on all sequences in schema net,cron from public,anon,authenticated,service_role;
revoke all on all functions in schema net,cron from public,anon,authenticated,service_role;
