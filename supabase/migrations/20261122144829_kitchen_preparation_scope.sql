-- Preparation eligibility and scheduled acknowledgement timing. Original
-- orders, financial rows, sources, receipts and change feeds are retained.
create function private.kitchen_preparation_status(status text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce($1=any(array['new','to_confirm','confirmed','kitchen_seen','cooking','ready','packed','ordered','making','ready_called','requested','priced','accepted','packing']::text[]),false);
$$;
revoke all on function private.kitchen_preparation_status(text) from public,anon,authenticated,service_role;
drop index public.orders_kitchen_current_idx;
create index orders_kitchen_current_idx on public.orders(business_id,outlet_id,created_at,id)
 where private.kitchen_preparation_status(status);

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
    select x.* from (
      (select o.id,o.created_at,2*octet_length(o.lines::text)+2*octet_length(o.table_label::text)+2048 as weight
       from public.orders o where o.business_id=business and o.outlet_id=outlet
        and private.kitchen_preparation_status(o.status)
        and (after_time is null or (o.created_at,o.id)>(after_time,after_id))
       order by o.created_at,o.id limit page_size+1)
      union all
      (select o.id,o.created_at,2*octet_length(o.lines::text)+2*octet_length(o.table_label::text)+2048 as weight
       from private.kitchen_cancellation_work w join public.orders o
        on o.business_id=w.business_id and o.outlet_id=w.outlet_id and o.id=w.order_id and o.revision=w.order_revision
       where w.business_id=business and w.outlet_id=outlet and o.status='cancelled'
        and (after_time is null or (w.created_at,w.order_id)>(after_time,after_id))
       order by w.created_at,w.order_id limit page_size+1)
    ) x order by x.created_at,x.id limit page_size+1
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

create or replace function private.prepare_kitchen_action(device_secret text,session_secret text,ticket_id public.ulid,request_action jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; old private.kitchen_action_receipts; context json; original_ack jsonb; secret text; at_ms public.utc_ms;
begin
  if ticket_id is null or not private.kitchen_action_valid(request_action) then raise invalid_parameter_value using message='Keep the original kitchen tap.';end if;
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' or not actor->'permissions' ?
    (case when request_action->>'type'='kitchen.acknowledge' then 'orders.acknowledge' else 'orders.ready' end) then return null;end if;
  if actor->>'outletId' is distinct from request_action->>'outletId' then return null;end if;
  perform pg_advisory_xact_lock(hashtextextended(request_action->>'id',0));
  if exists(select 1 from private.kitchen_tap_closures c where c.action_id=request_action->>'id') then
    raise sqlstate 'PT409' using message='This saved tap was closed after review. Keep its original history.';end if;
  select * into old from private.kitchen_action_receipts r where r.id=request_action->>'id';
  if found then
    if old.device_id::text<>actor->>'deviceId' or old.session_id::text<>actor->>'sessionId' or old.member_id::text<>actor->>'memberId'
      or old.business_id::text<>actor->>'businessId' or old.outlet_id::text<>actor->>'outletId' or old.action<>request_action then
      raise sqlstate 'PT409' using message='Keep the original kitchen tap.';end if;
    return jsonb_build_object('done',true,'receipt',old.receipt);
  end if;
  perform 1 from public.outlets s where s.id=actor->>'outletId' and s.business_id=actor->>'businessId' for update;
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' or not actor->'permissions' ?
    (case when request_action->>'type'='kitchen.acknowledge' then 'orders.acknowledge' else 'orders.ready' end) then return null;end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if (request_action->>'occurredAt')::bigint>at_ms+300000 then raise sqlstate 'PT409' using message='Keep the tap and check the device clock.';end if;
  if not exists(select 1 from public.orders o where o.id=request_action->>'orderId' and o.business_id=actor->>'businessId'
    and o.outlet_id=actor->>'outletId' and (o.status='cancelled' or private.kitchen_preparation_status(o.status)) and o.revision>=(request_action->>'revision')::bigint
    and (o.status<>'cancelled' or (request_action->>'revision')::bigint>=coalesce(
      (select e.order_revision from public.events e where e.business_id=o.business_id and e.outlet_id=o.outlet_id and e.id=o.status_event_id),o.revision))) then
    raise sqlstate 'PT409' using message='Refresh the original ticket.';end if;
  -- Actual completed outcomes were returned above. An unaccepted old gesture
  -- must be reviewed after a newer explicit owner undo, without trusting clocks.
  if exists(select 1 from public.events e where e.business_id=actor->>'businessId' and e.outlet_id=actor->>'outletId'
      and e.order_id=request_action->>'orderId' and e.command='order.status-undo' and e.order_revision>(request_action->>'revision')::bigint) then
    raise sqlstate 'PT409' using message='A later status was undone. Keep the saved tap and review the current ticket.';end if;
  if request_action->>'type'='kitchen.ready' then
    select r.receipt into original_ack from private.kitchen_action_receipts r where r.id=request_action->>'parentAckId'
      and r.business_id=actor->>'businessId' and r.outlet_id=actor->>'outletId' and r.order_id=request_action->>'orderId'
      and r.action->>'type'='kitchen.acknowledge' and r.action->>'contentHash'=request_action->>'contentHash'
      and private.kitchen_ack_active(r.business_id,r.outlet_id,r.order_id,r.receipt);
    if original_ack is null then raise sqlstate 'PT409' using message='Keep the actual Got it receipt before Ready.';end if;
  end if;
  delete from private.kitchen_action_tickets t where t.device_id=actor->>'deviceId' and t.expires_at<=at_ms;
  if (select count(*) from private.kitchen_action_tickets t where t.device_id=actor->>'deviceId')>=100 then
    raise sqlstate 'PT429' using message='Wait before preparing more taps.';end if;
  context:=private.kitchen_action_context((actor->>'businessId')::public.ulid,(actor->>'outletId')::public.ulid,(request_action->>'orderId')::public.ulid);
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  insert into private.kitchen_action_tickets values(ticket_id,request_action,(actor->>'businessId')::public.ulid,(actor->>'outletId')::public.ulid,
    (actor->>'deviceId')::public.ulid,(actor->>'sessionId')::public.ulid,(actor->>'memberId')::public.ulid,
    sha256(convert_to(secret,'UTF8')),sha256(convert_to(context::text,'UTF8')),at_ms,at_ms+60000);
  return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'at',at_ms,'access',actor,
    'contextJson',context::text,'acknowledgement',original_ack);
end $$;

create or replace function private.queue_kitchen_alarm() returns trigger
language plpgsql security definer set search_path='' as $$
declare business public.ulid;outlet public.ulid;target public.ulid;t public.ulid;next_at_ms public.utc_ms;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if tg_table_name='orders' and tg_op='DELETE' then business:=old.business_id;outlet:=old.outlet_id;target:=old.id;
 else
  business:=new.business_id;outlet:=new.outlet_id;
  if tg_table_name='orders' then target:=new.id;else target:=new.order_id;end if;
 end if;
 next_at_ms:=at_ms;
 if tg_table_name='orders' then
  if tg_op='DELETE' then next_at_ms:=null;
  elsif not private.kitchen_preparation_status(new.status) then next_at_ms:=null;end if;
 end if;
 insert into private.kitchen_alarm_work as w(business_id,outlet_id,order_id,next_at) values(business,outlet,target,next_at_ms)
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
 elsif not private.kitchen_preparation_status(new.status) then
  for t in select b.task_id from private.kitchen_alarm_tasks b where b.business_id=business and b.outlet_id=outlet and b.order_id=target order by b.task_id loop
   perform private.close_kitchen_alarm(t,case when new.status='cancelled' then 'cancelled' else 'finished' end,null,at_ms);
  end loop;
 end if;
 return null;
end $$;

create or replace function private.finish_kitchen_alarm(business public.ulid,outlet public.ulid,target public.ulid,work_version bigint,stamp text,source_hash text,
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
 due:=case when raw is null then null else greatest(o.created_at,coalesce(o.scheduled_for,o.created_at))+coalesce(s.minutes,2)*60000::bigint end;
 select r.id into ack from private.kitchen_action_receipts r where r.business_id=business and r.outlet_id=outlet and r.order_id=target
  and r.action->>'type'='kitchen.acknowledge' and r.action->>'contentHash'=source_hash and (r.receipt->>'revision')::bigint<=o.revision
  and private.kitchen_ack_active(business,outlet,target,r.receipt) order by r.accepted_at desc,r.id desc limit 1;
 state:=case when raw is null then 'removed' when not coalesce(s.enabled,true) then 'disabled' when o.status='cancelled' then 'cancelled'
  when not private.kitchen_preparation_status(o.status) then 'finished' when ack is not null then 'acknowledged' when at_ms<due then 'waiting' else 'due' end;
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

create or replace function private.set_kitchen_alarm_settings(outlet public.ulid,expected_revision bigint,enabled boolean,minutes integer,event_id public.ulid) returns jsonb
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
 update private.kitchen_alarm_work x set version=x.version+1,next_at=case when exists(select 1 from public.orders o where o.business_id=x.business_id and o.outlet_id=x.outlet_id and o.id=x.order_id and private.kitchen_preparation_status(o.status)) then at_ms else null end where x.business_id=scope->>'businessId' and x.outlet_id=outlet;
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

-- Settle only original open warnings that no longer describe preparation.
-- The existing closer retains task/recipient/accepted-delivery history.
do $backfill$
declare target record;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 for target in select b.task_id,o.status,o.created_at,o.scheduled_for,coalesce(s.minutes,2) minutes
  from private.kitchen_alarm_tasks b join public.tasks t on t.id=b.task_id and t.status='open'
  join public.orders o on o.business_id=b.business_id and o.outlet_id=b.outlet_id and o.id=b.order_id
  left join public.kitchen_alarm_settings s on s.business_id=b.business_id and s.outlet_id=b.outlet_id
  where not private.kitchen_preparation_status(o.status)
   or greatest(o.created_at,coalesce(o.scheduled_for,o.created_at))+coalesce(s.minutes,2)*60000::bigint>at_ms
  order by b.business_id,b.outlet_id,b.task_id loop
   perform private.close_kitchen_alarm(target.task_id,case when target.status='cancelled' then 'cancelled'
    when not private.kitchen_preparation_status(target.status) then 'finished' else 'waiting' end,null,at_ms);
 end loop;
 -- A fresh bounded inspection reconciles scheduled deadlines; closed work
 -- keeps its original watch identity and cannot block a later owner undo.
 update private.kitchen_alarm_work w set version=w.version+1,next_at=case when exists(
  select 1 from public.orders o where o.business_id=w.business_id and o.outlet_id=w.outlet_id and o.id=w.order_id
   and private.kitchen_preparation_status(o.status)) then at_ms else null end;
end $backfill$;
