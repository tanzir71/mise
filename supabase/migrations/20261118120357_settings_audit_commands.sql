-- Exact reminder wording and prepared-export metadata; never file bytes or raw client writes.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
 'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch','supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo',
 'order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings','closing.record','closing.undo',
 'handoff.prepare','handoff.change','supplier-message.undo','inbox.capture','inbox.change','khata.wording','export.prepare'));
create table private.settings_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('khata.wording','export.prepare')),
 input_json text not null check(octet_length(input_json)<=32000),occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.settings_write_tickets enable row level security;alter table private.settings_write_tickets force row level security;
revoke all on private.settings_write_tickets from public,anon,authenticated,service_role;
create index settings_write_tickets_actor_idx on private.settings_write_tickets(auth_user_id,expires_at);
create index settings_write_tickets_command_idx on private.settings_write_tickets(command_id);

-- Assemble canonical JS intent text from isolated literal tokens. Never extract
-- fields from a full intent which may contain NUL or lone UTF-16 surrogates.
create function private.settings_intent_input(command_id public.ulid,kind text,outlet public.ulid,occurred public.utc_ms,ids jsonb,fingerprint text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare input jsonb;field text;stats integer[];canonical text;input_text text;datasets text;
begin
 if command_id is null or outlet is null or command_id=outlet or occurred is null or kind is null or kind not in ('khata.wording','export.prepare')
  or jsonb_typeof(ids) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(ids) k) is distinct from array['input','intentJson']
  or jsonb_typeof(ids->'input') is distinct from 'object' or jsonb_typeof(ids->'intentJson') is distinct from 'string' or octet_length(ids::text)>128000 or octet_length(ids->>'intentJson')>32000
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or encode(sha256(convert_to(ids->>'intentJson','UTF8')),'hex')<>fingerprint then raise invalid_parameter_value using message='Keep the complete original settings action.';end if;
 input:=ids->'input';
 if kind='khata.wording' then
  if (select array_agg(k order by k) from jsonb_object_keys(input) k) is distinct from array['directBnJson','directEnJson','gentleBnJson','gentleEnJson','paymentNoteJson'] then raise invalid_parameter_value using message='Keep every original reminder template.';end if;
  foreach field in array array['paymentNoteJson','gentleEnJson','gentleBnJson','directEnJson','directBnJson'] loop
   if jsonb_typeof(input->field) is distinct from 'string' then raise invalid_parameter_value using message='Keep literal reminder wording.';end if;
   stats:=private.inbox_literal_stats((input->>field)::json);
   if stats[1]>(case when field='paymentNoteJson' then 250 else 1000 end) or field<>'paymentNoteJson' and stats[2]=0 then raise invalid_parameter_value using message='Keep reminder wording within its original limits.';end if;
  end loop;
  input_text:='{"paymentNote":'||(input->>'paymentNoteJson')||',"templates":{"gentle":{"en":'||(input->>'gentleEnJson')||',"bn":'||(input->>'gentleBnJson')||'},"direct":{"en":'||(input->>'directEnJson')||',"bn":'||(input->>'directBnJson')||'}}}';
 else
  if (select array_agg(k order by k) from jsonb_object_keys(input) k) is distinct from array['capturedAt','datasets','filenameJson','format','from','includePhones','rows','to']
   or jsonb_typeof(input->'format') is distinct from 'string' or input->>'format' not in ('csv','xlsx','pdf','json','zip')
   or jsonb_typeof(input->'datasets') is distinct from 'array' or jsonb_array_length(input->'datasets')>6
   or exists(select 1 from jsonb_array_elements(input->'datasets') d where jsonb_typeof(d)<>'string' or d#>>'{}' not in ('orders','sales','credit','stock','customers','purchases'))
   or jsonb_array_length(input->'datasets')<>(select count(distinct d) from jsonb_array_elements(input->'datasets') d)
   or input->>'format'<>'json' and jsonb_array_length(input->'datasets')=0
   or jsonb_typeof(input->'filenameJson') is distinct from 'string' or jsonb_typeof(input->'includePhones') is distinct from 'boolean'
   or exists(select 1 from unnest(array['rows','capturedAt']) k where jsonb_typeof(input->k) is distinct from 'number' or (input->>k)::numeric<>trunc((input->>k)::numeric) or (input->>k)::numeric not between 0 and 9007199254740991)
   or (input->>'capturedAt')::numeric>occurred
   or (input->'from' is distinct from 'null'::jsonb or input->'to' is distinct from 'null'::jsonb) and (jsonb_typeof(input->'from') is distinct from 'string' or jsonb_typeof(input->'to') is distinct from 'string' or input->>'from'!~'^\d{4}-\d{2}-\d{2}$' or input->>'to'!~'^\d{4}-\d{2}-\d{2}$' or input->>'from'>input->>'to') then raise invalid_parameter_value using message='Keep the exact prepared-export metadata.';end if;
  stats:=private.inbox_literal_stats((input->>'filenameJson')::json);if stats[1] not between 1 and 160 then raise invalid_parameter_value using message='Keep the prepared filename.';end if;
  select array_to_json(array(select jsonb_array_elements_text(input->'datasets')))::text into datasets;
  input_text:='{"format":'||to_json(input->>'format')::text||',"datasets":'||datasets||',"rows":'||(input->>'rows')||',"filename":'||(input->>'filenameJson')||',"capturedAt":'||(input->>'capturedAt')||',"from":'||coalesce(to_json(input->>'from')::text,'null')||',"to":'||coalesce(to_json(input->>'to')::text,'null')||',"includePhones":'||(input->>'includePhones')||'}';
 end if;
 canonical:='{"id":'||to_json(command_id)::text||',"type":'||to_json(kind)::text||',"outletId":'||to_json(outlet)::text||',"occurredAt":'||occurred::text||',"input":'||input_text||'}';
 if canonical is distinct from ids->>'intentJson' then raise invalid_parameter_value using message='Keep the complete original action, fields, IDs and time.';end if;
 return input_text;
end $$;

create function private.settings_write_context(business public.ulid,outlet public.ulid) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=business),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet))
$$;
-- Match the portable Outlet shape, preserving optional fields and literal JSON.
create function private.settings_outlet_snapshot(o public.outlets) returns json
language sql immutable security invoker set search_path='' as $$
 select ('{"id":'||to_json(o.id)::text||',"createdAt":'||o.created_at::text||',"updatedAt":'||o.updated_at::text||',"businessId":'||to_json(o.business_id)::text||
  ',"name":'||o.name::text||',"address":'||o.address::text||',"timezone":'||to_json(o.timezone)::text||',"currency":'||to_json(o.currency)::text||
  case when o.shop_link is null then '' else ',"shopLink":'||to_json(o.shop_link)::text end||
  case when o.credit_messaging is null then '' else ',"creditMessaging":'||o.credit_messaging::text end||
  case when o.order_warning_minutes is null then '' else ',"orderWarningMinutes":'||o.order_warning_minutes::text end||'}')::json
$$;

create function private.prepare_settings_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;o public.outlets;input_text text;context json;secret text;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This shop action is unavailable.';end if;
 if ticket_id is null or ticket_id=command_id then raise invalid_parameter_value using message='Keep distinct original preparation and action IDs.';end if;
 input_text:=private.settings_intent_input(command_id,kind,outlet,occurred,ids,fingerprint);
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);perform private.customer_write_actor(old.business_id,old.outlet_id,actor,(select auth.uid()));
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This shop action is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original shop action.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select x.business_id into business from public.outlets x where x.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform 1 from public.businesses b where b.id=business for share;
 select * into o from public.outlets x where x.business_id=business and x.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This shop action is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original shop action.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 if exists(select 1 from public.events e where e.id=command_id) or exists(select 1 from private.command_receipts r where r.id=command_id) then raise insufficient_privilege using message='This action identity is unavailable.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 delete from private.settings_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.settings_write_tickets t where t.command_id=prepare_settings_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.input_json<>input_text or t.occurred_at<>occurred or t.type<>kind or t.outlet_id<>outlet)) then raise unique_violation using message='Keep the original shop action.';end if;
 delete from private.settings_write_tickets t where t.command_id=prepare_settings_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.settings_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.settings_write_context(business,outlet);secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.settings_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,input_text,occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create function private.finish_settings_write(ticket_id public.ulid,secret text,input_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.settings_write_tickets;o public.outlets;before_data json;after_data json;updated public.utc_ms;at_ms public.utc_ms;metadata jsonb;
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.settings_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This shop preparation is unavailable.';end if;
 perform 1 from public.businesses b where b.id=t.business_id for share;
 select * into o from public.outlets x where x.business_id=t.business_id and x.id=t.outlet_id for update;
 select * into t from private.settings_write_tickets x where x.id=ticket_id for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This shop proof is unavailable.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 if t.snapshot_hash<>sha256(convert_to(private.settings_write_context(t.business_id,t.outlet_id)::text,'UTF8')) or exists(select 1 from private.shop_command_receipts r where r.id=t.command_id) then raise sqlstate 'PT409' using message='The shop source changed.',detail='settings_snapshot_changed';end if;
 if input_text is distinct from t.input_json then raise invalid_parameter_value using message='Keep the exact normalized original shop fields.';end if;
 if t.type='khata.wording' then
  before_data:=private.settings_outlet_snapshot(o);updated:=greatest(o.updated_at,o.created_at,t.created_at,t.occurred_at);
  update public.outlets x set credit_messaging=t.input_json::json,updated_at=updated where x.business_id=t.business_id and x.id=t.outlet_id returning * into o;
  after_data:=private.settings_outlet_snapshot(o);
 else before_data:='null'::json;after_data:=t.input_json::json;updated:=null;end if;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,t.type,before_data,after_data,t.created_at);
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'at',t.created_at,'outletUpdatedAt',updated);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.settings_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;

revoke all on function private.settings_intent_input(public.ulid,text,public.ulid,public.utc_ms,jsonb,text),private.settings_write_context(public.ulid,public.ulid),private.settings_outlet_snapshot(public.outlets),
 private.prepare_settings_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),private.finish_settings_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.prepare_settings_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_settings_write(public.ulid,text,text) to service_role;
create function public.prepare_settings_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_settings_write(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_settings_write(p_ticket_id public.ulid,p_token text,p_input_json text) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_settings_write(p_ticket_id,p_token,p_input_json)$$;
revoke all on function public.prepare_settings_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),public.finish_settings_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_settings_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_settings_write(public.ulid,text,text) to service_role;
notify pgrst,'reload schema';
