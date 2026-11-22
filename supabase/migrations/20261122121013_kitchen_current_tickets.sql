-- Current preparation work and original cancellation notices. Original orders,
-- receipts and change-feed history remain authoritative and are never removed.
create table private.kitchen_cancellation_work (
 business_id public.ulid not null,outlet_id public.ulid not null,order_id public.ulid not null,
 order_revision bigint not null check(order_revision between 1 and 9007199254740991),created_at public.utc_ms not null,
 primary key(business_id,outlet_id,order_id),
 foreign key(business_id,outlet_id,order_id) references public.orders(business_id,outlet_id,id) on delete cascade
);
alter table private.kitchen_cancellation_work enable row level security;
alter table private.kitchen_cancellation_work force row level security;
revoke all on private.kitchen_cancellation_work from public,anon,authenticated,service_role;
create index kitchen_cancellation_page_idx on private.kitchen_cancellation_work(business_id,outlet_id,created_at,order_id);
create index orders_kitchen_current_idx on public.orders(business_id,outlet_id,created_at,id)
 where status not in ('delivered','returned','collected','done','cancelled');
create index kitchen_cancel_ack_order_idx on private.kitchen_action_receipts(business_id,outlet_id,order_id)
 where action->>'type'='kitchen.acknowledge' and receipt->>'status'='cancelled';

-- Cancellation identity comes from its actual status event revision. Ordinary
-- financial revisions keep their real acknowledgement; undo/re-cancel does not.
-- Older imported status events without revision proof require a current source.
create or replace function private.kitchen_ack_active(business public.ulid,outlet public.ulid,order_id public.ulid,receipt jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(receipt->>'type'='kitchen.acknowledge' and receipt->>'businessId'=business::text and receipt->>'outletId'=outlet::text
  and receipt->>'orderId'=order_id::text and jsonb_typeof(receipt->'transitionEventIds')='array'
  and (receipt->>'status'<>'cancelled' or exists(
   select 1 from public.orders o left join public.events e on e.business_id=o.business_id and e.outlet_id=o.outlet_id and e.id=o.status_event_id
    where o.business_id=business and o.outlet_id=outlet and o.id=kitchen_ack_active.order_id and o.status='cancelled'
     and (receipt->>'sourceRevision')::bigint>=coalesce(e.order_revision,o.revision)))
  and not exists(select 1 from public.events e where e.business_id=business and e.outlet_id=outlet and e.order_id=kitchen_ack_active.order_id
   and e.command='order.status-undo' and (receipt->'transitionEventIds') ? e.undo_of::text),false);
$$;
revoke all on function private.kitchen_ack_active(public.ulid,public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;

create function private.note_kitchen_cancellation_order() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then
  delete from private.kitchen_cancellation_work w where w.business_id=old.business_id and w.outlet_id=old.outlet_id and w.order_id=old.id;
  return null;
 end if;
 if new.status<>'cancelled' or exists(select 1 from private.kitchen_action_receipts r where r.business_id=new.business_id
   and r.outlet_id=new.outlet_id and r.order_id=new.id and r.action->>'type'='kitchen.acknowledge'
   and r.receipt->>'status'='cancelled' and private.kitchen_ack_active(r.business_id,r.outlet_id,r.order_id,r.receipt)) then
  delete from private.kitchen_cancellation_work w where w.business_id=new.business_id and w.outlet_id=new.outlet_id and w.order_id=new.id;
 else
  insert into private.kitchen_cancellation_work(business_id,outlet_id,order_id,order_revision,created_at)
   values(new.business_id,new.outlet_id,new.id,new.revision,new.created_at)
   on conflict(business_id,outlet_id,order_id) do update set order_revision=excluded.order_revision,created_at=excluded.created_at;
 end if;
 return null;
end $$;
revoke all on function private.note_kitchen_cancellation_order() from public,anon,authenticated,service_role;
create trigger kitchen_cancellation_order after insert or update or delete on public.orders
 for each row execute function private.note_kitchen_cancellation_order();

create function private.note_kitchen_cancellation_receipt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.action->>'type'='kitchen.acknowledge' and new.receipt->>'status'='cancelled' then
  delete from private.kitchen_cancellation_work w where w.business_id=new.business_id and w.outlet_id=new.outlet_id
   and w.order_id=new.order_id and w.order_revision=(new.receipt->>'revision')::bigint;
 end if;
 return null;
end $$;
revoke all on function private.note_kitchen_cancellation_receipt() from public,anon,authenticated,service_role;
create trigger kitchen_cancellation_receipt after insert on private.kitchen_action_receipts
 for each row execute function private.note_kitchen_cancellation_receipt();

-- Existing cached screens also need to reread the newly current cancellation
-- state. Reuse the original fenced IDs-only feed for this migration backfill.
create trigger kitchen_cancellation_backfill_change after insert on private.kitchen_cancellation_work
 for each row execute function private.note_kitchen_change();
insert into private.kitchen_cancellation_work(business_id,outlet_id,order_id,order_revision,created_at)
 select o.business_id,o.outlet_id,o.id,o.revision,o.created_at from public.orders o where o.status='cancelled' and not exists(
  select 1 from private.kitchen_action_receipts r where r.business_id=o.business_id and r.outlet_id=o.outlet_id and r.order_id=o.id
   and r.action->>'type'='kitchen.acknowledge' and r.receipt->>'status'='cancelled'
   and private.kitchen_ack_active(r.business_id,r.outlet_id,r.order_id,r.receipt));
drop trigger kitchen_cancellation_backfill_change on private.kitchen_cancellation_work;

-- These full reference indexes also cover revoked history, which the existing
-- current-subscription indexes deliberately omit. Keep those fast live lookups.
create index desk_push_auth_reference_idx on private.desk_push_subscriptions(auth_user_id);
create index desk_push_member_reference_idx on private.desk_push_subscriptions(business_id,member_id);
create index desk_push_created_reference_idx on private.desk_push_subscriptions(business_id,outlet_id,created_event_id);
create index desk_push_revoked_reference_idx on private.desk_push_subscriptions(business_id,outlet_id,revoked_event_id);

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
        and o.status not in ('delivered','returned','collected','done','cancelled')
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
    and o.outlet_id=actor->>'outletId' and o.revision>=(request_action->>'revision')::bigint
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
