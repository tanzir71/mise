-- A receipt remains historical proof after undo. Its preparation effect is
-- current only while none of its own status transitions was explicitly undone.
create index events_kitchen_undo_idx on public.events(business_id,outlet_id,order_id,undo_of) where command='order.status-undo';
create function private.kitchen_ack_active(business public.ulid,outlet public.ulid,order_id public.ulid,receipt jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
  select coalesce(receipt->>'type'='kitchen.acknowledge' and receipt->>'businessId'=business::text and receipt->>'outletId'=outlet::text
    and receipt->>'orderId'=order_id::text and jsonb_typeof(receipt->'transitionEventIds')='array' and not exists(
      select 1 from public.events e where e.business_id=business and e.outlet_id=outlet and e.order_id=kitchen_ack_active.order_id
        and e.command='order.status-undo' and (receipt->'transitionEventIds') ? e.undo_of::text),false);
$$;
revoke all on function private.kitchen_ack_active(public.ulid,public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;

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

create or replace function private.read_kitchen_acknowledgements(device_secret text,session_secret text,sources jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; results jsonb;
begin
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' then return null;end if;
  if jsonb_typeof(sources) is distinct from 'array' then raise invalid_parameter_value using message='Use complete original kitchen sources.';end if;
  if jsonb_array_length(sources)>100 or exists(select 1 from jsonb_array_elements(sources) s where
    jsonb_typeof(s) is distinct from 'object' or not s ?& array['orderId','contentHash','revision'] or s-array['orderId','contentHash','revision']<>'{}'::jsonb or
    jsonb_typeof(s->'orderId') is distinct from 'string' or s->>'orderId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or
    jsonb_typeof(s->'contentHash') is distinct from 'string' or s->>'contentHash'!~'^[0-9a-f]{64}$' or
    jsonb_typeof(s->'revision') is distinct from 'number' or (s->>'revision')::numeric not between 1 and 9007199254740991 or
    (s->>'revision')::numeric<>trunc((s->>'revision')::numeric)) or
    (select count(*)<>count(distinct s->>'orderId') from jsonb_array_elements(sources) s) then raise invalid_parameter_value using message='Use complete original kitchen sources.';end if;
  select coalesce(jsonb_agg(jsonb_build_object('orderId',s->>'orderId','contentHash',s->>'contentHash','receipt',r.receipt) order by s->>'orderId'),'[]'::jsonb)
    into results from jsonb_array_elements(sources) s left join lateral (
      select x.receipt from private.kitchen_action_receipts x where x.business_id=actor->>'businessId' and x.outlet_id=actor->>'outletId'
        and x.order_id=s->>'orderId' and x.action->>'type'='kitchen.acknowledge' and x.action->>'contentHash'=s->>'contentHash'
        and (x.receipt->>'revision')::bigint<=(s->>'revision')::bigint
        and private.kitchen_ack_active(x.business_id,x.outlet_id,x.order_id,x.receipt) order by x.accepted_at desc,x.id desc limit 1
    ) r on true;
  return jsonb_build_object('v',1,'access',actor,'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,'entries',results);
end $$;
