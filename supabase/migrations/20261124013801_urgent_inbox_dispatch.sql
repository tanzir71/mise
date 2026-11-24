-- Installation-owned scheduler, disabled by default. Applying this migration
-- installs no extension, job, Vault value, provider account, or credential.
create table private.urgent_inbox_dispatch_state (
 id boolean primary key default true check(id),enabled boolean not null default false,
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 config_secret uuid,key_secret uuid,next_at public.utc_ms not null default 0,
 request_id bigint,queued_at public.utc_ms,signature text check(signature~'^[0-9a-f]{64}$'),
 failures integer not null default 0 check(failures between 0 and 8),
 outcome text not null default 'not-configured' check(outcome in('not-configured','disabled','idle','queued','retry','unavailable','unauthorized'))
);
create table private.urgent_inbox_dispatch_grants (
 nonce uuid primary key,revision bigint not null,issued_at public.utc_ms not null,
 batch_size integer not null check(batch_size between 1 and 25),expires_at public.utc_ms not null,consumed_at public.utc_ms,
 check(expires_at=issued_at+60000)
);
create index urgent_inbox_dispatch_expiry on private.urgent_inbox_dispatch_grants(expires_at,nonce);
alter table private.urgent_inbox_dispatch_state enable row level security;
alter table private.urgent_inbox_dispatch_state force row level security;
alter table private.urgent_inbox_dispatch_grants enable row level security;
alter table private.urgent_inbox_dispatch_grants force row level security;
revoke all on private.urgent_inbox_dispatch_state,private.urgent_inbox_dispatch_grants from public,anon,authenticated,service_role;
insert into private.urgent_inbox_dispatch_state(id) values(true);

create function private.claim_urgent_inbox_dispatch(nonce uuid,issued_at public.utc_ms,batch_size integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare s private.urgent_inbox_dispatch_state;stamp public.utc_ms;
begin
 select * into s from private.urgent_inbox_dispatch_state where id for share;
 if not found or not s.enabled or nonce is null or issued_at is null or batch_size is null or batch_size not between 1 and 25 then return false;end if;
 perform 1 from private.urgent_inbox_dispatch_grants x where x.nonce=claim_urgent_inbox_dispatch.nonce for update;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 update private.urgent_inbox_dispatch_grants x set consumed_at=stamp where x.nonce=claim_urgent_inbox_dispatch.nonce and x.revision=s.revision
  and x.issued_at=claim_urgent_inbox_dispatch.issued_at and x.batch_size=claim_urgent_inbox_dispatch.batch_size
  and x.consumed_at is null and x.issued_at<=stamp+5000 and x.expires_at>=stamp;
 return found;
end $$;
revoke all on function private.claim_urgent_inbox_dispatch(uuid,public.utc_ms,integer) from public,anon,authenticated,service_role;
grant execute on function private.claim_urgent_inbox_dispatch(uuid,public.utc_ms,integer) to service_role;
create function public.claim_urgent_inbox_dispatch(p_nonce uuid,p_issued_at public.utc_ms,p_limit integer) returns boolean language sql security invoker set search_path='' as $$select private.claim_urgent_inbox_dispatch(p_nonce,p_issued_at,p_limit)$$;
revoke all on function public.claim_urgent_inbox_dispatch(uuid,public.utc_ms,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_urgent_inbox_dispatch(uuid,public.utc_ms,integer) to service_role;

create function private.urgent_inbox_due_signature(stamp public.utc_ms) returns text
language sql stable security invoker set search_path='' as $$
 select case when count(*)=0 then null else encode(sha256(convert_to(string_agg(q.identity,'|' order by q.identity),'UTF8')),'hex') end from(
  (select 'new:'||x.task_id||':'||x.generation::text identity from private.urgent_inbox_generations x where x.state='pending' and x.prepared_at is null order by x.created_at,x.task_id,x.generation limit 25)
  union all
  (select 'pending:'||x.task_id||':'||x.generation::text||':'||x.consent_id||':'||x.attempts::text identity from private.urgent_inbox_deliveries x where x.state='pending' and x.next_at<=stamp order by x.next_at,x.task_id,x.generation,x.consent_id limit 25)
  union all
  (select 'leased:'||x.task_id||':'||x.generation::text||':'||x.consent_id||':'||x.attempts::text identity from private.urgent_inbox_deliveries x where x.state='sending' and x.lease_expires_at<=stamp order by x.lease_expires_at,x.task_id,x.generation,x.consent_id limit 25)
 )q
$$;
revoke all on function private.urgent_inbox_due_signature(public.utc_ms) from public,anon,authenticated,service_role;

create function private.configure_urgent_inbox_dispatch(turn_on boolean,config_id uuid default null,key_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.urgent_inbox_dispatch_state;fixed_command constant text:='select private.dispatch_urgent_inbox_work()';
begin
 if turn_on is null then raise invalid_parameter_value using message='Choose whether urgent scheduling is enabled.';end if;
 select * into s from private.urgent_inbox_dispatch_state where id for update;
 if s.revision>=9007199254740991 then raise exception using message='Scheduler configuration needs review.';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job j where j.jobname='mise-urgent-inbox' and(j.command<>fixed_command or j.username<>current_user)) then raise exception using message='Another scheduler owns this job name.';end if;
 end if;
 if turn_on then
  config_id:=coalesce(config_id,s.config_secret);key_id:=coalesce(key_id,s.key_secret);
  -- Reuse the reviewed private Vault/platform ACL validator. Its only output
  -- stays inside privileged SQL; no kitchen state, job, or function is changed.
  perform private.kitchen_dispatch_configuration(config_id,key_id);
  perform cron.schedule('mise-urgent-inbox','1 second',fixed_command);
  update private.urgent_inbox_dispatch_state set enabled=true,revision=s.revision+1,config_secret=config_id,key_secret=key_id,next_at=0,request_id=null,queued_at=null,signature=null,failures=0,outcome='idle' where id;
 else
  if config_id is not null or key_id is not null then raise invalid_parameter_value using message='Disable without replacing private configuration.';end if;
  if to_regclass('cron.job') is not null then
   if exists(select 1 from cron.job j where j.jobname='mise-urgent-inbox') then perform cron.unschedule('mise-urgent-inbox');end if;
  end if;
  update private.urgent_inbox_dispatch_state set enabled=false,revision=s.revision+1,next_at=0,request_id=null,queued_at=null,signature=null,failures=0,outcome='disabled' where id;
 end if;
 return jsonb_build_object('enabled',turn_on,'revision',s.revision+1);
end $$;
revoke all on function private.configure_urgent_inbox_dispatch(boolean,uuid,uuid) from public,anon,authenticated,service_role;

create function private.dispatch_urgent_inbox_work() returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.urgent_inbox_dispatch_state;stamp public.utc_ms;ready text;cfg jsonb;reply record;request bigint;nonce uuid;proof text;failure_count integer;retry_at public.utc_ms;
begin
 select * into s from private.urgent_inbox_dispatch_state where id for update skip locked;
 if not found then return jsonb_build_object('state','busy');end if;
 if not s.enabled then return jsonb_build_object('state','disabled');end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from private.urgent_inbox_dispatch_grants x where x.nonce in(select g.nonce from private.urgent_inbox_dispatch_grants g where g.expires_at<stamp order by g.expires_at,g.nonce limit 100);
 ready:=private.urgent_inbox_due_signature(stamp);
 if ready is null then
  if s.outcome<>'idle' then update private.urgent_inbox_dispatch_state set outcome='idle',failures=0,next_at=0,signature=null where id;end if;
  return jsonb_build_object('state','idle');
 end if;
 if s.queued_at is not null and s.queued_at+1000>stamp then return jsonb_build_object('state','waiting');end if;
 if s.signature=ready and s.next_at>stamp and s.outcome in('retry','unavailable') then return jsonb_build_object('state','waiting');end if;
 failure_count:=s.failures;
 begin
  cfg:=private.kitchen_dispatch_configuration(s.config_secret,s.key_secret);
  if s.request_id is not null then
   select r.status_code,r.timed_out,r.error_msg is not null as transport_error into reply from net._http_response r where r.id=s.request_id order by r.created desc limit 1;
   if found and reply.status_code in(401,403,404,405,415) then update private.urgent_inbox_dispatch_state set enabled=false,outcome='unauthorized',request_id=null where id;return jsonb_build_object('state','unavailable');end if;
   if found and(reply.timed_out or reply.transport_error or reply.status_code is null or reply.status_code>=500) and s.signature=ready then
    if s.outcome='retry' then retry_at:=s.next_at;else failure_count:=least(8,s.failures+1);retry_at:=s.queued_at+least(30000,1000*(1::bigint<<least(5,failure_count)));end if;
    if stamp<retry_at then update private.urgent_inbox_dispatch_state set failures=failure_count,next_at=retry_at,outcome='retry' where id;return jsonb_build_object('state','waiting');end if;
   elsif s.signature=ready and s.next_at>stamp then return jsonb_build_object('state','waiting');end if;
  elsif s.signature=ready and s.next_at>stamp then return jsonb_build_object('state','waiting');end if;
  nonce:=gen_random_uuid();insert into private.urgent_inbox_dispatch_grants values(nonce,s.revision,stamp,25,stamp+60000,null);
  proof:=encode(extensions.hmac(convert_to(E'mise:urgent-inbox:v1\n'||stamp::text||E'\n'||nonce::text||E'\n25','UTF8'),convert_to(cfg->>'credential','UTF8'),'sha256'),'hex');
  request:=net.http_post(url:=(cfg->>'url')||'/functions/v1/urgent-inbox-push',body:='{"limit":25}'::jsonb,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer v1.'||stamp::text||'.'||nonce::text||'.'||proof),timeout_milliseconds:=10000);
  if request is null or request<=0 then raise exception using message='Scheduler enqueue is unconfirmed.';end if;
  update private.urgent_inbox_dispatch_state set request_id=request,queued_at=stamp,signature=ready,next_at=stamp+1000,failures=case when s.signature=ready then failure_count else 0 end,outcome='queued' where id;
  return jsonb_build_object('state','queued');
 exception when others then
  -- Never echo extension/Vault exceptions or decrypted values to Cron logs.
  update private.urgent_inbox_dispatch_state set outcome='unavailable',next_at=stamp+30000,signature=ready where id;
  return jsonb_build_object('state','unavailable');
 end;
end $$;
revoke all on function private.dispatch_urgent_inbox_work() from public,anon,authenticated,service_role;
create function private.read_urgent_inbox_dispatch_status() returns jsonb
language sql stable security definer set search_path='' as $$select jsonb_build_object('enabled',s.enabled,'revision',s.revision,'state',s.outcome,'nextAt',s.next_at,'failures',s.failures) from private.urgent_inbox_dispatch_state s where s.id$$;
revoke all on function private.read_urgent_inbox_dispatch_status() from public,anon,authenticated,service_role;
