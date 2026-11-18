-- Complete reviewed closing and its optional walk-in receipt are one transaction.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
  'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch','supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo',
  'order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings','closing.record','closing.undo'));
create table private.closing_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('closing.record','closing.undo')),
 plan jsonb not null,occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.closing_write_tickets enable row level security;alter table private.closing_write_tickets force row level security;
revoke all on private.closing_write_tickets from public,anon,authenticated,service_role;
create index closing_write_tickets_actor_idx on private.closing_write_tickets(auth_user_id,expires_at);
create index closing_write_tickets_command_idx on private.closing_write_tickets(command_id);

-- Return literal JSON intact, never extracting a field from a summary/source body.
create function private.closing_write_context(business public.ulid,outlet public.ulid,actor public.ulid,kind text,plan jsonb) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object(
  'business',(select row_to_json(b) from public.businesses b where b.id=business),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'actorName',(select m.name::json from public.members m where m.business_id=business and m.id=actor),
  'closing',(select row_to_json(c) from public.day_closings c where c.business_id=business and c.outlet_id=outlet and c.id=plan->>'closingId'),
  'sale',(select row_to_json(s) from public.sales s where kind='closing.undo' and s.business_id=business and s.outlet_id=outlet and s.closing_id=plan->>'closingId' and s.id=plan->>'saleId'),
  'sales',(select coalesce(json_agg(row_to_json(s) order by s.id),'[]') from public.sales s where kind='closing.record' and s.business_id=business and s.outlet_id=outlet),
  'orders',(select coalesce(json_agg(row_to_json(o) order by o.id),'[]') from public.orders o where kind='closing.record' and o.business_id=business and o.outlet_id=outlet),
  'refunds',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]') from public.order_refunds r where kind='closing.record' and r.business_id=business and r.outlet_id=outlet),
  'accounts',(select coalesce(json_agg(row_to_json(a) order by a.id),'[]') from public.credit_accounts a where kind='closing.record' and a.business_id=business and a.outlet_id=outlet),
  'entries',(select coalesce(json_agg(row_to_json(e) order by e.account_id,e.sequence,e.id),'[]') from public.credit_entries e where kind='closing.record' and e.business_id=business and e.outlet_id=outlet),
  'customers',(select coalesce(json_agg(row_to_json(c) order by c.id),'[]') from public.customers c where kind='closing.record' and c.business_id=business
    and exists(select 1 from public.customer_outlets co where co.business_id=business and co.outlet_id=outlet and co.customer_id=c.id)),
  'stock',(select coalesce(json_agg(row_to_json(s) order by s.id),'[]') from public.stock_items s where kind='closing.record' and s.business_id=business and s.outlet_id=outlet),
  'closings',(select coalesce(json_agg(row_to_json(c) order by c.id),'[]') from public.day_closings c where kind='closing.record' and c.business_id=business and c.outlet_id=outlet)
 )
$$;
create function private.prepare_closing_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;o public.outlets;c public.day_closings;s public.sales;context json;secret text;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This closing is unavailable.';end if;
 if command_id is null or ticket_id is null or outlet is null or occurred is null or kind is null or kind not in ('closing.record','closing.undo')
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or jsonb_typeof(ids) is distinct from 'object' or octet_length(ids::text)>256000
  or (select count(*) from jsonb_object_keys(ids))<>13
  or exists(select 1 from jsonb_object_keys(ids) k where k not in ('closingId','saleId','saleEventId','day','currency','timezone','countedCash','expectedCash','addDifference','reviewJson','summaryJson','noteJson','intentJson'))
  or jsonb_typeof(ids->'intentJson') is distinct from 'string' or octet_length(ids->>'intentJson')>32000 or encode(sha256(convert_to(ids->>'intentJson','UTF8')),'hex')<>fingerprint
  or ids->>'closingId' is null or exists(select 1 from unnest(array['closingId','saleId','saleEventId']) k where ids->>k is not null and (jsonb_typeof(ids->k)<>'string' or (ids->>k)!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
  or ((ids->>'saleId' is null)<>(ids->>'saleEventId' is null)) or command_id::text in(ids->>'closingId',ids->>'saleId',ids->>'saleEventId')
  or ids->>'closingId' in(ids->>'saleId',ids->>'saleEventId') or ids->>'saleId'=ids->>'saleEventId' then raise invalid_parameter_value using message='Keep the exact closing intent and identities.';end if;
 if kind='closing.record' then
  if exists(select 1 from unnest(array['day','currency','timezone','reviewJson','summaryJson','noteJson']) k where jsonb_typeof(ids->k) is distinct from 'string')
   or (ids->>'day')!~'^\d{4}-\d{2}-\d{2}$' or (ids->>'currency')!~'^[A-Z]{3}$'
   or jsonb_typeof(ids->'addDifference') is distinct from 'boolean' or ((ids->>'addDifference')::boolean<>(ids->>'saleId' is not null))
   or exists(select 1 from unnest(array['countedCash','expectedCash']) k where jsonb_typeof(ids->k) is distinct from 'number' or (ids->>k)::numeric<>trunc((ids->>k)::numeric) or (ids->>k)::numeric not between -9007199254740991 and 9007199254740991)
   or (ids->>'countedCash')::numeric<0 or abs((ids->>'countedCash')::numeric-(ids->>'expectedCash')::numeric)>9007199254740991
   or (ids->>'addDifference')::boolean and (ids->>'countedCash')::numeric<=(ids->>'expectedCash')::numeric
   or not (ids->>'addDifference')::boolean and ids->>'summaryJson' is distinct from ids->>'reviewJson' then raise invalid_parameter_value using message='Check the complete closing review and difference.';end if;
 elsif exists(select 1 from unnest(array['day','currency','timezone','countedCash','expectedCash','addDifference','reviewJson','summaryJson','noteJson']) k where (ids->k) is distinct from 'null'::jsonb) then raise invalid_parameter_value using message='Keep the original closing for undo.';end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This closing is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original closing intent.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select x.business_id into business from public.outlets x where x.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform 1 from public.businesses b where b.id=business for share;
 select * into o from public.outlets x where x.business_id=business and x.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 if kind='closing.record' then
  if exists(select 1 from public.day_closings x where x.id=ids->>'closingId') then raise insufficient_privilege using message='This closing identity is unavailable.';end if;
  if o.currency is distinct from ids->>'currency' or o.timezone is distinct from ids->>'timezone' or (to_timestamp(occurred::double precision/1000) at time zone o.timezone)::date::text is distinct from ids->>'day' then raise sqlstate 'PT409' using message='Review the shop day, currency and timezone.';end if;
  if exists(select 1 from public.day_closings x where x.business_id=business and x.outlet_id=outlet and x.currency=o.currency and x.day=(ids->>'day')::date and x.voided_at is null) then raise sqlstate 'PT409' using message='This shop day is already closed.';end if;
  if exists(select 1 from public.sales x where x.id=ids->>'saleId') then raise unique_violation using message='This receipt identity is unavailable.';end if;
 else
  select * into c from public.day_closings x where x.business_id=business and x.outlet_id=outlet and x.id=ids->>'closingId' for update;
  if not found or c.added_sale_id::text is distinct from ids->>'saleId' then raise insufficient_privilege using message='This closing is unavailable.';end if;
  if c.voided_at is not null or at_ms<c.created_at or occurred<c.created_at or (to_timestamp(at_ms::double precision/1000) at time zone c.timezone)::date<>c.day or (to_timestamp(occurred::double precision/1000) at time zone c.timezone)::date<>c.day then raise sqlstate 'PT409' using message='A closing can be undone once on its original shop day.';end if;
 end if;
 delete from private.closing_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.closing_write_tickets t where t.command_id=prepare_closing_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>(ids-'intentJson'))) then raise unique_violation using message='Keep the original closing intent.';end if;
 delete from private.closing_write_tickets t where t.command_id=prepare_closing_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.closing_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.closing_write_context(business,outlet,actor,kind,ids);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.closing_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids-'intentJson',occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create function private.finish_closing_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.closing_write_tickets;c public.day_closings;s public.sales;saved public.day_closings;saved_sale public.sales;o public.outlets;
 r jsonb;v jsonb;allowed jsonb;table_name text;keys text;casts text;immutable text;unchanged boolean;at_ms public.utc_ms;has_sale boolean;delta numeric;metadata jsonb;
 specs jsonb:='{"day_closings":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","active_key","day","timezone","currency","summary","counted_cash","expected_cash","difference","added_walk_in","added_sale_id","note","preview_fingerprint","created_by_name","business_id"],"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.closing_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This closing preparation is unavailable.';end if;
 perform 1 from public.businesses b where b.id=t.business_id for share;
 select * into o from public.outlets x where x.business_id=t.business_id and x.id=t.outlet_id for update;
 select * into t from private.closing_write_tickets x where x.id=ticket_id for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This closing proof is unavailable.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 if t.snapshot_hash<>sha256(convert_to(private.closing_write_context(t.business_id,t.outlet_id,t.actor_id,t.type,t.plan)::text,'UTF8')) then raise sqlstate 'PT409' using message='The closing source changed.' ,detail='closing_snapshot_changed';end if;
 has_sale:=t.plan->>'saleId' is not null;
 select * into c from public.day_closings x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'closingId';
 select * into s from public.sales x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.closing_id=c.id and x.id=t.plan->>'saleId';
 if t.type='closing.undo' and (c.id is null or c.voided_at is not null or c.added_sale_id::text is distinct from t.plan->>'saleId' or at_ms<c.created_at or t.occurred_at<c.created_at
  or (to_timestamp(at_ms::double precision/1000) at time zone c.timezone)::date<>c.day or (to_timestamp(t.occurred_at::double precision/1000) at time zone c.timezone)::date<>c.day
  or has_sale and (s.id is null or s.voided_at is not null or s.method<>'cash' or s.currency<>c.currency or s.amount<>c.added_walk_in or s.order_id is not null or s.customer_id is not null)) then raise sqlstate 'PT409' using message='This closing or its original receipt cannot be undone.';end if;
 if records is null or jsonb_typeof(records)<>'array' or octet_length(records::text)>256000 or jsonb_array_length(records)<>(case when has_sale then 4 else 2 end)
  or records->0->>'table' is distinct from 'day_closings' or (select count(*) from jsonb_array_elements(records) x where x->>'table'='day_closings')<>1
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='sales')<>(case when has_sale then 1 else 0 end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='events')<>(case when has_sale then 2 else 1 end)
  or exists(select 1 from jsonb_array_elements(records) x group by x->>'table',x->'values'->>'id' having count(*)>1) then raise invalid_parameter_value using message='Keep the complete closing transaction.';end if;
 delta:=case when t.type='closing.record' then (t.plan->>'countedCash')::numeric-(t.plan->>'expectedCash')::numeric else c.difference end;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if jsonb_typeof(r) is distinct from 'object' or (select count(*) from jsonb_object_keys(r))<>2 or not r ? 'table' or not r ? 'values' or allowed is null or jsonb_typeof(v) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed) or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid closing fields or scope.';end if;
  if table_name='day_closings' then
   if v->>'id' is distinct from t.plan->>'closingId' or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(c.created_at,t.occurred_at)) then raise invalid_parameter_value using message='Invalid closing identity or clock.';end if;
   if t.type='closing.record' then
    if c.id is not null or v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.command_id::text or (v->>'created_at')::bigint is distinct from t.occurred_at
     or v->>'created_by_name' is distinct from (select m.name::text from public.members m where m.business_id=t.business_id and m.id=t.actor_id)
     or v->>'day' is distinct from t.plan->>'day' or v->>'currency' is distinct from o.currency or v->>'timezone' is distinct from o.timezone
     or v->>'active_key' is distinct from to_json(o.currency||':'||(t.plan->>'day'))::text or v->>'voided_at' is not null
     or (v->>'counted_cash')::numeric is distinct from (t.plan->>'countedCash')::numeric or (v->>'expected_cash')::numeric is distinct from (t.plan->>'expectedCash')::numeric
     or (v->>'difference')::numeric is distinct from delta or (v->>'added_walk_in')::numeric is distinct from (case when has_sale then delta else 0 end)
     or v->>'added_sale_id' is distinct from t.plan->>'saleId' or v->>'note' is distinct from t.plan->>'noteJson' or v->>'preview_fingerprint' is distinct from t.plan->>'reviewJson' or v->>'summary' is distinct from t.plan->>'summaryJson' then raise invalid_parameter_value using message='Keep the reviewed closing snapshot and count.';end if;
   elsif v->>'active_key' is not null or (v->>'voided_at')::bigint is distinct from t.occurred_at then raise invalid_parameter_value using message='Invalid closing undo.';end if;
  elsif table_name='sales' then
   if v->>'id' is distinct from t.plan->>'saleId' or v->>'closing_id' is distinct from t.plan->>'closingId' or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(s.created_at,t.occurred_at)) then raise invalid_parameter_value using message='Keep the linked closing receipt and clock.';end if;
   if t.type='closing.record' then
    if v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.plan->>'saleEventId' or (v->>'created_at')::bigint is distinct from t.occurred_at
     or v->>'voided_at' is not null or v->>'void_reason' is not null or v->>'method' is distinct from 'cash' or v->>'method_name' is distinct from '"Cash"' or v->>'who' is distinct from '"Walk-in"'
     or v->>'order_id' is not null or v->>'order_number' is not null or v->>'customer_id' is not null or v->>'credit_account_id' is not null or v->>'delivery_fee' is not null or v->>'discount' is not null
     or v->>'currency' is distinct from o.currency or v->>'timezone' is distinct from o.timezone or (v->>'amount')::numeric is distinct from delta or (v->>'given')::numeric is distinct from delta or (v->>'change')::numeric is distinct from 0
     or v->>'items' is distinct from '[]' or v->>'shop_name' is distinct from (select b.name::text from public.businesses b where b.id=t.business_id) then raise invalid_parameter_value using message='Keep the exact positive walk-in receipt.';end if;
   elsif (v->>'voided_at')::bigint is distinct from t.occurred_at or v->>'void_reason' is distinct from 'undo' then raise invalid_parameter_value using message='Invalid closing receipt undo.';end if;
  else
   if v->>'actor_type' is distinct from 'member' or v->>'actor_id' is distinct from t.actor_id::text or v->>'closing_id' is distinct from t.plan->>'closingId' or (v->>'at')::bigint is distinct from t.created_at
    or exists(select 1 from unnest(array['customer_id','order_id','order_revision','stock_item_id','stock_revision','supplier_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid closing audit identity or scope.';end if;
   if v->>'id'=t.command_id::text then
    if v->>'command' is distinct from t.type or v->>'undo_of' is distinct from (case when t.type='closing.undo' then c.event_id::text else null end) then raise invalid_parameter_value using message='Keep the closing audit and undo link.';end if;
   elsif not has_sale or v->>'id' is distinct from t.plan->>'saleEventId' or v->>'command' is distinct from (case when t.type='closing.record' then 'sale.record' else 'sale.closing-undo' end) or v->>'undo_of' is distinct from (case when t.type='closing.undo' then s.event_id::text else null end) then raise invalid_parameter_value using message='Keep the companion receipt audit.';end if;
  end if;
  if t.type='closing.undo' and table_name in ('day_closings','sales') then
   select string_agg(format('($1->>%L) is not distinct from source.%I::text',k,k),' and ') into immutable from jsonb_object_keys(v) k where k not in ('updated_at','voided_at',case when table_name='sales' then 'void_reason' else 'active_key' end);
   execute format('select %s from public.%I source where source.id=$2',immutable,table_name) into unchanged using v,(v->>'id')::public.ulid;
   if unchanged is distinct from true then raise invalid_parameter_value using message='Keep the complete original closing or receipt.';end if;
   if table_name='day_closings' then update public.day_closings x set active_key=null,voided_at=t.occurred_at,updated_at=(v->>'updated_at')::bigint where x.id=c.id;
   else update public.sales x set voided_at=t.occurred_at,void_reason='undo',updated_at=(v->>'updated_at')::bigint where x.id=s.id;end if;
  else
   select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key) into keys,casts
    from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
   execute format('insert into public.%I(%s) select %s',table_name,keys,casts) using v;
  end if;
 end loop;
 if not exists(select 1 from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=t.command_id::text) or has_sale and not exists(select 1 from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=t.plan->>'saleEventId') then raise invalid_parameter_value using message='Keep every closing audit.';end if;
 select * into saved from public.day_closings x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'closingId';
 select * into saved_sale from public.sales x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'saleId';
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'closingId',saved.id,'occurredAt',t.occurred_at,'at',t.created_at,'day',saved.day::text,'difference',saved.difference,'addedWalkIn',saved.added_walk_in,'closingUpdatedAt',saved.updated_at,'saleId',saved_sale.id,'saleUpdatedAt',saved_sale.updated_at,'undoOf',case when t.type='closing.undo' then saved.id else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.closing_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;
revoke all on function private.closing_write_context(public.ulid,public.ulid,public.ulid,text,jsonb),private.prepare_closing_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),private.finish_closing_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.prepare_closing_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_closing_write(public.ulid,text,jsonb) to service_role;
create function public.prepare_closing_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_closing_write(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_closing_write(p_ticket_id public.ulid,p_token text,p_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_closing_write(p_ticket_id,p_token,p_records)$$;
revoke all on function public.prepare_closing_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),public.finish_closing_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.prepare_closing_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_closing_write(public.ulid,text,jsonb) to service_role;
