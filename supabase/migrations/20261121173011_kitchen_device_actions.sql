-- Shared-screen preparation uses its own device/session authority. It never
-- borrows an owner's Auth identity or accepts a proposed commercial order.
create or replace function private.device_permissions(mode text,member_role text,permissions jsonb) returns text[]
language sql immutable security invoker set search_path='' as $$
  select coalesce(array_agg(k order by k),'{}'::text[]) from unnest(case when mode='kitchen' then
    array['orders.read','orders.acknowledge','orders.ready'] else
    array['counter.sell','orders.read','orders.create','orders.price','orders.acknowledge','orders.ready','khata.read','khata.collect'] end) k
  where case when permissions ? k then permissions->k='true'::jsonb else mode='kitchen' and member_role='kitchen' end
$$;

create table private.kitchen_action_tickets (
  id public.ulid primary key, action jsonb not null check(jsonb_typeof(action)='object'),
  business_id public.ulid not null, outlet_id public.ulid not null,
  device_id public.ulid not null references private.devices(id),
  session_id public.ulid not null references private.device_sessions(id), member_id public.ulid not null,
  token_hash bytea not null unique check(octet_length(token_hash)=32), snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),
  created_at public.utc_ms not null, expires_at public.utc_ms not null check(expires_at=created_at+60000),
  foreign key(business_id,outlet_id) references public.outlets(business_id,id),
  foreign key(business_id,member_id) references public.members(business_id,id)
);
create table private.kitchen_action_receipts (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  order_id public.ulid not null references public.orders(id), device_id public.ulid not null references private.devices(id),
  session_id public.ulid not null references private.device_sessions(id), member_id public.ulid not null,
  action jsonb not null check(jsonb_typeof(action)='object'), receipt jsonb not null check(jsonb_typeof(receipt)='object'),
  accepted_at public.utc_ms not null,
  foreign key(business_id,outlet_id) references public.outlets(business_id,id),
  foreign key(business_id,member_id) references public.members(business_id,id)
);
alter table private.kitchen_action_tickets enable row level security;
alter table private.kitchen_action_tickets force row level security;
alter table private.kitchen_action_receipts enable row level security;
alter table private.kitchen_action_receipts force row level security;
revoke all on private.kitchen_action_tickets,private.kitchen_action_receipts from public,anon,authenticated,service_role;
create index kitchen_ticket_device_expiry_idx on private.kitchen_action_tickets(device_id,expires_at);
create index kitchen_ticket_outlet_idx on private.kitchen_action_tickets(business_id,outlet_id);
create index kitchen_ticket_member_idx on private.kitchen_action_tickets(business_id,member_id);
create index kitchen_ticket_session_idx on private.kitchen_action_tickets(session_id);
create index kitchen_receipt_order_idx on private.kitchen_action_receipts(business_id,outlet_id,order_id,accepted_at,id);
create index kitchen_receipt_device_idx on private.kitchen_action_receipts(device_id);
create index kitchen_receipt_session_idx on private.kitchen_action_receipts(session_id);
create index kitchen_receipt_member_idx on private.kitchen_action_receipts(business_id,member_id);

create function private.kitchen_action_valid(action jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare identities text[];
begin
  if jsonb_typeof(action) is distinct from 'object' or
    not action ?& array['v','id','type','outletId','orderId','revision','contentHash','occurredAt','parentAckId','transitionEventIds'] or
    action-array['v','id','type','outletId','orderId','revision','contentHash','occurredAt','parentAckId','transitionEventIds']<>'{}'::jsonb or
    action->'v' is distinct from '1'::jsonb or jsonb_typeof(action->'type') is distinct from 'string' or action->>'type' not in ('kitchen.acknowledge','kitchen.ready') or
    jsonb_typeof(action->'id') is distinct from 'string' or jsonb_typeof(action->'orderId') is distinct from 'string' or jsonb_typeof(action->'outletId') is distinct from 'string' or
    jsonb_typeof(action->'revision') is distinct from 'number' or (action->>'revision')::numeric not between 1 and 9007199254740990 or
    (action->>'revision')::numeric<>trunc((action->>'revision')::numeric) or
    jsonb_typeof(action->'occurredAt') is distinct from 'number' or (action->>'occurredAt')::numeric not between 0 and 8640000000000000 or
    (action->>'occurredAt')::numeric<>trunc((action->>'occurredAt')::numeric) or
    jsonb_typeof(action->'contentHash') is distinct from 'string' or action->>'contentHash'!~'^[0-9a-f]{64}$' or
    jsonb_typeof(action->'transitionEventIds') is distinct from 'array' then return false;end if;
  if jsonb_array_length(action->'transitionEventIds')<>3 or exists(select 1 from jsonb_array_elements(action->'transitionEventIds') x where jsonb_typeof(x)<>'string') or
    action->>'type'='kitchen.acknowledge' and action->'parentAckId'<>'null'::jsonb or
    action->>'type'='kitchen.ready' and jsonb_typeof(action->'parentAckId') is distinct from 'string' then return false;end if;
  identities:=array[action->>'id',action->>'outletId',action->>'orderId']||array(select jsonb_array_elements_text(action->'transitionEventIds'));
  if action->>'type'='kitchen.ready' then identities:=array_append(identities,action->>'parentAckId');end if;
  return not exists(select 1 from unnest(identities) x where x is null or x!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    and cardinality(identities)=(select count(distinct x) from unnest(identities) x);
exception when others then return false;
end $$;

-- Literal JSON is kept as json throughout; NUL/surrogates in an unrelated
-- customer, message, table or line never pass through a jsonb conversion.
create function private.kitchen_action_context(business public.ulid,outlet public.ulid,order_id public.ulid) returns json
language sql stable security invoker set search_path='' as $$
  select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=business),
    'outlet',(select row_to_json(s) from public.outlets s where s.business_id=business and s.id=outlet),
    'order',(select row_to_json(o) from public.orders o where o.business_id=business and o.outlet_id=outlet and o.id=order_id))
$$;

create function private.kitchen_order_image(o public.orders) returns json
language sql immutable security invoker set search_path='' as $$
  with image as (select json_build_object(
    'id',o.id,'outletId',o.outlet_id,'businessType',o.business_type,'sequence',o.sequence,'number',o.number,'revision',o.revision,
    'source',o.source,'sourceText',o.source_text,'customer',case
      when o.customer_id is null and o.customer_phone is null then json_build_object('name',o.customer_name)
      when o.customer_id is null then json_build_object('name',o.customer_name,'phone',o.customer_phone)
      when o.customer_phone is null then json_build_object('id',o.customer_id,'name',o.customer_name)
      else json_build_object('id',o.customer_id,'name',o.customer_name,'phone',o.customer_phone) end,
    'type',o.type,'status',o.status,'statusChangedAt',o.status_changed_at,'statusEventId',o.status_event_id,'lines',o.lines,
    'subtotal',o.subtotal,'deliveryFee',o.delivery_fee,'discount',o.discount,'total',o.total,'currency',o.currency,'timezone',o.timezone,
    'address',o.address,'table',o.table_label,'payment',o.payment,'handledBy',o.handled_by,
    'createdBy',o.created_by,'eventId',o.event_id,'createdAt',o.created_at,'updatedAt',o.updated_at) as value)
  select case when o.scheduled_for is null then value else
    (left(value::text,length(value::text)-1)||',"scheduledFor":'||o.scheduled_for::text||'}')::json end from image
$$;

create function private.kitchen_order_priced(o public.orders) returns boolean
language sql immutable security invoker set search_path='' as $$
  -- Canonical order saves set total to null for an unpriced line, unresolved
  -- swap or no available lines. The trusted replay independently recalculates
  -- that invariant from the complete raw lines before this ticket can finish.
  -- Extracting even a numeric JSON field can decode unrelated NUL/surrogates.
  select o.total is not null
$$;

create function private.prepare_kitchen_action(device_secret text,session_secret text,ticket_id public.ulid,request_action jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; old private.kitchen_action_receipts; context json; original_ack jsonb; secret text; at_ms public.utc_ms;
begin
  if ticket_id is null or not private.kitchen_action_valid(request_action) then raise invalid_parameter_value using message='Keep the original kitchen tap.';end if;
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' or not actor->'permissions' ?
    (case when request_action->>'type'='kitchen.acknowledge' then 'orders.acknowledge' else 'orders.ready' end) then return null;end if;
  if actor->>'outletId' is distinct from request_action->>'outletId' then return null;end if;
  perform pg_advisory_xact_lock(hashtextextended(request_action->>'id',0));
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

create function private.finish_kitchen_action(device_secret text,session_secret text,ticket_id public.ulid,secret text,steps jsonb,receipt jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.kitchen_action_tickets; actor jsonb; o public.orders; before_image json; expected_steps jsonb:='[]';
  expected_receipt jsonb; stages text[]; path text[]:='{}'; stage_index integer; status_value text; transition_id public.ulid;
  change_at public.utc_ms; at_ms public.utc_ms; idx integer:=0; used_ids jsonb:='[]';
begin
  if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare the original tap again.';end if;
  select * into t from private.kitchen_action_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
  if not found then raise sqlstate 'PT409' using message='Prepare the original tap again.';end if;
  perform pg_advisory_xact_lock(hashtextextended(t.action->>'id',0));
  perform 1 from public.businesses b where b.id=t.business_id for share;
  perform 1 from public.outlets s where s.business_id=t.business_id and s.id=t.outlet_id for update;
  select * into t from private.kitchen_action_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Prepare the original tap again.';end if;
  -- Hold all mutable device/PIN/member assignments through the final write.
  perform 1 from private.devices d where d.id=t.device_id for share;
  perform 1 from private.device_sessions s where s.id=t.session_id for share;
  perform 1 from public.members m where m.business_id=t.business_id and m.id=t.member_id for share;
  perform 1 from private.staff_pins p where p.business_id=t.business_id and p.member_id=t.member_id for share;
  perform 1 from public.member_outlets m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.member_id=t.member_id for share;
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or actor->>'deviceId' is distinct from t.device_id::text or actor->>'sessionId' is distinct from t.session_id::text
    or actor->>'memberId' is distinct from t.member_id::text or actor->>'businessId' is distinct from t.business_id::text or actor->>'outletId' is distinct from t.outlet_id::text
    or not actor->'permissions' ? 'orders.read' or not actor->'permissions' ?
      (case when t.action->>'type'='kitchen.acknowledge' then 'orders.acknowledge' else 'orders.ready' end) then return null;end if;
  if exists(select 1 from private.kitchen_action_receipts r where r.id=t.action->>'id') then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
  if sha256(convert_to(private.kitchen_action_context(t.business_id,t.outlet_id,(t.action->>'orderId')::public.ulid)::text,'UTF8'))<>t.snapshot_hash then
    raise sqlstate 'PT409' using message='Refresh the ticket and retry the original tap.';end if;
  select * into o from public.orders x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.action->>'orderId' for update;
  if not found then raise sqlstate 'PT409' using message='Refresh the original ticket.';end if;
  if t.action->>'type'='kitchen.acknowledge' then
    if private.kitchen_order_priced(o) then
      path:=case when o.business_type='restaurant' and o.status='confirmed' then array['kitchen_seen']
        when o.business_type='food_stall' and o.status='ordered' then array['making']
        when o.business_type='corner_shop' and o.status='accepted' then array['packing'] else '{}'::text[] end;
    end if;
  else
    if not exists(select 1 from private.kitchen_action_receipts r where r.id=t.action->>'parentAckId' and r.business_id=t.business_id
      and r.outlet_id=t.outlet_id and r.order_id=o.id and r.action->>'type'='kitchen.acknowledge' and r.action->>'contentHash'=t.action->>'contentHash') then
      raise sqlstate 'PT409' using message='Keep the actual Got it receipt before Ready.';end if;
    stages:=case o.business_type when 'restaurant' then array['confirmed','kitchen_seen','cooking','ready']
      when 'online_shop' then array['confirmed','packed'] when 'food_stall' then array['ordered','making','ready_called']
      when 'corner_shop' then array['accepted','packing','ready'] end;
    stage_index:=array_position(stages,o.status);
    if stage_index is null or not private.kitchen_order_priced(o) then raise sqlstate 'PT409' using message='Confirm and price this order before Ready.';end if;
    path:=stages[stage_index+1:cardinality(stages)];
  end if;
  foreach status_value in array path loop
    transition_id:=(t.action->'transitionEventIds'->>idx)::public.ulid; idx:=idx+1;
    expected_steps:=expected_steps||jsonb_build_array(jsonb_build_object('id',transition_id,'status',status_value));
    used_ids:=used_ids||to_jsonb(transition_id);
  end loop;
  if steps is distinct from expected_steps or o.revision+cardinality(path)>=9007199254740991 then
    raise invalid_parameter_value using message='Keep the planned preparation steps.';end if;
  idx:=0;
  foreach status_value in array path loop
    transition_id:=(t.action->'transitionEventIds'->>idx)::public.ulid; idx:=idx+1;
    before_image:=private.kitchen_order_image(o);
    change_at:=greatest(t.created_at,o.created_at,o.updated_at,o.status_changed_at);
    update public.orders x set status=status_value,status_changed_at=change_at,status_event_id=transition_id,event_id=transition_id,
      revision=x.revision+1,updated_at=change_at where x.id=o.id returning x.* into o;
    insert into public.events(id,business_id,outlet_id,order_id,order_revision,actor_type,actor_id,command,before_data,after_data,at)
      values(transition_id,t.business_id,t.outlet_id,o.id,o.revision,'member',t.member_id,'order.status',before_image,private.kitchen_order_image(o),t.created_at);
  end loop;
  expected_receipt:=jsonb_build_object('v',1,'id',t.action->>'id','type',t.action->>'type','businessId',t.business_id,'outletId',t.outlet_id,
    'orderId',o.id,'deviceId',t.device_id,'sessionId',t.session_id,'memberId',t.member_id,'sourceRevision',t.action->'revision','revision',o.revision,
    'contentHash',t.action->>'contentHash','parentAckId',t.action->'parentAckId','occurredAt',t.action->'occurredAt','acceptedAt',t.created_at,
    'status',o.status,'transitionEventIds',used_ids);
  if receipt is distinct from expected_receipt then raise invalid_parameter_value using message='Keep the exact preparation receipt.';end if;
  insert into public.events(id,business_id,outlet_id,order_id,order_revision,actor_type,actor_id,command,before_data,after_data,at)
    values((t.action->>'id')::public.ulid,t.business_id,t.outlet_id,o.id,o.revision,'member',t.member_id,t.action->>'type','null',expected_receipt::json,t.created_at);
  insert into private.kitchen_action_receipts values((t.action->>'id')::public.ulid,t.business_id,t.outlet_id,o.id,t.device_id,t.session_id,t.member_id,t.action,expected_receipt,t.created_at);
  delete from private.kitchen_action_tickets x where x.id=t.id;
  return expected_receipt;
end $$;

revoke all on function private.kitchen_action_valid(jsonb),private.kitchen_action_context(public.ulid,public.ulid,public.ulid),
  private.kitchen_order_image(public.orders),private.kitchen_order_priced(public.orders),
  private.prepare_kitchen_action(text,text,public.ulid,jsonb),private.finish_kitchen_action(text,text,public.ulid,text,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function private.prepare_kitchen_action(text,text,public.ulid,jsonb),
  private.finish_kitchen_action(text,text,public.ulid,text,jsonb,jsonb) to service_role;

create function public.prepare_kitchen_action(p_device_token text,p_session_token text,p_ticket_id public.ulid,p_action jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]',true);
  return private.prepare_kitchen_action(p_device_token,p_session_token,p_ticket_id,p_action);
end $$;
create function public.finish_kitchen_action(p_device_token text,p_session_token text,p_ticket_id public.ulid,p_token text,p_steps jsonb,p_receipt jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]',true);
  return private.finish_kitchen_action(p_device_token,p_session_token,p_ticket_id,p_token,p_steps,p_receipt);
end $$;
revoke all on function public.prepare_kitchen_action(text,text,public.ulid,jsonb),public.finish_kitchen_action(text,text,public.ulid,text,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.prepare_kitchen_action(text,text,public.ulid,jsonb),public.finish_kitchen_action(text,text,public.ulid,text,jsonb,jsonb) to service_role;
