-- A saved tap can be recovered after its original PIN session ends. Closing
-- one retains its reported original action and records the reviewing member;
-- it never acknowledges preparation or changes an order/payment.
create table private.kitchen_tap_closures (
  action_id public.ulid primary key,id public.ulid not null unique,
  business_id public.ulid not null,outlet_id public.ulid not null,
  device_id public.ulid not null references private.devices(id),
  original_session_id public.ulid not null references private.device_sessions(id),original_member_id public.ulid not null,
  session_id public.ulid not null references private.device_sessions(id),member_id public.ulid not null,
  action jsonb not null,proof jsonb not null,closed_at public.utc_ms not null,
  foreign key(business_id,outlet_id) references public.outlets(business_id,id),
  foreign key(business_id,original_member_id) references public.members(business_id,id),
  foreign key(business_id,member_id) references public.members(business_id,id)
);
alter table private.kitchen_tap_closures enable row level security;
alter table private.kitchen_tap_closures force row level security;
revoke all on private.kitchen_tap_closures from public,anon,authenticated,service_role;
create index kitchen_closure_scope_idx on private.kitchen_tap_closures(business_id,outlet_id,action_id);
create index kitchen_closure_device_idx on private.kitchen_tap_closures(device_id);
create index kitchen_closure_original_session_idx on private.kitchen_tap_closures(original_session_id);
create index kitchen_closure_session_idx on private.kitchen_tap_closures(session_id);
create index kitchen_closure_original_member_idx on private.kitchen_tap_closures(business_id,original_member_id);
create index kitchen_closure_member_idx on private.kitchen_tap_closures(business_id,member_id);
create index kitchen_ticket_action_lookup_idx on private.kitchen_action_tickets((action->>'id'));

create function private.recover_kitchen_tap(device_secret text,session_secret text,original jsonb,resolution jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare actor jsonb; original_session private.device_sessions; accepted private.kitchen_action_receipts;
  closed private.kitchen_tap_closures; requested jsonb; result jsonb; at_ms public.utc_ms;
begin
  if jsonb_typeof(original) is distinct from 'object' or not original ?& array['action','sessionId','memberId'] or
    original-array['action','sessionId','memberId']<>'{}'::jsonb or not private.kitchen_action_valid(original->'action') or
    jsonb_typeof(original->'sessionId') is distinct from 'string' or original->>'sessionId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or
    jsonb_typeof(original->'memberId') is distinct from 'string' or original->>'memberId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' then
    raise invalid_parameter_value using message='Keep the complete original saved tap.';end if;
  if resolution is not null and (jsonb_typeof(resolution) is distinct from 'object' or
    not resolution ?& array['id','sessionId','memberId','occurredAt'] or resolution-array['id','sessionId','memberId','occurredAt']<>'{}'::jsonb or
    jsonb_typeof(resolution->'id') is distinct from 'string' or resolution->>'id'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or
    jsonb_typeof(resolution->'sessionId') is distinct from 'string' or resolution->>'sessionId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or
    jsonb_typeof(resolution->'memberId') is distinct from 'string' or resolution->>'memberId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or
    jsonb_typeof(resolution->'occurredAt') is distinct from 'number' or (resolution->>'occurredAt')::numeric not between 0 and 8640000000000000 or
    (resolution->>'occurredAt')::numeric<>trunc((resolution->>'occurredAt')::numeric) or
    (jsonb_build_array(original#>>'{action,id}',original#>>'{action,outletId}',original#>>'{action,orderId}',original#>>'{action,parentAckId}')||
      (original#>'{action,transitionEventIds}')) ? (resolution->>'id')) then
    raise invalid_parameter_value using message='Keep the original review request.';end if;
  requested:=original->'action';
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' or actor->>'outletId' is distinct from requested->>'outletId' then return null;end if;
  -- The identical action fence is also held by preparation and finalization.
  -- Lookup never treats absence as acceptance or permission to resend.
  perform pg_advisory_xact_lock(hashtextextended(requested->>'id',0));
  if resolution is not null then
    perform 1 from public.businesses b where b.id=actor->>'businessId' for share;
    perform 1 from public.outlets o where o.business_id=actor->>'businessId' and o.id=actor->>'outletId' for update;
    perform 1 from private.devices d where d.id=actor->>'deviceId' for share;
    perform 1 from private.device_sessions s where s.id=actor->>'sessionId' for share;
    perform 1 from public.members m where m.business_id=actor->>'businessId' and m.id=actor->>'memberId' for share;
    perform 1 from private.staff_pins p where p.business_id=actor->>'businessId' and p.member_id=actor->>'memberId' for share;
    perform 1 from public.member_outlets m where m.business_id=actor->>'businessId' and m.outlet_id=actor->>'outletId' and m.member_id=actor->>'memberId' for share;
  end if;
  actor:=private.read_device_session(device_secret,session_secret);
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if actor is null or not actor->'permissions' ? 'orders.read' or actor->>'outletId' is distinct from requested->>'outletId' or
    (actor->>'expiresAt')::bigint<=at_ms then return null;end if;
  select * into original_session from private.device_sessions s where s.id=original->>'sessionId' and s.member_id=original->>'memberId'
    and s.business_id=actor->>'businessId' and s.outlet_id=actor->>'outletId' and s.device_id=actor->>'deviceId';
  if not found then raise sqlstate 'PT409' using message='Keep the saved tap for review on its original screen.';end if;
  result:=jsonb_build_object('v',1,'access',actor,'at',at_ms,'original',original,'outcome','pending','receipt',null,'closure',null);
  select * into accepted from private.kitchen_action_receipts r where r.id=requested->>'id';
  if found then
    if accepted.business_id::text<>actor->>'businessId' or accepted.outlet_id::text<>actor->>'outletId' or
      accepted.device_id<>original_session.device_id or accepted.session_id<>original_session.id or accepted.member_id<>original_session.member_id or
      accepted.action<>requested then raise sqlstate 'PT409' using message='Keep the exact original saved tap.';end if;
    return result||jsonb_build_object('outcome','accepted','receipt',accepted.receipt);
  end if;
  select * into closed from private.kitchen_tap_closures c where c.action_id=requested->>'id';
  if found then
    if closed.business_id::text<>actor->>'businessId' or closed.outlet_id::text<>actor->>'outletId' or
      closed.device_id<>original_session.device_id or closed.original_session_id<>original_session.id or closed.original_member_id<>original_session.member_id or
      closed.action<>requested then raise sqlstate 'PT409' using message='Keep the exact original saved tap.';end if;
    return result||jsonb_build_object('outcome','closed','closure',closed.proof);
  end if;
  if exists(select 1 from private.kitchen_action_tickets t where t.action->>'id'=requested->>'id' and
    (t.business_id<>original_session.business_id or t.outlet_id<>original_session.outlet_id or t.device_id<>original_session.device_id or
      t.session_id<>original_session.id or t.member_id<>original_session.member_id or t.action<>requested)) then
    raise sqlstate 'PT409' using message='Keep the exact original saved tap.';end if;
  if resolution is null then return result;end if;
  if not actor->'permissions' ? (case when requested->>'type'='kitchen.acknowledge' then 'orders.acknowledge' else 'orders.ready' end) then return null;end if;
  if resolution->>'sessionId' is distinct from actor->>'sessionId' or resolution->>'memberId' is distinct from actor->>'memberId' or
    (resolution->>'occurredAt')::bigint>at_ms+300000 then raise sqlstate 'PT409' using message='Review this saved tap with the current PIN session.';end if;
  result:=result||jsonb_build_object('outcome','closed','closure',jsonb_build_object('v',1,'id',resolution->>'id','type','kitchen.tap-closed',
    'businessId',actor->>'businessId','outletId',actor->>'outletId','deviceId',actor->>'deviceId',
    'originalSessionId',original_session.id,'originalMemberId',original_session.member_id,'action',requested,
    'sessionId',actor->>'sessionId','memberId',actor->>'memberId','occurredAt',resolution->'occurredAt','closedAt',at_ms));
  insert into private.kitchen_tap_closures values((requested->>'id')::public.ulid,(resolution->>'id')::public.ulid,
    (actor->>'businessId')::public.ulid,(actor->>'outletId')::public.ulid,original_session.device_id,original_session.id,original_session.member_id,
    (actor->>'sessionId')::public.ulid,(actor->>'memberId')::public.ulid,requested,result->'closure',at_ms);
  -- Finalization re-reads its prepared ticket under this same action fence.
  -- Deleting ALL plans makes an already-started old request fail safely;
  -- the preparation guard below prevents a later request replacing a plan.
  delete from private.kitchen_action_tickets t where t.action=requested and t.business_id=original_session.business_id and
    t.outlet_id=original_session.outlet_id and t.device_id=original_session.device_id and t.session_id=original_session.id and t.member_id=original_session.member_id;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values((resolution->>'id')::public.ulid,(actor->>'businessId')::public.ulid,(actor->>'outletId')::public.ulid,
      'member',(actor->>'memberId')::public.ulid,'kitchen.tap-close','null',(result->'closure')::json,at_ms);
  return result;
exception when unique_violation then raise sqlstate 'PT409' using message='Keep the original saved-tap review request.';
end $$;
revoke all on function private.recover_kitchen_tap(text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.recover_kitchen_tap(text,text,jsonb,jsonb) to service_role;
create function public.recover_kitchen_tap(p_device_token text,p_session_token text,p_original jsonb,p_resolution jsonb default null) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$begin
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]',true);
  return private.recover_kitchen_tap(p_device_token,p_session_token,p_original,p_resolution);end $$;
revoke all on function public.recover_kitchen_tap(text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.recover_kitchen_tap(text,text,jsonb,jsonb) to service_role;

-- Retired taps cannot acquire a new prepared ticket.
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
    and o.outlet_id=actor->>'outletId' and o.revision>=(request_action->>'revision')::bigint) then
    raise sqlstate 'PT409' using message='Refresh the original ticket.';end if;
  if request_action->>'type'='kitchen.ready' then
    select r.receipt into original_ack from private.kitchen_action_receipts r where r.id=request_action->>'parentAckId'
      and r.business_id=actor->>'businessId' and r.outlet_id=actor->>'outletId' and r.order_id=request_action->>'orderId'
      and r.action->>'type'='kitchen.acknowledge' and r.action->>'contentHash'=request_action->>'contentHash';
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
