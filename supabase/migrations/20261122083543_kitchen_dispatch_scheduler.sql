-- Due-only transport orchestration. No extension, job or credential is installed
-- by this migration. A privileged private setup enables the fixed Cron call
-- only after its runtime, Vault configuration and queue ACLs are verified.
create table private.kitchen_alarm_retries (
 business_id public.ulid not null,outlet_id public.ulid not null,order_id public.ulid not null,
 work_version bigint not null check(work_version between 1 and 9007199254740991),
 attempts integer not null check(attempts between 1 and 8),next_at public.utc_ms not null,
 primary key(business_id,outlet_id,order_id),
 foreign key(business_id,outlet_id,order_id) references private.kitchen_alarm_work(business_id,outlet_id,order_id) on delete cascade
);
alter table private.kitchen_alarm_retries enable row level security;
alter table private.kitchen_alarm_retries force row level security;
revoke all on private.kitchen_alarm_retries from public,anon,authenticated,service_role;

create function private.clear_kitchen_alarm_retry() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.version<>old.version or new.next_at is distinct from old.next_at then
  delete from private.kitchen_alarm_retries r where r.business_id=new.business_id and r.outlet_id=new.outlet_id and r.order_id=new.order_id;
 end if;
 return null;
end $$;
revoke all on function private.clear_kitchen_alarm_retry() from public,anon,authenticated,service_role;
create trigger kitchen_alarm_retry_cleared after update of version,next_at on private.kitchen_alarm_work
 for each row execute function private.clear_kitchen_alarm_retry();

create function private.defer_kitchen_alarm(business public.ulid,outlet public.ulid,target public.ulid,expected_version bigint,stamp text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w private.kitchen_alarm_work;raw jsonb;failures integer;retry_at public.utc_ms;at_ms public.utc_ms;
begin
 if business is null or outlet is null or target is null or expected_version is null or expected_version<1 or stamp is null or stamp!~'^[0-9a-f]{64}$' then
  raise invalid_parameter_value using message='Keep the original prepared alarm.';end if;
 -- Match the actual finisher's scope lock order. No network is held here.
 perform 1 from public.businesses b where b.id=business for share;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform 1 from public.orders o where o.business_id=business and o.outlet_id=outlet and o.id=target for update;
 select * into w from private.kitchen_alarm_work x where x.business_id=business and x.outlet_id=outlet and x.order_id=target for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or w.version<>expected_version or w.next_at is null or w.next_at>at_ms then return jsonb_build_object('state','stale');end if;
 raw:=private.kitchen_read_rows(business,outlet,array[target])->0;
 if encode(sha256(convert_to(coalesce(raw::text,'null'),'UTF8')),'hex')<>stamp then return jsonb_build_object('state','stale');end if;
 select case when r.work_version=expected_version then least(8,r.attempts+1) else 1 end into failures
  from private.kitchen_alarm_retries r where r.business_id=business and r.outlet_id=outlet and r.order_id=target;
 failures:=coalesce(failures,1);
 retry_at:=at_ms+least(60000,1000*(1::bigint<<(failures-1)));
 insert into private.kitchen_alarm_retries as r(business_id,outlet_id,order_id,work_version,attempts,next_at)
  values(business,outlet,target,expected_version,failures,retry_at)
  on conflict(business_id,outlet_id,order_id) do update set work_version=excluded.work_version,attempts=excluded.attempts,next_at=excluded.next_at;
 -- The watch stays due: claim_kitchen_push must still reject its older task.
 -- Only the inspection selector observes this separate retry deadline.
 return jsonb_build_object('state','deferred','attempts',failures,'nextAt',retry_at);
end $$;
revoke all on function private.defer_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function private.defer_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text) to service_role;
create function public.defer_kitchen_alarm(p_business_id public.ulid,p_outlet_id public.ulid,p_order_id public.ulid,p_version bigint,p_stamp text) returns jsonb
language sql security invoker set search_path='' as $$select private.defer_kitchen_alarm(p_business_id,p_outlet_id,p_order_id,p_version,p_stamp)$$;
revoke all on function public.defer_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.defer_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text) to service_role;

create function private.kitchen_push_inspection_ready(task public.ulid,at_ms public.utc_ms) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.kitchen_alarm_tasks b join private.kitchen_alarm_work w
  on w.business_id=b.business_id and w.outlet_id=b.outlet_id and w.order_id=b.order_id
  where b.task_id=task and w.next_at<=at_ms)
$$;
revoke all on function private.kitchen_push_inspection_ready(public.ulid,public.utc_ms) from public,anon,authenticated,service_role;

create index kitchen_alarm_notification_expand_due_idx on private.kitchen_alarm_notifications(created_at,task_id,generation)
 where status='pending' and prepared_at is null;
create index kitchen_alarm_notification_settle_idx on private.kitchen_alarm_notifications(created_at,task_id,generation)
 where status='pending' and prepared_at is not null;

create table private.kitchen_dispatch_state (
 id boolean primary key default true check(id),enabled boolean not null default false,
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 config_secret uuid,key_secret uuid,next_at public.utc_ms not null default 0,
 request_id bigint,queued_at public.utc_ms,signature text check(signature~'^[0-9a-f]{64}$'),
 failures integer not null default 0 check(failures between 0 and 8),
 outcome text not null default 'not-configured' check(outcome in('not-configured','disabled','idle','queued','complete','retry','unavailable','unauthorized'))
);
alter table private.kitchen_dispatch_state enable row level security;
alter table private.kitchen_dispatch_state force row level security;
revoke all on private.kitchen_dispatch_state from public,anon,authenticated,service_role;
insert into private.kitchen_dispatch_state(id) values(true);

-- The managed Net queue has platform-owned default grants. It receives only
-- an expiring proof, never the reusable key. Each exact grant is single-use.
create table private.kitchen_dispatch_grants (
 nonce uuid primary key,revision bigint not null,issued_at public.utc_ms not null,
 batch_size integer not null check(batch_size between 1 and 25),
 expires_at public.utc_ms not null,consumed_at public.utc_ms,
 check(expires_at=issued_at+60000)
);
create index kitchen_dispatch_grant_expiry_idx on private.kitchen_dispatch_grants(expires_at,nonce);
alter table private.kitchen_dispatch_grants enable row level security;
alter table private.kitchen_dispatch_grants force row level security;
revoke all on private.kitchen_dispatch_grants from public,anon,authenticated,service_role;
create function private.claim_kitchen_dispatch(nonce uuid,issued_at public.utc_ms,batch_size integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare s private.kitchen_dispatch_state;at_ms public.utc_ms;
begin
 select * into s from private.kitchen_dispatch_state where id for share;
 if not found or not s.enabled or nonce is null or issued_at is null or batch_size is null or batch_size not between 1 and 25 then return false;end if;
 perform 1 from private.kitchen_dispatch_grants g where g.nonce=claim_kitchen_dispatch.nonce for update;
 -- Recheck expiry after either scope/grant lock could have waited.
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 update private.kitchen_dispatch_grants g set consumed_at=at_ms where g.nonce=claim_kitchen_dispatch.nonce
  and g.revision=s.revision and g.issued_at=claim_kitchen_dispatch.issued_at and g.batch_size=claim_kitchen_dispatch.batch_size
  and g.consumed_at is null and g.issued_at<=at_ms+5000 and g.expires_at>=at_ms;
 return found;
end $$;
revoke all on function private.claim_kitchen_dispatch(uuid,public.utc_ms,integer) from public,anon,authenticated,service_role;
grant execute on function private.claim_kitchen_dispatch(uuid,public.utc_ms,integer) to service_role;
create function public.claim_kitchen_dispatch(p_nonce uuid,p_issued_at public.utc_ms,p_limit integer) returns boolean
language sql security invoker set search_path='' as $$select private.claim_kitchen_dispatch(p_nonce,p_issued_at,p_limit)$$;
revoke all on function public.claim_kitchen_dispatch(uuid,public.utc_ms,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_kitchen_dispatch(uuid,public.utc_ms,integer) to service_role;

-- Defer inspection without clearing its original stale-delivery barrier.
create or replace function private.prepare_kitchen_alarms(batch_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
 if batch_size is null or batch_size not between 1 and 50 then raise invalid_parameter_value using message='Use a bounded alarm batch.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('businessId',w.business_id,'outletId',w.outlet_id,'orderId',w.order_id,'version',w.version,
  'settings',jsonb_build_object('enabled',coalesce(s.enabled,true),'minutes',coalesce(s.minutes,2)),
  'source',r.source,'stamp',encode(sha256(convert_to(coalesce(r.source::text,'null'),'UTF8')),'hex')) order by w.next_at,w.business_id,w.outlet_id,w.order_id),'[]'::jsonb)
 into result from (
  with candidates as materialized (
   select x.*,coalesce(2*octet_length(o.lines::text)+2*octet_length(o.table_label::text),0)+2048 as weight
   from private.kitchen_alarm_work x left join public.orders o on o.business_id=x.business_id and o.outlet_id=x.outlet_id and o.id=x.order_id
   where x.next_at<=at_ms and not exists(select 1 from private.kitchen_alarm_retries retry where retry.business_id=x.business_id and retry.outlet_id=x.outlet_id and retry.order_id=x.order_id and retry.work_version=x.version and retry.next_at>at_ms) order by x.next_at,x.business_id,x.outlet_id,x.order_id limit batch_size
  ),sized as (
   select *,row_number() over(order by next_at,business_id,outlet_id,order_id) as n,sum(weight) over(order by next_at,business_id,outlet_id,order_id) as bytes from candidates
  ) select * from sized where n=1 or bytes<=4194304
 ) w
 left join public.kitchen_alarm_settings s on s.business_id=w.business_id and s.outlet_id=w.outlet_id
 cross join lateral(select private.kitchen_read_rows(w.business_id,w.outlet_id,array[w.order_id])->0 as source) r;
 return jsonb_build_object('v',1,'at',at_ms,'jobs',result);
end $$;

-- Do not let blocked old deliveries starve ready tasks in another scope.
create or replace function private.prepare_kitchen_push(application_key text,batch_size integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate record;n private.kitchen_alarm_notifications;b private.kitchen_alarm_tasks;t public.tasks;
 at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;result jsonb;
begin
 if application_key is null or application_key!~'^B[A-Za-z0-9_-]{86}$' or batch_size is null or batch_size not between 1 and 25 then
  raise invalid_parameter_value using message='Use a bounded desk notification batch.';end if;
 for candidate in select chosen.* from(
  select x.task_id,x.generation,x.created_at,alarm_binding.business_id,alarm_binding.outlet_id from private.kitchen_alarm_notifications x
  join private.kitchen_alarm_tasks alarm_binding on alarm_binding.task_id=x.task_id where x.status='pending' and x.prepared_at is null
  order by x.created_at,x.task_id,x.generation limit batch_size
 ) chosen order by chosen.business_id,chosen.outlet_id,chosen.created_at,chosen.task_id,chosen.generation loop
  -- Choose by age, then acquire scope locks in one order within the batch.
  perform 1 from public.outlets o where o.business_id=candidate.business_id and o.id=candidate.outlet_id for share;
  -- Task before notification, like Got it/close. Otherwise the new delivery FK
  -- can wait for a task held by a closer waiting on this notification row.
  select * into t from public.tasks x where x.id=candidate.task_id for share;
  select * into n from private.kitchen_alarm_notifications x where x.task_id=candidate.task_id and x.generation=candidate.generation
   and x.status='pending' and x.prepared_at is null for update skip locked;
  if not found then continue;end if;
  select * into b from private.kitchen_alarm_tasks x where x.task_id=n.task_id;
  if t.id is null or t.status<>'open' or b.task_id is null or b.generation<>n.generation then
   update private.kitchen_alarm_notifications x set status='cancelled',prepared_at=at_ms where x.task_id=n.task_id and x.generation=n.generation;
   continue;
  end if;
  insert into private.kitchen_push_deliveries(task_id,generation,subscription_id,business_id,outlet_id,state,next_at,created_at)
   select n.task_id,n.generation,s.id,b.business_id,b.outlet_id,'pending',at_ms,at_ms from private.desk_push_subscriptions s
   where s.business_id=b.business_id and s.outlet_id=b.outlet_id and s.application_key=prepare_kitchen_push.application_key and private.desk_push_allowed(s)
   on conflict(task_id,generation,subscription_id) do nothing;
  update private.kitchen_alarm_notifications x set prepared_at=at_ms,
   status=case when exists(select 1 from private.kitchen_push_deliveries d where d.task_id=n.task_id and d.generation=n.generation) then 'pending' else 'complete' end
   where x.task_id=n.task_id and x.generation=n.generation;
 end loop;
 -- Two independent delivery finishes can each observe the other's uncommitted
 -- pending row. Settle that harmless aggregate lag on the next bounded tick.
 for candidate in select x.task_id,x.generation from private.kitchen_alarm_notifications x where x.status='pending' and x.prepared_at is not null
  and not exists(select 1 from private.kitchen_push_deliveries d where d.task_id=x.task_id and d.generation=x.generation and d.state in('pending','sending'))
  order by x.created_at,x.task_id,x.generation limit batch_size loop
  update private.kitchen_alarm_notifications x set status='complete' where x.task_id=candidate.task_id and x.generation=candidate.generation and x.status='pending';
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('taskId',x.task_id,'generation',x.generation,'subscriptionId',x.subscription_id) order by x.due,x.task_id,x.generation,x.subscription_id),'[]'::jsonb)
 into result from(
  select d.*,case when d.state='sending' then d.lease_expires_at else d.next_at end as due from private.kitchen_push_deliveries d
  join private.kitchen_alarm_notifications q on q.task_id=d.task_id and q.generation=d.generation
  where q.status='pending' and(d.state='pending' and d.next_at<=at_ms or d.state='sending' and d.lease_expires_at<=at_ms) and private.kitchen_push_inspection_ready(d.task_id,at_ms)
  order by due,d.task_id,d.generation,d.subscription_id limit batch_size
 ) x;
 return jsonb_build_object('v',1,'at',at_ms,'jobs',result);
end $$;

-- Bounded partial-index candidates. The signature contains no source bodies or
-- credentials. Fresh ready work can bypass an old transport's retry deadline.
create function private.kitchen_dispatch_due_signature(at_ms public.utc_ms) returns text
language sql stable security definer set search_path='' as $$
 with alarms as (
  select jsonb_build_array('alarm',w.business_id,w.outlet_id,w.order_id,w.version,coalesce(r.attempts,0)) as item
   from private.kitchen_alarm_work w left join private.kitchen_alarm_retries r
   on r.business_id=w.business_id and r.outlet_id=w.outlet_id and r.order_id=w.order_id and r.work_version=w.version
   where w.next_at<=at_ms and(r.order_id is null or r.next_at<=at_ms)
   order by w.next_at,w.business_id,w.outlet_id,w.order_id limit 25
 ),expand as (
  select jsonb_build_array('expand',n.task_id,n.generation) as item from private.kitchen_alarm_notifications n
   where n.status='pending' and n.prepared_at is null order by n.created_at,n.task_id,n.generation limit 25
 ),pending as (
  select jsonb_build_array('delivery',d.task_id,d.generation,d.subscription_id,d.attempts) as item
   from private.kitchen_push_deliveries d where d.state='pending' and d.next_at<=at_ms
   and exists(select 1 from private.kitchen_alarm_notifications n where n.task_id=d.task_id and n.generation=d.generation and n.status='pending')
   and private.kitchen_push_inspection_ready(d.task_id,at_ms)
   order by d.next_at,d.task_id,d.generation,d.subscription_id limit 25
 ),expired_lease as (
  select jsonb_build_array('lease',d.task_id,d.generation,d.subscription_id,d.attempts,d.lease_id) as item
   from private.kitchen_push_deliveries d where d.state='sending' and d.lease_expires_at<=at_ms
   and exists(select 1 from private.kitchen_alarm_notifications n where n.task_id=d.task_id and n.generation=d.generation and n.status='pending')
   and private.kitchen_push_inspection_ready(d.task_id,at_ms)
   order by d.lease_expires_at,d.task_id,d.generation,d.subscription_id limit 25
 ),settle as (
  select jsonb_build_array('settle',n.task_id,n.generation) as item from private.kitchen_alarm_notifications n
   where n.status='pending' and n.prepared_at is not null and not exists(
    select 1 from private.kitchen_push_deliveries d where d.task_id=n.task_id and d.generation=n.generation and d.state in('pending','sending'))
   order by n.created_at,n.task_id,n.generation limit 25
 ),ready as(select * from alarms union all select * from expand union all select * from pending union all select * from expired_lease union all select * from settle)
 select case when count(*)=0 then null else encode(sha256(convert_to(jsonb_agg(item order by item)::text,'UTF8')),'hex') end from ready
$$;
revoke all on function private.kitchen_dispatch_due_signature(public.utc_ms) from public,anon,authenticated,service_role;

-- External extension references are intentionally late-bound: this migration
-- installs no extension and remains valid before privileged provisioning.
create function private.kitchen_dispatch_configuration(config_id uuid,key_id uuid) returns jsonb
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
 select s.decrypted_secret into raw from vault.decrypted_secrets s where s.id=config_id;
 if raw is null or octet_length(raw)>4096 then raise exception using message='Private scheduler configuration needs review.';end if;
 begin cfg:=raw::jsonb;exception when others then raise exception using message='Private scheduler configuration needs review.';end;
 if cfg is null or jsonb_typeof(cfg)<>'object' then raise exception using message='Private scheduler configuration needs review.';end if;
 if not(cfg?'apiUrl') or (select count(*) from jsonb_object_keys(cfg))<>1 or
  jsonb_typeof(cfg->'apiUrl')<>'string' or length(cfg->>'apiUrl')>2048 or
  (cfg->>'apiUrl')!~'^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' then
  raise exception using message='Private scheduler configuration needs review.';end if;
 select s.decrypted_secret into credential from vault.decrypted_secrets s where s.id=key_id;
 if credential is null or credential!~'^[A-Za-z0-9_-]{43}$' then raise exception using message='Private scheduler credential needs review.';end if;
 return jsonb_build_object('url',cfg->>'apiUrl','credential',credential);
end $$;
revoke all on function private.kitchen_dispatch_configuration(uuid,uuid) from public,anon,authenticated,service_role;

create function private.configure_kitchen_dispatch(turn_on boolean,config_id uuid default null,key_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.kitchen_dispatch_state;fixed_command constant text:='select private.dispatch_kitchen_work()';
begin
 if turn_on is null then raise invalid_parameter_value using message='Choose whether the scheduler is enabled.';end if;
 select * into s from private.kitchen_dispatch_state where id for update;
 if s.revision=9007199254740991 then raise exception using message='Scheduler configuration needs review.';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job j where j.jobname='mise-kitchen-dispatch' and(j.command<>fixed_command or j.username<>current_user)) then
   raise exception using message='Another scheduler owns this job name.';end if;
 end if;
 if turn_on then
  config_id:=coalesce(config_id,s.config_secret);key_id:=coalesce(key_id,s.key_secret);
  perform private.kitchen_dispatch_configuration(config_id,key_id);
  -- Cron stores a fixed function call, never an URL, header or secret value.
  perform cron.schedule('mise-kitchen-dispatch','1 second',fixed_command);
  update private.kitchen_dispatch_state set enabled=true,revision=s.revision+1,config_secret=config_id,key_secret=key_id,
   next_at=0,request_id=null,queued_at=null,signature=null,failures=0,outcome='idle' where id;
 else
  if config_id is not null or key_id is not null then raise invalid_parameter_value using message='Disable without replacing private configuration.';end if;
  if to_regclass('cron.job') is not null then
   if exists(select 1 from cron.job j where j.jobname='mise-kitchen-dispatch') then perform cron.unschedule('mise-kitchen-dispatch');end if;
  end if;
  update private.kitchen_dispatch_state set enabled=false,revision=s.revision+1,next_at=0,request_id=null,queued_at=null,signature=null,failures=0,outcome='disabled' where id;
 end if;
 return jsonb_build_object('enabled',turn_on,'revision',s.revision+1);
end $$;
revoke all on function private.configure_kitchen_dispatch(boolean,uuid,uuid) from public,anon,authenticated,service_role;

create function private.dispatch_kitchen_work() returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.kitchen_dispatch_state;at_ms public.utc_ms;ready text;cfg jsonb;reply record;request bigint;nonce uuid;proof text;
 failure_count integer;retry_at public.utc_ms;
begin
 select * into s from private.kitchen_dispatch_state where id for update skip locked;
 if not found then return jsonb_build_object('state','busy');end if;
 if not s.enabled then return jsonb_build_object('state','disabled');end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from private.kitchen_dispatch_grants g where g.nonce in(
  select x.nonce from private.kitchen_dispatch_grants x where x.expires_at<at_ms order by x.expires_at,x.nonce limit 100);
 ready:=private.kitchen_dispatch_due_signature(at_ms);
 if ready is null then
  if s.outcome<>'idle' then update private.kitchen_dispatch_state set outcome='idle',failures=0,next_at=0,signature=null where id;end if;
  return jsonb_build_object('state','idle');
 end if;
 -- At most one enqueue per second, even if a privileged manual retry races Cron.
 if s.queued_at is not null and s.queued_at+1000>at_ms then return jsonb_build_object('state','waiting');end if;
 if s.signature=ready and s.next_at>at_ms and s.outcome in('retry','unavailable') then return jsonb_build_object('state','waiting');end if;
 failure_count:=s.failures;
 begin
  cfg:=private.kitchen_dispatch_configuration(s.config_secret,s.key_secret);
  if s.request_id is not null then
   select r.status_code,r.timed_out,r.error_msg is not null as transport_error into reply from net._http_response r where r.id=s.request_id order by r.created desc limit 1;
   if found and reply.status_code in(401,403,404,405,415) then
    update private.kitchen_dispatch_state set enabled=false,outcome='unauthorized',request_id=null where id;
    return jsonb_build_object('state','unavailable');
   end if;
   if found and(reply.timed_out or reply.transport_error or reply.status_code is null or reply.status_code>=500) and s.signature=ready then
    if s.outcome='retry' then retry_at:=s.next_at;
    else failure_count:=least(8,s.failures+1);retry_at:=s.queued_at+least(30000,1000*(1::bigint<<least(5,failure_count)));end if;
    if at_ms<retry_at then
     update private.kitchen_dispatch_state set failures=failure_count,next_at=retry_at,outcome='retry' where id;
     return jsonb_build_object('state','waiting');
    end if;
   elsif s.signature=ready and s.next_at>at_ms then return jsonb_build_object('state','waiting');end if;
  elsif s.signature=ready and s.next_at>at_ms then return jsonb_build_object('state','waiting');end if;
  nonce:=gen_random_uuid();
  insert into private.kitchen_dispatch_grants(nonce,revision,issued_at,batch_size,expires_at) values(nonce,s.revision,at_ms,25,at_ms+60000);
  proof:=encode(extensions.hmac(convert_to(E'mise:kitchen-dispatch:v1\n'||at_ms::text||E'\n'||nonce::text||E'\n25','UTF8'),convert_to(cfg->>'credential','UTF8'),'sha256'),'hex');
  request:=net.http_post(url:=(cfg->>'url')||'/functions/v1/kitchen-dispatch',body:='{"limit":25}'::jsonb,
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer v1.'||at_ms::text||'.'||nonce::text||'.'||proof),
   timeout_milliseconds:=40000);
  if request is null or request<=0 then raise exception using message='Scheduler enqueue is unconfirmed.';end if;
  update private.kitchen_dispatch_state set request_id=request,queued_at=at_ms,signature=ready,next_at=at_ms+2000,
   failures=case when s.signature=ready then failure_count else 0 end,outcome='queued' where id;
  return jsonb_build_object('state','queued');
 exception when others then
  -- Never let extension errors echo a decrypted URL or credential into Cron logs.
  update private.kitchen_dispatch_state set outcome='unavailable',next_at=at_ms+30000,signature=ready where id;
  return jsonb_build_object('state','unavailable');
 end;
end $$;
revoke all on function private.dispatch_kitchen_work() from public,anon,authenticated,service_role;

create function private.read_kitchen_dispatch_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',s.enabled,'revision',s.revision,'state',s.outcome,'nextAt',s.next_at,'failures',s.failures)
  from private.kitchen_dispatch_state s where s.id
$$;
revoke all on function private.read_kitchen_dispatch_status() from public,anon,authenticated,service_role;
