-- Server-owned alarm tasks use the existing Inbox task entity. Captured customer
-- text/images, financial records and original kitchen receipts are unchanged.
create function private.kitchen_alarm_outlets() returns setof public.ulid
language sql stable security definer set search_path='' as $$
 select unnest(a.outlet_ids) from private.current_access() a where a.role in('owner','manager')
  and exists(select 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous)
$$;
revoke all on function private.kitchen_alarm_outlets() from public,anon,authenticated,service_role;
grant execute on function private.kitchen_alarm_outlets() to authenticated;
drop policy tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated using(outlet_id in(select private.kitchen_alarm_outlets()));
create table public.kitchen_alarm_settings (
 business_id public.ulid not null,outlet_id public.ulid primary key,
 enabled boolean not null,minutes integer not null check(minutes between 1 and 1440),
 revision public.ordinal not null,updated_at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id)
);
alter table public.kitchen_alarm_settings enable row level security;
alter table public.kitchen_alarm_settings force row level security;
revoke all on public.kitchen_alarm_settings from public,anon,authenticated,service_role;
grant select on public.kitchen_alarm_settings to authenticated;
create policy kitchen_alarm_settings_read on public.kitchen_alarm_settings for select to authenticated
 using(outlet_id in(select private.kitchen_alarm_outlets()));

-- One durable watch per original order. It remains after deletion so an older
-- worker cannot erase a newer generation or retarget an archived task.
create table private.kitchen_alarm_work (
 business_id public.ulid not null,outlet_id public.ulid not null,order_id public.ulid not null,
 version bigint not null default 1 check(version between 1 and 9007199254740991),next_at public.utc_ms,
 primary key(business_id,outlet_id,order_id),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id)
);
create index kitchen_alarm_work_due_idx on private.kitchen_alarm_work(next_at,business_id,outlet_id,order_id) where next_at is not null;
create table private.kitchen_alarm_tasks (
 task_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,order_id public.ulid not null,
 content_hash text not null check(content_hash~'^[0-9a-f]{64}$'),source_revision public.ordinal not null,
 generation bigint not null check(generation between 1 and 9007199254740991),raised_at public.utc_ms not null,
 resolve_event_id public.ulid not null unique,reason text,acknowledgement_id public.ulid,
 unique(business_id,outlet_id,order_id,content_hash),
 foreign key(business_id,outlet_id,task_id) references public.tasks(business_id,outlet_id,id)
);
create index kitchen_alarm_tasks_order_idx on private.kitchen_alarm_tasks(business_id,outlet_id,order_id);
-- Push delivery is separate from raising a task: a lost HTTP response never
-- creates another alarm, and a real Got it cancels unsent notifications.
create table private.kitchen_alarm_notifications (
 task_id public.ulid not null references private.kitchen_alarm_tasks(task_id),generation bigint not null,
 status text not null check(status in('pending','sent','cancelled')),created_at public.utc_ms not null,
 primary key(task_id,generation)
);
do $$declare t text;begin foreach t in array array['kitchen_alarm_work','kitchen_alarm_tasks','kitchen_alarm_notifications'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('alter table private.%I force row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
end loop;end $$;

create function private.close_kitchen_alarm(task public.ulid,why text,ack public.ulid,at_ms public.utc_ms) returns void
language plpgsql security invoker set search_path='' as $$
declare binding private.kitchen_alarm_tasks;t public.tasks;
begin
 select * into binding from private.kitchen_alarm_tasks x where x.task_id=task for update;
 if not found then return;end if;
 select * into t from public.tasks x where x.id=task for update;
 if t.status<>'open' then return;end if;
 update public.tasks x set status='resolved',updated_at=greatest(at_ms,x.updated_at) where x.id=task;
 update private.kitchen_alarm_tasks x set reason=why,acknowledgement_id=ack where x.task_id=task;
 update private.kitchen_alarm_notifications x set status='cancelled' where x.task_id=task and x.status='pending';
 insert into public.events(id,business_id,outlet_id,order_id,actor_type,actor_id,command,before_data,after_data,at)
 values(binding.resolve_event_id,binding.business_id,binding.outlet_id,binding.order_id,'system','kitchen-alarm','kitchen.alarm.resolved',
  json_build_object('taskId',task,'generation',binding.generation,'status','open'),
  json_build_object('taskId',task,'generation',binding.generation,'status','resolved','reason',why,'acknowledgementId',ack),at_ms);
end $$;

create function private.queue_kitchen_alarm() returns trigger
language plpgsql security definer set search_path='' as $$
declare business public.ulid;outlet public.ulid;target public.ulid;t public.ulid;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if tg_table_name='orders' and tg_op='DELETE' then business:=old.business_id;outlet:=old.outlet_id;target:=old.id;
 else
  business:=new.business_id;outlet:=new.outlet_id;
  if tg_table_name='orders' then target:=new.id;else target:=new.order_id;end if;
 end if;
 insert into private.kitchen_alarm_work as w(business_id,outlet_id,order_id,next_at) values(business,outlet,target,at_ms)
  on conflict(business_id,outlet_id,order_id) do update set version=w.version+1,next_at=excluded.next_at;
 if tg_table_name='kitchen_action_receipts' then
  if new.action->>'type'='kitchen.acknowledge' and private.kitchen_ack_active(business,outlet,target,new.receipt) then
   for t in select b.task_id from private.kitchen_alarm_tasks b where b.business_id=business and b.outlet_id=outlet and b.order_id=target and b.content_hash=new.action->>'contentHash' order by b.task_id loop
    perform private.close_kitchen_alarm(t,'acknowledged',new.id,at_ms);
   end loop;
  end if;
 elsif tg_op='DELETE' then
  for t in select b.task_id from private.kitchen_alarm_tasks b where b.business_id=business and b.outlet_id=outlet and b.order_id=target order by b.task_id loop
   perform private.close_kitchen_alarm(t,'removed',null,at_ms);
  end loop;
 elsif new.status in('delivered','returned','collected','done','cancelled') then
  for t in select b.task_id from private.kitchen_alarm_tasks b where b.business_id=business and b.outlet_id=outlet and b.order_id=target order by b.task_id loop
   perform private.close_kitchen_alarm(t,case when new.status='cancelled' then 'cancelled' else 'finished' end,null,at_ms);
  end loop;
 end if;
 return null;
end $$;
create trigger kitchen_alarm_order after insert or update or delete on public.orders for each row execute function private.queue_kitchen_alarm();
create trigger kitchen_alarm_receipt after insert on private.kitchen_action_receipts for each row execute function private.queue_kitchen_alarm();
insert into private.kitchen_alarm_work(business_id,outlet_id,order_id,next_at)
 select business_id,outlet_id,id,floor(extract(epoch from statement_timestamp())*1000)::bigint from public.orders where status not in('delivered','returned','collected','done','cancelled');

create function private.prepare_kitchen_alarms(batch_size integer) returns jsonb
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
   where x.next_at<=at_ms order by x.next_at,x.business_id,x.outlet_id,x.order_id limit batch_size
  ),sized as (
   select *,row_number() over(order by next_at,business_id,outlet_id,order_id) as n,sum(weight) over(order by next_at,business_id,outlet_id,order_id) as bytes from candidates
  ) select * from sized where n=1 or bytes<=4194304
 ) w
 left join public.kitchen_alarm_settings s on s.business_id=w.business_id and s.outlet_id=w.outlet_id
 cross join lateral(select private.kitchen_read_rows(w.business_id,w.outlet_id,array[w.order_id])->0 as source) r;
 return jsonb_build_object('v',1,'at',at_ms,'jobs',result);
end $$;

create function private.finish_kitchen_alarm(business public.ulid,outlet public.ulid,target public.ulid,work_version bigint,stamp text,source_hash text,
 new_task_id public.ulid,raise_event_id public.ulid,close_event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w private.kitchen_alarm_work;o public.orders;s public.kitchen_alarm_settings;raw jsonb;due public.utc_ms;ack public.ulid;
 b private.kitchen_alarm_tasks;old_task public.ulid;state text;raised boolean:=false;at_ms public.utc_ms;
begin
 if business is null or outlet is null or target is null or work_version is null or stamp is null or stamp!~'^[0-9a-f]{64}$' or
  source_hash is not null and source_hash!~'^[0-9a-f]{64}$' or new_task_id is null or raise_event_id is null or close_event_id is null or
  new_task_id=raise_event_id or new_task_id=close_event_id or raise_event_id=close_event_id then raise invalid_parameter_value using message='Use the original prepared alarm.';end if;
 -- Same lock order as normal order commands. The worker does not hold a work
 -- row while waiting for a writer which needs that row's trigger.
 perform 1 from public.businesses x where x.id=business for share;
 perform 1 from public.outlets x where x.business_id=business and x.id=outlet for update;
 select * into o from public.orders x where x.business_id=business and x.outlet_id=outlet and x.id=target for update;
 select * into w from private.kitchen_alarm_work x where x.business_id=business and x.outlet_id=outlet and x.order_id=target for update;
 if not found or w.version<>work_version or w.next_at is null then return jsonb_build_object('state','stale','raised',false);end if;
 raw:=private.kitchen_read_rows(business,outlet,array[target])->0;
 if encode(sha256(convert_to(coalesce(raw::text,'null'),'UTF8')),'hex')<>stamp then return jsonb_build_object('state','stale','raised',false);end if;
 if raw is not null and source_hash is null then raise invalid_parameter_value using message='Hash the actual preparation source.';end if;
 select * into s from public.kitchen_alarm_settings x where x.business_id=business and x.outlet_id=outlet;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 due:=case when raw is null then null else o.created_at+coalesce(s.minutes,2)*60000::bigint end;
 select r.id into ack from private.kitchen_action_receipts r where r.business_id=business and r.outlet_id=outlet and r.order_id=target
  and r.action->>'type'='kitchen.acknowledge' and r.action->>'contentHash'=source_hash and (r.receipt->>'revision')::bigint<=o.revision
  and private.kitchen_ack_active(business,outlet,target,r.receipt) order by r.accepted_at desc,r.id desc limit 1;
 state:=case when raw is null then 'removed' when not coalesce(s.enabled,true) then 'disabled' when o.status='cancelled' then 'cancelled'
  when o.status in('delivered','returned','collected','done') then 'finished' when ack is not null then 'acknowledged' when at_ms<due then 'waiting' else 'due' end;
 for old_task in select x.task_id from private.kitchen_alarm_tasks x where x.business_id=business and x.outlet_id=outlet and x.order_id=target
  and (x.content_hash is distinct from source_hash or state<>'due') order by x.task_id loop
  perform private.close_kitchen_alarm(old_task,case when state='due' then 'changed' else state end,ack,at_ms);
 end loop;
 if state='due' then
  select * into b from private.kitchen_alarm_tasks x where x.business_id=business and x.outlet_id=outlet and x.order_id=target and x.content_hash=source_hash for update;
  if not found then
   insert into public.tasks(id,business_id,outlet_id,kind,title,body,actions,assignee,status,due_at,created_at,updated_at)
    values(new_task_id,business,outlet,'check',to_json('Order '||o.number||' needs Got it'),to_json('No preparation acknowledgement after '||coalesce(s.minutes,2)||' minutes.'),
     json_build_array(json_build_object('kind','open-order','orderId',target),json_build_object('kind','copy','text','Order '||o.number||' needs Got it')),'human','open',due,at_ms,at_ms);
   insert into private.kitchen_alarm_tasks values(new_task_id,business,outlet,target,source_hash,o.revision,1,at_ms,close_event_id,null,null) returning * into b;
   raised:=true;
  elsif exists(select 1 from public.tasks x where x.id=b.task_id and x.status='resolved') then
   update public.tasks x set status='open',due_at=due,body=to_json('No preparation acknowledgement after '||coalesce(s.minutes,2)||' minutes.'),updated_at=greatest(at_ms,x.updated_at) where x.id=b.task_id;
   update private.kitchen_alarm_tasks x set generation=x.generation+1,raised_at=at_ms,resolve_event_id=close_event_id,reason=null,acknowledgement_id=null where x.task_id=b.task_id returning * into b;
   raised:=true;
  end if;
  if raised then
   insert into private.kitchen_alarm_notifications values(b.task_id,b.generation,'pending',at_ms);
   insert into public.events(id,business_id,outlet_id,order_id,actor_type,actor_id,command,before_data,after_data,at)
    values(raise_event_id,business,outlet,target,'system','kitchen-alarm','kitchen.alarm.raised','null',
     json_build_object('taskId',b.task_id,'orderId',target,'sourceRevision',b.source_revision,'contentHash',b.content_hash,'generation',b.generation,'warningMinutes',coalesce(s.minutes,2),'dueAt',due),at_ms);
  end if;
 end if;
 update private.kitchen_alarm_work x set next_at=case when state='waiting' then due else null end
  where x.business_id=business and x.outlet_id=outlet and x.order_id=target and x.version=work_version;
 return jsonb_build_object('state',state,'raised',raised,'taskId',case when state='due' then b.task_id else null end);
end $$;

create function private.set_kitchen_alarm_settings(outlet public.ulid,expected_revision bigint,enabled boolean,minutes integer,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb;s public.kitchen_alarm_settings;old public.events;result jsonb;t public.ulid;at_ms public.utc_ms;
begin
 scope:=private.device_access_actor(outlet);
 perform 1 from public.outlets x where x.business_id=scope->>'businessId' and x.id=outlet for update;
 if expected_revision is null or expected_revision<0 or enabled is null or minutes is null or minutes not between 1 and 1440 or event_id is null then
  raise invalid_parameter_value using message='Choose a kitchen warning between 1 and 1440 minutes.';end if;
 select * into old from public.events x where x.id=event_id;
 if found then
  if old.business_id::text<>scope->>'businessId' or old.outlet_id<>outlet or old.actor_type<>'member' or old.actor_id<>scope->>'actorId' or old.command<>'kitchen.alarm.settings'
   or old.after_data->>'enabled'<>enabled::text or (old.after_data->>'minutes')::integer<>minutes or (old.after_data->>'expectedRevision')::bigint<>expected_revision then
   raise sqlstate 'PT409' using message='Keep the original kitchen settings change.';end if;
  return old.after_data::jsonb;
 end if;
 select * into s from public.kitchen_alarm_settings x where x.business_id=scope->>'businessId' and x.outlet_id=outlet for update;
 if coalesce(s.revision,0)<>expected_revision then raise sqlstate 'PT409' using message='Refresh the current kitchen settings.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 insert into public.kitchen_alarm_settings as x values((scope->>'businessId')::public.ulid,outlet,enabled,minutes,expected_revision+1,at_ms)
  on conflict(outlet_id) do update set enabled=excluded.enabled,minutes=excluded.minutes,revision=excluded.revision,updated_at=excluded.updated_at;
 result:=jsonb_build_object('enabled',enabled,'minutes',minutes,'revision',expected_revision+1,'expectedRevision',expected_revision,'updatedAt',at_ms);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(event_id,(scope->>'businessId')::public.ulid,outlet,'member',scope->>'actorId','kitchen.alarm.settings',
   json_build_object('enabled',coalesce(s.enabled,true),'minutes',coalesce(s.minutes,2),'revision',coalesce(s.revision,0)),result::json,at_ms);
 update private.kitchen_alarm_work x set version=x.version+1,next_at=at_ms where x.business_id=scope->>'businessId' and x.outlet_id=outlet;
 -- Reuse the IDs-only feed as a wake hint. The authoritative reader returns
 -- fresh settings even if this order's preparation content did not change.
 select min(o.id)::public.ulid into t from public.orders o where o.business_id=scope->>'businessId' and o.outlet_id=outlet;
 if t is not null then
  perform pg_advisory_xact_lock(hashtextextended('mise:kitchen-feed:'||(scope->>'businessId')||':'||outlet::text,0));
  insert into private.kitchen_changes(business_id,outlet_id,order_id) values((scope->>'businessId')::public.ulid,outlet,t);
  begin perform realtime.send(jsonb_build_object('orderId',t),'kitchen_changed','kitchen:'||outlet::text,true);exception when others then null;end;
 end if;
 if not enabled then
  for t in select b.task_id from private.kitchen_alarm_tasks b where b.business_id=scope->>'businessId' and b.outlet_id=outlet order by b.task_id loop
   perform private.close_kitchen_alarm(t,'disabled',null,at_ms);
  end loop;
 end if;
 return result;
end $$;

create function private.read_kitchen_alarm_tasks(outlet public.ulid,page_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare business public.ulid;result jsonb;s public.kitchen_alarm_settings;
begin
 if not exists(select 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous) then raise insufficient_privilege using message='Sign in with your phone account.';end if;
 select a.business_id into business from private.current_access() a where a.role in('owner','manager') and outlet=any(a.outlet_ids);
 if not found then raise insufficient_privilege using message='Open an assigned outlet.';end if;
 if page_size is null or page_size not between 1 and 100 then raise invalid_parameter_value using message='Use a bounded task page.';end if;
 select * into s from public.kitchen_alarm_settings x where x.business_id=business and x.outlet_id=outlet;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'orderId',x.order_id,'contentHash',x.content_hash,'sourceRevision',x.source_revision,
  'generation',x.generation,'titleJson',x.title::text,'bodyJson',x.body::text,'actionsJson',x.actions::text,'dueAt',x.due_at,'raisedAt',x.raised_at,'updatedAt',x.updated_at)
  order by x.due_at,x.id),'[]'::jsonb) into result from(
   select t.*,b.order_id,b.content_hash,b.source_revision,b.generation,b.raised_at from public.tasks t join private.kitchen_alarm_tasks b on b.task_id=t.id
   where t.business_id=business and t.outlet_id=outlet and t.status='open' order by t.due_at,t.id limit page_size
  ) x;
 return jsonb_build_object('v',1,'businessId',business,'outletId',outlet,'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,
  'settings',jsonb_build_object('enabled',coalesce(s.enabled,true),'minutes',coalesce(s.minutes,2),'revision',coalesce(s.revision,0)),'tasks',result);
end $$;

revoke all on function private.close_kitchen_alarm(public.ulid,text,public.ulid,public.utc_ms),private.queue_kitchen_alarm(),
 private.prepare_kitchen_alarms(integer),private.finish_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text,text,public.ulid,public.ulid,public.ulid),
 private.set_kitchen_alarm_settings(public.ulid,bigint,boolean,integer,public.ulid),private.read_kitchen_alarm_tasks(public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.prepare_kitchen_alarms(integer),private.finish_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text,text,public.ulid,public.ulid,public.ulid) to service_role;
grant execute on function private.set_kitchen_alarm_settings(public.ulid,bigint,boolean,integer,public.ulid),private.read_kitchen_alarm_tasks(public.ulid,integer) to authenticated;
create function public.prepare_kitchen_alarms(p_limit integer default 25) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_kitchen_alarms(p_limit)$$;
create function public.finish_kitchen_alarm(p_business_id public.ulid,p_outlet_id public.ulid,p_order_id public.ulid,p_version bigint,p_stamp text,p_content_hash text,p_task_id public.ulid,p_event_id public.ulid,p_resolve_event_id public.ulid) returns jsonb
 language sql security invoker set search_path='' as $$select private.finish_kitchen_alarm(p_business_id,p_outlet_id,p_order_id,p_version,p_stamp,p_content_hash,p_task_id,p_event_id,p_resolve_event_id)$$;
create function public.set_kitchen_alarm_settings(p_outlet_id public.ulid,p_expected_revision bigint,p_enabled boolean,p_minutes integer,p_event_id public.ulid) returns jsonb
 language sql security invoker set search_path='' as $$select private.set_kitchen_alarm_settings(p_outlet_id,p_expected_revision,p_enabled,p_minutes,p_event_id)$$;
create function public.read_kitchen_alarm_tasks(p_outlet_id public.ulid,p_limit integer default 50) returns jsonb
 language sql security invoker set search_path='' as $$select private.read_kitchen_alarm_tasks(p_outlet_id,p_limit)$$;
revoke all on function public.prepare_kitchen_alarms(integer),public.finish_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text,text,public.ulid,public.ulid,public.ulid),
 public.set_kitchen_alarm_settings(public.ulid,bigint,boolean,integer,public.ulid),public.read_kitchen_alarm_tasks(public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.prepare_kitchen_alarms(integer),public.finish_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text,text,public.ulid,public.ulid,public.ulid) to service_role;
grant execute on function public.set_kitchen_alarm_settings(public.ulid,bigint,boolean,integer,public.ulid),public.read_kitchen_alarm_tasks(public.ulid,integer) to authenticated;

-- Outlet-specific warning settings in the existing ticket wire.
create or replace function private.read_kitchen_page(device_secret text,session_secret text,after_time public.utc_ms,after_id public.ulid,page_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; selected public.ulid[]; cursor jsonb; more boolean; watermark bigint; business public.ulid; outlet public.ulid;
begin
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' then return null;end if;
  if page_size is null or page_size not between 1 and 100 or (after_time is null)<>(after_id is null) then raise invalid_parameter_value using message='Use a complete kitchen page.';end if;
  business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;
  select coalesce(max(c.seq),0) into watermark from private.kitchen_changes c where c.business_id=business and c.outlet_id=outlet;
  with candidates as materialized (
    select o.id,o.created_at,2*octet_length(o.lines::text)+2*octet_length(o.table_label::text)+2048 as weight
    from public.orders o where o.business_id=business and o.outlet_id=outlet and (after_time is null or (o.created_at,o.id)>(after_time,after_id))
    order by o.created_at,o.id limit page_size+1
  ), sized as (
    select *,row_number() over(order by created_at,id) as n,sum(weight) over(order by created_at,id) as bytes from candidates
  ), page as (
    select * from sized where n<=page_size and (n=1 or bytes<=4194304) order by created_at,id
  )
  select coalesce(array_agg(p.id order by p.created_at,p.id),'{}'::public.ulid[]),
    (select jsonb_build_object('createdAt',x.created_at,'id',x.id) from page x order by x.created_at desc,x.id desc limit 1),
    (select count(*) from candidates)>(select count(*) from page) into selected,cursor,more from page p;
  return jsonb_build_object('v',1,'access',actor,'outletNameJson',s.name::text,'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,
    'warningMinutes',case when not coalesce((select k.enabled from public.kitchen_alarm_settings k where k.business_id=s.business_id and k.outlet_id=s.id),true) then null else coalesce((select k.minutes from public.kitchen_alarm_settings k where k.business_id=s.business_id and k.outlet_id=s.id),2) end,'watermark',watermark,'orders',private.kitchen_read_rows(business,outlet,selected),'next',case when more then cursor else null end)
    from public.outlets s where s.business_id=business and s.id=outlet;
end $$;

create or replace function private.read_kitchen_changes(device_secret text,session_secret text,after_seq bigint,until_seq bigint,page_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; business public.ulid; outlet public.ulid; high bigint; selected public.ulid[]; last_seq bigint; more boolean; removed jsonb;
begin
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' then return null;end if;
  business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;
  select coalesce(max(c.seq),0) into high from private.kitchen_changes c where c.business_id=business and c.outlet_id=outlet;
  if after_seq is null or after_seq<0 or after_seq>high or until_seq is not null and (until_seq<after_seq or until_seq>high) or
    page_size is null or page_size not between 1 and 100 then raise invalid_parameter_value using message='Use the original kitchen cursor.';end if;
  high:=coalesce(until_seq,high);
  with candidates as materialized (
    select c.seq,c.order_id,coalesce(2*octet_length(o.lines::text)+2*octet_length(o.table_label::text)+2048,128) as weight
    from private.kitchen_changes c left join public.orders o on o.business_id=c.business_id and o.outlet_id=c.outlet_id and o.id=c.order_id
    where c.business_id=business and c.outlet_id=outlet and c.seq>after_seq and c.seq<=high order by c.seq limit page_size+1
  ), sized as (
    select *,row_number() over(order by seq) as n,sum(weight) over(order by seq) as bytes from candidates
  ), page as (
    select * from sized where n<=page_size and (n=1 or bytes<=4194304) order by seq
  )
  select coalesce(array_agg(distinct p.order_id),'{}'::public.ulid[]),max(p.seq),
    (select count(*) from candidates)>(select count(*) from page) into selected,last_seq,more from page p;
  select coalesce(jsonb_agg(x order by x),'[]'::jsonb) into removed from unnest(selected) x where
    not exists(select 1 from public.orders o where o.business_id=business and o.outlet_id=outlet and o.id=x);
  return jsonb_build_object('v',1,'access',actor,'outletNameJson',s.name::text,'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,
    'warningMinutes',case when not coalesce((select k.enabled from public.kitchen_alarm_settings k where k.business_id=s.business_id and k.outlet_id=s.id),true) then null else coalesce((select k.minutes from public.kitchen_alarm_settings k where k.business_id=s.business_id and k.outlet_id=s.id),2) end,'watermark',high,'nextSeq',case when more then last_seq else high end,
    'orders',private.kitchen_read_rows(business,outlet,selected),'removed',removed)
    from public.outlets s where s.business_id=business and s.id=outlet;
end $$;
