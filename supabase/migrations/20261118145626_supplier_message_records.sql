-- Original legacy Sent assertions remain distinct from modern hand-off attempts.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
 'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch','supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo',
 'order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings','closing.record','closing.undo',
 'handoff.prepare','handoff.change','supplier-message.undo','inbox.capture','inbox.change','khata.wording','export.prepare','setup.update','shopLink.generate','shopLink.undo','supplier-message.record'));
create table private.supplier_message_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 plan jsonb not null check(jsonb_typeof(plan)='object'),occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.supplier_message_write_tickets enable row level security;alter table private.supplier_message_write_tickets force row level security;
revoke all on private.supplier_message_write_tickets from public,anon,authenticated,service_role;
create index supplier_message_write_tickets_actor_idx on private.supplier_message_write_tickets(auth_user_id,expires_at);
create index supplier_message_write_tickets_command_idx on private.supplier_message_write_tickets(command_id);

-- Assemble canonical JS text from isolated literal tokens: names/text may contain
-- NUL or lone UTF-16 surrogates, which must never be deescaped into jsonb/text.
create function private.supplier_message_intent(command_id public.ulid,outlet public.ulid,occurred public.utc_ms,plan jsonb,fingerprint text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare stats integer[];input_text text;canonical text;stock_ids text;
begin
 if command_id is null or outlet is null or command_id=outlet or occurred is null or occurred>253402300799999
  or jsonb_typeof(plan) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(plan) k) is distinct from array['channel','intentJson','messageId','part','parts','phone','stockItemIds','supplierId','supplierNameJson','textJson']
  or jsonb_typeof(plan->'intentJson') is distinct from 'string' or octet_length(plan::text)>768000 or octet_length(plan->>'intentJson')>256000
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or encode(sha256(convert_to(plan->>'intentJson','UTF8')),'hex')<>fingerprint
  or jsonb_typeof(plan->'messageId') is distinct from 'string' or plan->>'messageId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or plan->>'messageId' in(command_id::text,outlet::text)
  or plan->'supplierId'<>'null'::jsonb and (jsonb_typeof(plan->'supplierId')<>'string' or plan->>'supplierId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  or jsonb_typeof(plan->'supplierNameJson') is distinct from 'string' or jsonb_typeof(plan->'textJson') is distinct from 'string'
  or plan->'phone'<>'null'::jsonb and (jsonb_typeof(plan->'phone')<>'string' or plan->>'phone'!~'^\+[1-9][0-9]{6,14}$')
  or jsonb_typeof(plan->'channel') is distinct from 'string' or plan->>'channel' not in ('manual','whatsapp') or plan->>'channel'='whatsapp' and plan->>'phone' is null
  or jsonb_typeof(plan->'stockItemIds') is distinct from 'array' or jsonb_array_length(plan->'stockItemIds') not between 1 and 1000
  or jsonb_array_length(plan->'stockItemIds')<>(select count(distinct x) from jsonb_array_elements_text(plan->'stockItemIds') x)
  or exists(select 1 from jsonb_array_elements(plan->'stockItemIds') x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  or exists(select 1 from unnest(array['part','parts']) k where jsonb_typeof(plan->k) is distinct from 'number' or (plan->>k)::numeric<>trunc((plan->>k)::numeric) or (plan->>k)::numeric not between 1 and 1000)
  or (plan->>'part')::numeric>(plan->>'parts')::numeric then raise invalid_parameter_value using message='Keep the complete original supplier confirmation.';end if;
 stats:=private.inbox_literal_stats((plan->>'supplierNameJson')::json);if stats[1] not between 1 and 120 or stats[2]=0 then raise invalid_parameter_value using message='Keep the original supplier name.';end if;
 stats:=private.inbox_literal_stats((plan->>'textJson')::json);if stats[1] not between 1 and 4000 or stats[2]=0 then raise invalid_parameter_value using message='Keep the original supplier message.';end if;
 select array_to_json(array(select jsonb_array_elements_text(plan->'stockItemIds')))::text into stock_ids;
 input_text:='{"id":'||to_json(plan->>'messageId')::text||',"supplierId":'||coalesce(to_json(plan->>'supplierId')::text,'null')||',"supplierName":'||(plan->>'supplierNameJson')||',"phone":'||coalesce(to_json(plan->>'phone')::text,'null')||',"text":'||(plan->>'textJson')||',"channel":'||to_json(plan->>'channel')::text||',"stockItemIds":'||stock_ids||',"part":'||(plan->>'part')||',"parts":'||(plan->>'parts')||'}';
 canonical:='{"id":'||to_json(command_id)::text||',"type":"supplier-message.record","outletId":'||to_json(outlet)::text||',"occurredAt":'||occurred::text||',"message":'||input_text||'}';
 if canonical is distinct from plan->>'intentJson' then raise invalid_parameter_value using message='Keep every original confirmation field, identity and occurrence.';end if;
 return input_text;
end $$;
create function private.supplier_message_write_context(business public.ulid,outlet public.ulid,plan jsonb) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=business),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'supplier',(select row_to_json(s) from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=plan->>'supplierId'),
  'items',(select coalesce(json_agg(row_to_json(i) order by i.id),'[]'::json) from public.stock_items i where i.business_id=business and i.outlet_id=outlet and (plan->'stockItemIds') ? i.id::text),
  'message',(select row_to_json(m) from public.supplier_messages m where m.business_id=business and m.outlet_id=outlet and m.id=plan->>'messageId'))
$$;
create function private.prepare_supplier_message_write(command_id public.ulid,ticket_id public.ulid,outlet public.ulid,plan jsonb,fingerprint text,occurred public.utc_ms) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old private.shop_command_receipts;business public.ulid;actor public.ulid;context json;secret text;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Supplier confirmation access required.';end if;
 if ticket_id is null or ticket_id in(command_id,outlet,(plan->>'messageId')::public.ulid) then raise invalid_parameter_value using message='Keep distinct preparation and original record IDs.';end if;
 perform private.supplier_message_intent(command_id,outlet,occurred,plan,fingerprint);perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform 1 from public.businesses b where b.id=business for share;perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) or old.business_id<>business or old.outlet_id<>outlet then raise insufficient_privilege using message='This confirmation is unavailable.';end if;
  if old.type<>'supplier-message.record' or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original supplier confirmation.';end if;return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 if exists(select 1 from public.events e where e.id=command_id) or exists(select 1 from private.command_receipts r where r.id=command_id) or exists(select 1 from public.supplier_messages m where m.id=plan->>'messageId') then raise insufficient_privilege using message='This action or record identity is unavailable.';end if;
 if plan->>'supplierId' is not null and not exists(select 1 from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=plan->>'supplierId') or (select count(*) from public.stock_items i where i.business_id=business and i.outlet_id=outlet and (plan->'stockItemIds') ? i.id::text)<>jsonb_array_length(plan->'stockItemIds') then raise insufficient_privilege using message='Choose the original supplier and stock items in this outlet.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 delete from private.supplier_message_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.supplier_message_write_tickets t where t.command_id=prepare_supplier_message_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>prepare_supplier_message_write.plan or t.outlet_id<>outlet or t.actor_id<>actor or t.occurred_at<>occurred)) then raise unique_violation using message='Keep the original supplier confirmation.';end if;
 delete from private.supplier_message_write_tickets t where t.command_id=prepare_supplier_message_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.supplier_message_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending confirmations first.';end if;
 context:=private.supplier_message_write_context(business,outlet,plan);secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.supplier_message_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),plan,occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;
create function private.finish_supplier_message_write(ticket_id public.ulid,secret text,message_json text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.supplier_message_write_tickets;at_ms public.utc_ms;updated public.utc_ms;after_data json;metadata jsonb;stock_ids text;
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.supplier_message_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This confirmation preparation is unavailable.';end if;
 perform 1 from public.businesses b where b.id=t.business_id for share;perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 select * into t from private.supplier_message_write_tickets x where x.id=ticket_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This confirmation proof is unavailable.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 if t.snapshot_hash<>sha256(convert_to(private.supplier_message_write_context(t.business_id,t.outlet_id,t.plan)::text,'UTF8')) or exists(select 1 from private.shop_command_receipts r where r.id=t.command_id) then raise sqlstate 'PT409' using message='The supplier confirmation source changed.',detail='supplier_message_snapshot_changed';end if;
 if message_json is distinct from private.supplier_message_intent(t.command_id,t.outlet_id,t.occurred_at,t.plan,t.request_hash) then raise invalid_parameter_value using message='Keep the complete original confirmed message.';end if;
 updated:=greatest(t.created_at,t.occurred_at);select array_to_json(array(select jsonb_array_elements_text(t.plan->'stockItemIds')))::text into stock_ids;
 after_data:=('{"id":'||to_json(t.plan->>'messageId')::text||',"outletId":'||to_json(t.outlet_id)::text||case when t.plan->>'supplierId' is null then '' else ',"supplierId":'||to_json(t.plan->>'supplierId')::text end||',"supplierName":'||(t.plan->>'supplierNameJson')||case when t.plan->>'phone' is null then '' else ',"phone":'||to_json(t.plan->>'phone')::text end||',"text":'||(t.plan->>'textJson')||',"channel":'||to_json(t.plan->>'channel')::text||',"stockItemIds":'||stock_ids||',"part":'||(t.plan->>'part')||',"parts":'||(t.plan->>'parts')||',"createdBy":'||to_json(t.actor_id)::text||',"eventId":'||to_json(t.command_id)::text||',"createdAt":'||t.occurred_at::text||',"updatedAt":'||updated::text||'}')::json;
 insert into public.supplier_messages(id,business_id,outlet_id,created_by,event_id,created_at,updated_at,supplier_id,supplier_name,phone,text,channel,stock_item_ids,part,parts)
 values((t.plan->>'messageId')::public.ulid,t.business_id,t.outlet_id,t.actor_id,t.command_id,t.occurred_at,updated,(t.plan->>'supplierId')::public.ulid,(t.plan->>'supplierNameJson')::json,t.plan->>'phone',(t.plan->>'textJson')::json,t.plan->>'channel',stock_ids::json,(t.plan->>'part')::integer,(t.plan->>'parts')::integer);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,supplier_id) values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,'supplier.sent','null'::json,after_data,t.created_at,(t.plan->>'supplierId')::public.ulid);
 metadata:=jsonb_build_object('id',t.command_id,'type','supplier-message.record','outletId',t.outlet_id,'messageId',t.plan->>'messageId','occurredAt',t.occurred_at,'at',t.created_at,'messageUpdatedAt',updated);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,'supplier-message.record',null,t.request_hash,metadata);
 delete from private.supplier_message_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;
revoke all on function private.supplier_message_intent(public.ulid,public.ulid,public.utc_ms,jsonb,text),private.supplier_message_write_context(public.ulid,public.ulid,jsonb),private.prepare_supplier_message_write(public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms),private.finish_supplier_message_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.prepare_supplier_message_write(public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_supplier_message_write(public.ulid,text,text) to service_role;
create function public.prepare_supplier_message_write(p_id public.ulid,p_ticket_id public.ulid,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_supplier_message_write(p_id,p_ticket_id,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_supplier_message_write(p_ticket_id public.ulid,p_token text,p_message_json text) returns jsonb language sql security invoker set search_path='' as $$select private.finish_supplier_message_write(p_ticket_id,p_token,p_message_json)$$;
revoke all on function public.prepare_supplier_message_write(public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms),public.finish_supplier_message_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_supplier_message_write(public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_supplier_message_write(public.ulid,text,text) to service_role;
