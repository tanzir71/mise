-- Supplier and invoice writes share local validation, device IDs and atomic audits.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
  'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch',
  'supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo'));
create table private.purchase_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo')),
 plan jsonb not null,occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),
 created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.purchase_write_tickets enable row level security;alter table private.purchase_write_tickets force row level security;
revoke all on private.purchase_write_tickets from public,anon,authenticated,service_role;
create index purchase_write_tickets_actor_idx on private.purchase_write_tickets(auth_user_id,expires_at);
create index purchase_write_tickets_command_idx on private.purchase_write_tickets(command_id);

-- Keep raw JSON literal fields out of jsonb, including NUL and lone surrogates.
create function private.purchase_write_context(business public.ulid,outlet public.ulid,plan jsonb) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object(
 'business',(select row_to_json(b) from public.businesses b where b.id=business),
 'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
 'supplier',(select row_to_json(s) from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=plan->>'supplierId'),
 'purchase',(select row_to_json(p) from public.purchases p where p.business_id=business and p.outlet_id=outlet and p.id=plan->>'purchaseId'),
 'stock',(select coalesce(json_agg(row_to_json(s) order by s.id),'[]') from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.id in(select jsonb_array_elements_text(plan->'stockItemIds'))))
$$;
create function private.admit_purchase_record(outlet public.ulid) returns boolean language plpgsql security definer set search_path='' as $$
declare business public.ulid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 perform private.public_link_actor(business,outlet);return true;
end $$;
create function private.prepare_purchase_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;context json;secret text;at_ms public.utc_ms;is_supplier boolean;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This invoice action is unavailable.';end if;
 if command_id is null or ticket_id is null or outlet is null or occurred is null or kind is null or kind not in ('supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo')
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or jsonb_typeof(ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(ids))<>6
  or exists(select 1 from jsonb_object_keys(ids) k where k not in ('supplierId','purchaseId','revision','stockItemIds','lineFacts','linesJson'))
  or exists(select 1 from unnest(array['supplierId','purchaseId']) k where ids->>k is not null and (jsonb_typeof(ids->k)<>'string' or ids->>k!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
  or jsonb_typeof(ids->'stockItemIds') is distinct from 'array' or jsonb_array_length(ids->'stockItemIds')>200
  or exists(select 1 from jsonb_array_elements(ids->'stockItemIds') x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  or (select count(distinct x#>>'{}') from jsonb_array_elements(ids->'stockItemIds') x)<>jsonb_array_length(ids->'stockItemIds')
  or jsonb_typeof(ids->'lineFacts') is distinct from 'array' or jsonb_array_length(ids->'lineFacts')>200
  or kind='purchase.record' and (jsonb_array_length(ids->'lineFacts')<1 or jsonb_typeof(ids->'linesJson') is distinct from 'string' or octet_length(ids->>'linesJson')>1000000)
  or kind<>'purchase.record' and (jsonb_array_length(ids->'lineFacts')<>0 or ids->>'linesJson' is not null)
  or exists(select 1 from jsonb_array_elements(ids->'lineFacts') x where jsonb_typeof(x)<>'object' or (select count(*) from jsonb_object_keys(x))<>4 or exists(select 1 from jsonb_object_keys(x) k where k not in ('stockItemId','unitKey','qty','unitPrice'))
    or (x->>'stockItemId' is not null and (jsonb_typeof(x->'stockItemId')<>'string' or x->>'stockItemId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or not ids->'stockItemIds' ? (x->>'stockItemId')))
    or jsonb_typeof(x->'unitKey') is distinct from 'string' or octet_length(x->>'unitKey')>1000 or jsonb_typeof(x->'qty') is distinct from 'number' or jsonb_typeof(x->'unitPrice') is distinct from 'number'
    or (x->>'qty')::numeric not between 0.001 and 999999 or (x->>'qty')::numeric*1000<>trunc((x->>'qty')::numeric*1000) or (x->>'unitPrice')::numeric not between 0 and 9007199254740991 or (x->>'unitPrice')::numeric<>trunc((x->>'unitPrice')::numeric))
  or exists(select 1 from jsonb_array_elements_text(ids->'stockItemIds') x where not exists(select 1 from jsonb_array_elements(ids->'lineFacts') l where l->>'stockItemId'=x)) then raise invalid_parameter_value using message='Check the invoice intent.';end if;
 is_supplier:=kind like 'supplier.%';
 if (is_supplier and (ids->>'supplierId' is null or ids->>'purchaseId' is not null or jsonb_array_length(ids->'stockItemIds')<>0 or jsonb_typeof(ids->'revision') is distinct from 'number'
      or (ids->>'revision')::numeric<>trunc((ids->>'revision')::numeric) or (ids->>'revision')::numeric not between (case when kind='supplier.create' then 0 else 1 end) and 9007199254740990
      or kind='supplier.create' and (ids->>'revision')::numeric<>0))
  or (not is_supplier and (ids->>'purchaseId' is null or ids->>'revision' is not null))
  or (kind='purchase.undo' and (ids->>'supplierId' is not null or jsonb_array_length(ids->'stockItemIds')<>0))
  or command_id::text in(ids->>'supplierId',ids->>'purchaseId') or ids->'stockItemIds' ? command_id::text or ids->'stockItemIds' ? (ids->>'purchaseId')
  or kind='purchase.record' and ids->>'supplierId'=ids->>'purchaseId' then raise invalid_parameter_value using message='Keep the reviewed supplier and invoice IDs.';end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.shop_command_receipts c where c.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This change is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='This command ID was already used.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);
 perform 1 from public.businesses b where b.id=business for share;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 if exists(select 1 from public.events e where e.id=command_id) then raise unique_violation using message='This command ID was already used.';end if;
 if kind='supplier.create' then
  if exists(select 1 from public.suppliers s where s.id=ids->>'supplierId') then raise unique_violation using message='This supplier ID already exists.';end if;
 elsif ids->>'supplierId' is not null and not exists(select 1 from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=ids->>'supplierId') then raise insufficient_privilege using message='This supplier is unavailable.';end if;
 if kind='purchase.record' then
  if exists(select 1 from public.purchases p where p.id=ids->>'purchaseId') then raise unique_violation using message='This invoice ID already exists.';end if;
 elsif kind='purchase.undo' and not exists(select 1 from public.purchases p where p.business_id=business and p.outlet_id=outlet and p.id=ids->>'purchaseId') then raise insufficient_privilege using message='This invoice is unavailable.';end if;
 if (select count(*) from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.id in(select jsonb_array_elements_text(ids->'stockItemIds')))<>jsonb_array_length(ids->'stockItemIds') then raise insufficient_privilege using message='This stock is unavailable.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 delete from private.purchase_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.purchase_write_tickets t where t.command_id=prepare_purchase_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>ids)) then raise unique_violation using message='Keep the original invoice intent.';end if;
 delete from private.purchase_write_tickets t where t.command_id=prepare_purchase_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.purchase_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.purchase_write_context(business,outlet,ids);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.purchase_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids,occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create function private.finish_purchase_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.purchase_write_tickets;r jsonb;v jsonb;table_name text;allowed jsonb;keys text;casts text;updates text;at_ms public.utc_ms;metadata jsonb;
 before_supplier public.suppliers;before_purchase public.purchases;saved_supplier public.suppliers;saved_purchase public.purchases;outlet_row public.outlets;
 is_supplier boolean;expected_supplier text;expected_total numeric;l jsonb;qty numeric;price numeric;line_total numeric;
 specs jsonb:='{"suppliers":["id","created_at","updated_at","outlet_id","revision","name","phone","note","archived_at","event_id","business_id"],"purchases":["id","created_at","updated_at","outlet_id","created_by","event_id","supplier_id","supplier_name","reference","lines","total","currency","timezone","paid","method_name","note","photo_ref","voided_at","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare this invoice change again.';end if;
 select * into t from private.purchase_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Prepare this invoice change again.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for share;
 select * into outlet_row from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 select * into t from private.purchase_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Prepare this invoice change again.';end if;
 if sha256(convert_to(private.purchase_write_context(t.business_id,t.outlet_id,t.plan)::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The invoice source changed. Prepare again.',detail='purchase_snapshot_changed';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
 is_supplier:=t.type like 'supplier.%';
 select * into before_supplier from public.suppliers s where s.business_id=t.business_id and s.outlet_id=t.outlet_id and s.id=t.plan->>'supplierId';
 select * into before_purchase from public.purchases p where p.business_id=t.business_id and p.outlet_id=t.outlet_id and p.id=t.plan->>'purchaseId';
 if is_supplier and t.type<>'supplier.create' and (before_supplier.id is null or before_supplier.revision<>(t.plan->>'revision')::bigint) then raise sqlstate 'PT409' using message='Review the latest supplier revision.';end if;
 if t.type='purchase.undo' and (before_purchase.id is null or before_purchase.voided_at is not null or at_ms<before_purchase.created_at or at_ms-before_purchase.created_at>600000 or t.occurred_at<before_purchase.created_at) then raise sqlstate 'PT409' using message='Undo the original invoice once within ten minutes.';end if;
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records)<>2 or octet_length(records::text)>4000000
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'=case when is_supplier then 'suppliers' else 'purchases' end)<>1
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='events')<>1 then raise invalid_parameter_value using message='Invalid invoice mutation shape.';end if;
 expected_supplier:=case when is_supplier then t.plan->>'supplierId' when t.type='purchase.record' then t.plan->>'supplierId' else before_purchase.supplier_id::text end;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if allowed is null or jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed)
   or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k) or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid invoice record fields.';end if;
  if table_name='suppliers' then
   if not is_supplier or v->>'id' is distinct from t.plan->>'supplierId' or v->>'event_id' is distinct from t.command_id::text or (v->>'revision')::bigint is distinct from coalesce(before_supplier.revision,0)+1
    or (v->>'created_at')::bigint is distinct from coalesce(before_supplier.created_at,t.occurred_at) or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(before_supplier.created_at,t.occurred_at))
    or (v->>'archived_at')::bigint is distinct from (case when t.type='supplier.archive' then t.occurred_at when t.type='supplier.restore' then null else before_supplier.archived_at end)
    or t.type='supplier.archive' and before_supplier.archived_at is not null or t.type='supplier.restore' and before_supplier.archived_at is null
    or t.type in ('supplier.archive','supplier.restore') and (v->>'name' is distinct from before_supplier.name::text or v->>'phone' is distinct from before_supplier.phone or v->>'note' is distinct from before_supplier.note::text) then raise invalid_parameter_value using message='Invalid supplier mutation.';end if;
  elsif table_name='purchases' then
   if is_supplier or v->>'id' is distinct from t.plan->>'purchaseId' or v->>'supplier_id' is distinct from expected_supplier
    or (v->>'created_at')::bigint is distinct from coalesce(before_purchase.created_at,t.occurred_at) or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(before_purchase.created_at,t.occurred_at)) then raise invalid_parameter_value using message='Invalid invoice identity or clock.';end if;
   if t.type='purchase.record' then
    if before_purchase.id is not null or v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.command_id::text or v->>'voided_at' is not null or v->>'photo_ref' is not null
     or v->>'currency' is distinct from outlet_row.currency or v->>'timezone' is distinct from outlet_row.timezone or v->>'paid' not in ('cash','wallet','card','due')
     or expected_supplier is not null and (before_supplier.archived_at is not null or v->>'supplier_name' is distinct from before_supplier.name::text)
     or v->>'paid'<>'wallet' and v->>'method_name' is distinct from to_json(case v->>'paid' when 'cash' then 'Cash' when 'card' then 'Card' else 'Due' end)::text
     or v->>'lines' is distinct from t.plan->>'linesJson' then raise invalid_parameter_value using message='Invalid priced invoice.';end if;
    expected_total:=0;
    for l in select x from jsonb_array_elements(t.plan->'lineFacts') x loop
     qty:=(l->>'qty')::numeric;price:=(l->>'unitPrice')::numeric;line_total:=floor(price*qty+0.5);
     if qty is null or qty<=0 or qty>999999 or qty*1000<>trunc(qty*1000) or price is null or price<0 or price>9007199254740991 or price<>trunc(price)
      or line_total>9007199254740991 then raise invalid_parameter_value using message='Invalid invoice amount.';end if;
     expected_total:=expected_total+line_total;
     if l->>'stockItemId' is not null and (not t.plan->'stockItemIds' ? (l->>'stockItemId') or not exists(select 1 from public.stock_items s where s.business_id=t.business_id and s.outlet_id=t.outlet_id and s.id=l->>'stockItemId' and s.archived_at is null and s.unit::text=l->>'unitKey')) then raise invalid_parameter_value using message='Keep the reviewed stock and invoice unit.';end if;
    end loop;
    if expected_total>9007199254740991 or (v->>'total')::numeric is distinct from expected_total then raise invalid_parameter_value using message='Invalid invoice total or stock plan.';end if;
   else
    if (v->>'voided_at')::bigint is distinct from t.occurred_at or v->>'created_by' is distinct from before_purchase.created_by::text or v->>'event_id' is distinct from before_purchase.event_id::text
     or v->>'supplier_name' is distinct from before_purchase.supplier_name::text or v->>'reference' is distinct from before_purchase.reference::text or v->>'lines' is distinct from before_purchase.lines::text
     or (v->>'total')::bigint is distinct from before_purchase.total or v->>'currency' is distinct from before_purchase.currency or v->>'timezone' is distinct from before_purchase.timezone
     or v->>'paid' is distinct from before_purchase.paid or v->>'method_name' is distinct from before_purchase.method_name::text or v->>'note' is distinct from before_purchase.note::text or v->>'photo_ref' is distinct from before_purchase.photo_ref then raise invalid_parameter_value using message='Keep the original invoice when undoing.';end if;
   end if;
  else
   if v->>'id' is distinct from t.command_id::text or v->>'actor_type'<>'member' or v->>'actor_id' is distinct from t.actor_id::text or v->>'command' is distinct from t.type or (v->>'at')::bigint is distinct from t.created_at
    or v->>'supplier_id' is distinct from expected_supplier or v->>'undo_of' is distinct from (case when t.type='purchase.undo' then before_purchase.event_id::text else null end)
    or exists(select 1 from unnest(array['customer_id','order_id','order_revision','stock_item_id','stock_revision','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid supplier/invoice audit.';end if;
  end if;
  select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key),
   string_agg(format('%I=excluded.%I',a.key,a.key),',' order by a.key) filter(where a.key not in ('id','business_id','outlet_id','created_at')) into keys,casts,updates
   from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
  execute format('insert into public.%I(%s) select %s%s',table_name,keys,casts,case when table_name='events' or t.type in ('supplier.create','purchase.record') then '' else ' on conflict(id) do update set '||updates end) using v;
 end loop;
 select * into saved_supplier from public.suppliers s where s.business_id=t.business_id and s.outlet_id=t.outlet_id and s.id=t.plan->>'supplierId';
 select * into saved_purchase from public.purchases p where p.business_id=t.business_id and p.outlet_id=t.outlet_id and p.id=t.plan->>'purchaseId';
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'at',t.created_at,'supplierId',expected_supplier,
  'purchaseId',case when is_supplier then null else saved_purchase.id::text end,'revision',case when is_supplier then saved_supplier.revision else null end,'total',case when is_supplier then null else saved_purchase.total end,
  'updatedAt',case when is_supplier then saved_supplier.updated_at else saved_purchase.updated_at end,'voidedAt',case when is_supplier then null else saved_purchase.voided_at end,'undoOf',case when t.type='purchase.undo' then saved_purchase.id::text else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.purchase_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;
revoke all on function private.purchase_write_context(public.ulid,public.ulid,jsonb),private.admit_purchase_record(public.ulid),
 private.prepare_purchase_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),private.finish_purchase_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.admit_purchase_record(public.ulid),private.prepare_purchase_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_purchase_write(public.ulid,text,jsonb) to service_role;
create function public.admit_purchase_record(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_purchase_record(p_outlet_id)$$;
create function public.prepare_purchase_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_purchase_write(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_purchase_write(p_ticket_id public.ulid,p_token text,p_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_purchase_write(p_ticket_id,p_token,p_records)$$;
revoke all on function public.admit_purchase_record(public.ulid),public.prepare_purchase_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),public.finish_purchase_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admit_purchase_record(public.ulid),public.prepare_purchase_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_purchase_write(public.ulid,text,jsonb) to service_role;
