-- Team choices are outlet-scoped. Legacy members without a Team profile keep
-- their existing work permissions. An explicit legacy action denial still wins.
create or replace function private.device_staff_permissions(d private.devices,m public.members) returns text[]
language plpgsql stable security invoker set search_path='' as $$
declare result text[]:='{}'; profile jsonb; permission text;
begin
 if not m.active or m.business_id<>d.business_id then return result;end if;
 select s.profile into profile from private.staff_profiles s
  where s.business_id=m.business_id and s.outlet_id=d.outlet_id and s.member_id=m.id;
 if m.role='staff' or m.role='kitchen' and d.mode='kitchen' then
  result:=private.device_permissions(d.mode,m.role,m.permissions);
  if profile is not null then
   -- This switch authorizes preparation only: no commercial confirmation,
   -- money, stock, performance or owner/manager authority is introduced.
   result:=array_remove(array_remove(result,'orders.acknowledge'),'orders.ready');
   if profile#>'{permissions,confirmOrders}'='true'::jsonb then
    foreach permission in array array['orders.read','orders.acknowledge','orders.ready'] loop
     if not m.permissions ? permission or m.permissions->permission='true'::jsonb then
      result:=array_append(result,permission);
     end if;
    end loop;
   end if;
   if not result @> array['orders.read'] then
    result:=array_remove(array_remove(result,'orders.acknowledge'),'orders.ready');
   end if;
  end if;
 end if;
 if m.role in('staff','kitchen','rider') and profile->'methods' ? 'order_phone' then
  result:=array_append(result,'staff.check-in');
 end if;
 return coalesce((select array_agg(distinct p order by p) from unnest(result) p),'{}');
end $$;
revoke all on function private.device_staff_permissions(private.devices,public.members) from public,anon,authenticated,service_role;

-- Own original inspection/closure survives loss of preparation rights. This
-- closes only an exact saved tap; it cannot acknowledge or change an order.
create or replace function private.recover_kitchen_tap(device_secret text,session_secret text,original jsonb,resolution jsonb) returns jsonb
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
  if actor is null or (not actor->'permissions' ? 'orders.read' and actor->>'memberId' is distinct from original->>'memberId') or actor->>'outletId' is distinct from requested->>'outletId' then return null;end if;
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
  if actor is null or (not actor->'permissions' ? 'orders.read' and actor->>'memberId' is distinct from original->>'memberId') or actor->>'outletId' is distinct from requested->>'outletId' or
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
  if original_session.member_id::text is distinct from actor->>'memberId' and not actor->'permissions' ? (case when requested->>'type'='kitchen.acknowledge' then 'orders.acknowledge' else 'orders.ready' end) then return null;end if;
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
