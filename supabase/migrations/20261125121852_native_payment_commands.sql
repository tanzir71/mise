-- Native Payment commands are distinct from the M37 observed-payment protocol.
-- Literal payloads stay private; domain money keeps genuine native child IDs.
create table private.native_payment_observations (
 id public.ulid primary key,business_id public.ulid not null references public.businesses(id),outlet_id public.ulid not null references public.outlets(id),
 inbox_id public.ulid not null references public.inbox_items(id),revision bigint not null check(revision between 1 and 9007199254740991),
 reference_key text,match_key text,record_json text not null check(json_typeof(record_json::json)='object'),
 unique(outlet_id,inbox_id),unique(outlet_id,reference_key),unique(outlet_id,match_key)
);
create table private.native_payment_events (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,command text not null,
 record_json text not null check(json_typeof(record_json::json)='object')
);
create index native_payment_observations_business on private.native_payment_observations(business_id);
create index native_payment_observations_inbox on private.native_payment_observations(inbox_id);
create index native_payment_events_scope on private.native_payment_events(business_id,outlet_id,id);
create table private.native_payment_actions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 type text not null check(type in ('payment.capture','payment.edit','payment.match','payment.unmatch','payment.void','payment.reopen','payment.record','payment.record-undo')),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),intent_json text not null,receipt jsonb not null
);
create table private.native_payment_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null,plan jsonb not null,occurred_at public.utc_ms not null,
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),
 token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
create index native_payment_tickets_expiry on private.native_payment_write_tickets(expires_at);
create index native_payment_tickets_actor on private.native_payment_write_tickets(auth_user_id,expires_at);
create index native_payment_tickets_command on private.native_payment_write_tickets(command_id);
alter table private.native_payment_observations enable row level security;alter table private.native_payment_observations force row level security;
alter table private.native_payment_events enable row level security;alter table private.native_payment_events force row level security;
alter table private.native_payment_actions enable row level security;alter table private.native_payment_actions force row level security;
alter table private.native_payment_write_tickets enable row level security;alter table private.native_payment_write_tickets force row level security;
revoke all on private.native_payment_observations,private.native_payment_events,private.native_payment_actions,private.native_payment_write_tickets from public,anon,authenticated,service_role;

create function private.native_payment_id(source public.ulid,slot text) returns public.ulid
language plpgsql immutable security invoker set search_path='' as $$
declare raw bytea;n numeric:=0;suffix text:='';alphabet text:='0123456789ABCDEFGHJKMNPQRSTVWXYZ';i integer;
begin
 if slot is null or slot!~'^(payment|capture|invocation|money-(orderEvent|sale|saleEvent|entry|creditEvent|refund|refundEvent))$' then raise invalid_parameter_value using message='Keep the original native identity slot.';end if;
 raw:=sha256(convert_to('mise-payment-capture-v1','UTF8')||decode('00','hex')||convert_to(source::text,'UTF8')||decode('00','hex')||convert_to(slot,'UTF8'));
 for i in 0..9 loop n:=n*256+get_byte(raw,i);end loop;
 for i in 1..16 loop suffix:=substr(alphabet,mod(n,32)::integer+1,1)||suffix;n:=div(n,32);end loop;
 return (left(source::text,10)||suffix)::public.ulid;
end $$;
-- Prevent a later legacy domain command from reusing a private native audit ID.
create function private.guard_native_payment_audit_identity() returns trigger
language plpgsql security definer set search_path='' as $$begin
 perform pg_advisory_xact_lock(hashtextextended('mise-native-payment-audit-v1:'||new.id::text,0));
 if exists(select 1 from private.native_payment_events e where e.id=new.id) then raise unique_violation using message='Keep the original native audit identity.';end if;return new;
end $$;
create trigger native_payment_audit_identity before insert or update of id on public.events for each row execute function private.guard_native_payment_audit_identity();

create function private.native_payment_write_context(business public.ulid,outlet public.ulid,actor public.ulid) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object(
 'business',(select row_to_json(b) from public.businesses b where b.id=business),
 'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
 'member',(select row_to_json(m) from public.members m where m.business_id=business and m.id=actor),
 'memberOutlets',coalesce((select json_agg(m.outlet_id order by m.outlet_id) from public.member_outlets m where m.business_id=business and m.member_id=actor),'[]'::json),
 'inboxItems',coalesce((select json_agg(row_to_json(i) order by i.id) from public.inbox_items i where i.business_id=business and i.outlet_id=outlet),'[]'::json),
 'images',coalesce((select json_agg(json_build_object('id',i.id,'business_id',i.business_id,'outlet_id',i.outlet_id,'inbox_item_id',i.inbox_item_id,'position',i.position,'name',i.name,'type',i.type,'size',i.size) order by i.inbox_item_id,i.position) from public.inbox_images i where i.business_id=business and i.outlet_id=outlet),'[]'::json),
 'payments',coalesce((select json_agg(p.record_json order by p.id) from private.native_payment_observations p where p.business_id=business and p.outlet_id=outlet),'[]'::json),
 'nativeEvents',coalesce((select json_agg(e.record_json order by e.id) from private.native_payment_events e where e.business_id=business and e.outlet_id=outlet),'[]'::json),
 'orders',coalesce((select json_agg(row_to_json(o) order by o.id) from public.orders o where o.business_id=business and o.outlet_id=outlet),'[]'::json),
 'sales',coalesce((select json_agg(row_to_json(s) order by s.id) from public.sales s where s.business_id=business and s.outlet_id=outlet),'[]'::json),
 'creditEntries',coalesce((select json_agg(row_to_json(e) order by e.id) from public.credit_entries e where e.business_id=business and e.outlet_id=outlet),'[]'::json),
 'creditAccounts',coalesce((select json_agg(row_to_json(a) order by a.id) from public.credit_accounts a where a.business_id=business and a.outlet_id=outlet),'[]'::json),
 'customers',coalesce((select json_agg(row_to_json(c) order by c.id) from public.customers c where c.business_id=business and (
 exists(select 1 from public.credit_accounts a where a.business_id=business and a.outlet_id=outlet and a.customer_id=c.id) or
 exists(select 1 from public.orders o where o.business_id=business and o.outlet_id=outlet and o.customer_id=c.id) or
 exists(select 1 from public.sales s where s.business_id=business and s.outlet_id=outlet and s.customer_id=c.id))),'[]'::json),
 'orderRefunds',coalesce((select json_agg(row_to_json(r) order by r.id) from public.order_refunds r where r.business_id=business and r.outlet_id=outlet),'[]'::json),
 'events',coalesce((select json_agg(row_to_json(e) order by e.id) from public.events e where e.business_id=business and e.outlet_id=outlet),'[]'::json))
$$;
create function private.admit_native_payment_write(outlet public.ulid) returns boolean
language plpgsql security definer set search_path='' as $$declare business public.ulid;actor public.ulid;begin
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This payment outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));return true;
end $$;
create function private.prepare_native_payment_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.native_payment_actions;c jsonb;context json;secret text;at_ms public.utc_ms;current_payment private.native_payment_observations;source public.inbox_items;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This native payment is unavailable.';end if;
 if kind is null or kind not in ('payment.capture','payment.edit','payment.match','payment.unmatch','payment.void','payment.reopen','payment.record','payment.record-undo') or command_id=ticket_id
 or ids is null or jsonb_typeof(ids)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(ids) k) is distinct from array['actorId','businessId','inboxId','intentJson','paymentHash','paymentId','revision']
 or jsonb_typeof(ids->'intentJson') is distinct from 'string' or octet_length(ids->>'intentJson')>256000 or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$'
 or encode(sha256(convert_to(ids->>'intentJson','UTF8')),'hex')<>fingerprint then raise invalid_parameter_value using message='Keep the complete native payment request.';end if;
 c:=private.native_payment_tokens((ids->>'intentJson')::json)->'command';
 if private.native_payment_text(c->'format')<>'mise-native-payment-command' or private.native_payment_text(c->'version')<>'1' or private.native_payment_text(c->'id') is distinct from command_id::text or private.native_payment_text(c->'type') is distinct from kind or private.native_payment_text(c->'outletId') is distinct from outlet::text
 or private.native_payment_text(private.native_payment_tokens((ids->>'intentJson')::json)->'paymentHash') is distinct from ids->>'paymentHash' or ids->>'paymentHash'!~'^[0-9a-f]{64}$'
 or private.native_payment_text(c->'occurredAt') is distinct from occurred::text or private.native_payment_text(c->'businessId') is distinct from ids->>'businessId' or private.native_payment_text(c->'actorId') is distinct from ids->>'actorId' or private.native_payment_text(c->'paymentId') is distinct from ids->>'paymentId' or private.native_payment_text(c->'inboxId') is distinct from ids->>'inboxId' or private.native_payment_text(c->'revision') is distinct from ids->>'revision'
 or ids->>'paymentId' is distinct from private.native_payment_id((ids->>'inboxId')::public.ulid,'payment')::text or command_id::text=ids->>'paymentId' or command_id::text=ids->>'inboxId'
 or (private.native_payment_text(c->'beforeHash'))!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Keep native payment identities, clocks and source controls.';end if;
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This payment outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 if actor::text is distinct from ids->>'actorId' or business::text is distinct from ids->>'businessId' then raise insufficient_privilege using message='Use the current native payment operator and shop.';end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.native_payment_actions a where a.id=command_id;
 if found then
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) or old.business_id<>business or old.outlet_id<>outlet then raise insufficient_privilege using message='This original native action is unavailable.';end if;
  if old.type<>kind or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original native payment request.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 if exists(select 1 from public.events e where e.id=command_id) or exists(select 1 from private.native_payment_events e where e.id=command_id) then raise unique_violation using message='Keep a distinct original action identity.';end if;
 perform 1 from public.businesses b where b.id=business for share;perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 select * into source from public.inbox_items i where i.business_id=business and i.outlet_id=outlet and i.id=ids->>'inboxId';
 if not found then raise sqlstate 'PT409' using message='Keep the actual saved source.';end if;
 select * into current_payment from private.native_payment_observations p where p.id=ids->>'paymentId';
 if kind='payment.capture' then
  if current_payment.id is not null or ids->>'revision'<>'0' or command_id<>private.native_payment_id(source.id,'capture') or source.archived or private.native_payment_text(c->'beforeHash')<>encode(sha256(convert_to('null','UTF8')),'hex') then raise sqlstate 'PT409' using message='Recover the original capture or open the current source.';end if;
 else
  if current_payment.id is null or current_payment.business_id<>business or current_payment.outlet_id<>outlet or current_payment.inbox_id<>source.id or current_payment.revision::text is distinct from ids->>'revision'
  or private.native_payment_text(c->'beforeHash')<>encode(sha256(convert_to(current_payment.record_json,'UTF8')),'hex') then raise sqlstate 'PT409' using message='Open the current original payment.';end if;
 end if;
 context:=private.native_payment_write_context(business,outlet,actor);
 if octet_length(context::text)>52428800 then raise sqlstate 'PT413' using message='Keep the original payment source for a complete bounded review.';end if;
 delete from private.native_payment_write_tickets t where t.expires_at<at_ms;
 delete from private.native_payment_write_tickets t where t.command_id=prepare_native_payment_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.native_payment_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending payment requests first.';end if;
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.native_payment_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids,occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create function private.native_payment_tokens(value json) returns jsonb
language sql immutable strict security invoker set search_path='' as $$select private.inbox_json_tokens(value)$$;
-- Parse literal values as opaque JSON-string tokens before any traversal.
-- Native text extraction is used only for validated IDs/enums/clocks, never source text.
create function private.native_payment_text(value jsonb) returns text
language sql immutable security invoker set search_path='' as $$select case when jsonb_typeof(value)='string' then (value#>>'{}')::json#>>'{}' else value#>>'{}' end$$;
create function private.native_payment_equal(value jsonb,expected jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$select coalesce(value,'null'::jsonb)=coalesce(expected,'null'::jsonb)$$;
create function private.native_payment_token_canonical(value jsonb) returns text
language plpgsql immutable security invoker set search_path='' as $$declare result text;begin
 case jsonb_typeof(value)
 when 'object' then select '{'||coalesce(string_agg(to_json(e.key)::text||':'||private.native_payment_token_canonical(e.value),',' order by e.key collate "C"),'')||'}' into result from jsonb_each(value) e;
 when 'array' then select '['||coalesce(string_agg(private.native_payment_token_canonical(e.value),',' order by e.ordinality),'')||']' into result from jsonb_array_elements(value) with ordinality e;
 when 'string' then result:=value#>>'{}';else result:=value::text;end case;return result;
end $$;
create function private.native_payment_canonical(value json) returns text
language sql immutable security invoker set search_path='' as $$select private.native_payment_token_canonical(private.native_payment_tokens(value))$$;
create function private.native_payment_matches_current(table_name text,proposed jsonb,skip_fields text[]) returns boolean
language plpgsql volatile security invoker set search_path='' as $$
declare actual jsonb;actual_raw json;field text;kind oid;begin
 if table_name not in ('orders','sales') then return false;end if;
 execute format('select row_to_json(r) from public.%I r where r.id=$1',table_name) into actual_raw using proposed->>'id';actual:=private.native_payment_tokens(actual_raw);
 if actual is null then return false;end if;
 for field in select jsonb_object_keys(proposed) loop
  if field=any(skip_fields) then continue;end if;
  with recursive types(oid) as (select a.atttypid from pg_attribute a where a.attrelid=to_regclass('public.'||table_name) and a.attname=field and a.attnum>0 and not a.attisdropped union all select t.typbasetype from pg_type t join types x on x.oid=t.oid where t.typbasetype<>0) select x.oid into kind from types x join pg_type t on t.oid=x.oid where t.typbasetype=0;
  if kind='json'::regtype or kind='public.literal_text'::regtype then
   if private.native_payment_equal(coalesce(private.native_payment_tokens((proposed->>field)::json),'null'::jsonb),coalesce(actual->field,'null'::jsonb)) is not true then return false;end if;
  elsif proposed->>field is distinct from private.native_payment_text(actual->field) then return false;end if;
 end loop;return true;
end $$;
create function private.finish_native_payment_write(ticket_id public.ulid,secret text,payment_json text,event_payloads jsonb,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.native_payment_write_tickets;old private.native_payment_actions;original private.native_payment_observations;
 c jsonb;n jsonb;b jsonb;payload jsonb;posting jsonb;prior_posting jsonb;undo jsonb;target_kind text;field text;raw text;table_name text;v jsonb;r jsonb;allowed jsonb;keys text;casts text;
 at_ms public.utc_ms;recorded_server_at public.utc_ms;native_count integer:=0;invocation_count integer:=0;money boolean:=false;ack boolean:=false;mode text;financial jsonb:=null;metadata jsonb;
 source_row public.inbox_items;public_events integer;sale_count integer;entry_count integer;order_count integer;expected_events jsonb;expected_receipt public.ulid;account public.credit_accounts;target_entry public.credit_entries;balance numeric;
 specs jsonb:='{"orders":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","business_type","sequence","number","source","source_text","customer_id","customer_name","customer_phone","type","status","status_changed_at","status_event_id","lines","subtotal","delivery_fee","discount","total","currency","timezone","address","table_label","scheduled_for","payment","handled_by","business_id"],"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare the original native action again.';end if;
 select * into t from private.native_payment_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Prepare the original native action again.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses x where x.id=t.business_id for share;perform 1 from public.outlets x where x.id=t.outlet_id and x.business_id=t.business_id for update;
 select * into old from private.native_payment_actions x where x.id=t.command_id;
 if found then
  if old.auth_user_id<>t.auth_user_id or old.actor_id<>t.actor_id or old.outlet_id<>t.outlet_id or old.type<>t.type or old.request_hash<>t.request_hash then raise unique_violation using message='Keep the original native payment request.';end if;return old.receipt;
 end if;
 select * into t from private.native_payment_write_tickets x where x.id=ticket_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.expires_at<at_ms then raise sqlstate 'PT409' using message='Prepare the original native action again.';end if;
 if sha256(convert_to(private.native_payment_write_context(t.business_id,t.outlet_id,t.actor_id)::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='Compare the current native source again.',detail='native_payment_snapshot_changed';end if;
 c:=private.native_payment_tokens((t.plan->>'intentJson')::json)->'command';
 select * into original from private.native_payment_observations x where x.id=t.plan->>'paymentId';b:=coalesce(private.native_payment_tokens(original.record_json::json),'null'::jsonb);
 if payment_json is null or octet_length(payment_json)>52428800 or payment_json<>private.native_payment_canonical(payment_json::json) or encode(sha256(convert_to(payment_json,'UTF8')),'hex')<>t.plan->>'paymentHash' then raise invalid_parameter_value using message='Keep canonical literal native payment data.';end if;n:=private.native_payment_tokens(payment_json::json);
 if jsonb_typeof(n) is distinct from 'object' or private.native_payment_text(n->'id') is distinct from t.plan->>'paymentId' or private.native_payment_text(n->'inboxId') is distinct from t.plan->>'inboxId' or private.native_payment_text(n->'outletId') is distinct from t.outlet_id::text or private.native_payment_text(n->'eventId') is distinct from t.command_id::text
 or (private.native_payment_text(n->'revision'))::numeric is distinct from (t.plan->>'revision')::numeric+1 or (private.native_payment_text(n->'updatedAt'))::numeric is distinct from greatest(coalesce((private.native_payment_text(b->'updatedAt'))::numeric,t.occurred_at),t.occurred_at)
 or (private.native_payment_text(n->'amount'))::numeric not between 1 and 9007199254740991 or (private.native_payment_text(n->'amount'))::numeric<>trunc((private.native_payment_text(n->'amount'))::numeric) or private.native_payment_text(n->'currency')!~'^[A-Z]{3}$' or private.native_payment_text(n->'method') not in ('cash','wallet','card') then raise invalid_parameter_value using message='Keep the original payment, revision and integer money.';end if;
 if t.type='payment.capture' then
  select * into source_row from public.inbox_items i where i.id=t.plan->>'inboxId' and i.business_id=t.business_id and i.outlet_id=t.outlet_id;
  if source_row.id is null or private.native_payment_text(n->'source') is distinct from private.native_payment_text(c->'kind') or private.native_payment_equal((n->'original')->'title',private.native_payment_tokens(source_row.title)) is not true or private.native_payment_equal((n->'original')->'text',private.native_payment_tokens(source_row.text)) is not true or private.native_payment_equal((n->'original')->'url',private.native_payment_tokens(source_row.url)) is not true or private.native_payment_text((n->'original')->'createdAt') is distinct from source_row.created_at::text
  or private.native_payment_equal((n->'parsed')->'sourceContext',c->'context') is not true or private.native_payment_equal((n->'parsed')->'raw',private.native_payment_tokens(case when (private.inbox_literal_stats(source_row.text))[1]>0 then source_row.text else source_row.title end)) is not true then raise invalid_parameter_value using message='Keep the genuine literal source and parser context.';end if;
  if original.id is not null or private.native_payment_text(n->'createdBy')<>t.actor_id or (private.native_payment_text(n->'createdAt'))::bigint<>t.occurred_at or n->'association' is not null or n->'postings' is not null or n->'voidedAt' is not null then raise invalid_parameter_value using message='Keep the exact native capture.';end if;
 else
  if original.id is null then raise invalid_parameter_value using message='Keep the actual prior native payment.';end if;
  foreach field in array array['id','createdAt','outletId','inboxId','createdBy','source','original','parsed'] loop
   if private.native_payment_equal(coalesce(n->field,'null'::jsonb),coalesce(b->field,'null'::jsonb)) is not true then raise invalid_parameter_value using message='Keep every immutable native source field.';end if;
  end loop;
 end if;
 foreach field in array array['amount','currency','method','methodName','reference','referenceScope','fromPhone','receivedAt'] loop
  if private.native_payment_equal(coalesce(n->field,'null'::jsonb),coalesce(case when t.type in ('payment.capture','payment.edit') then (c->'input')->field else b->field end,'null'::jsonb)) is not true then raise invalid_parameter_value using message='Keep the checked native money fields.';end if;
 end loop;
 if t.type not in ('payment.record','payment.record-undo') and private.native_payment_equal(coalesce(n->'postings','null'::jsonb),coalesce(b->'postings','null'::jsonb)) is not true then raise invalid_parameter_value using message='Metadata cannot alter recorded money.';end if;
 prior_posting:=(select x from jsonb_array_elements(coalesce(b->'postings','[]'::jsonb)) x where x->'undo' is null);
 if t.type='payment.match' then
  if b->'association' is not null or b->'voidedAt' is not null or n->'voidedAt' is not null or private.native_payment_text((n->'association')->'id') is distinct from private.native_payment_text((c->'selected')->'id') or private.native_payment_text((n->'association')->'kind') is distinct from private.native_payment_text((c->'selected')->'kind') or private.native_payment_text((n->'association')->'eventId')<>t.command_id or (private.native_payment_text((n->'association')->'at'))::bigint<>t.occurred_at then raise invalid_parameter_value using message='Keep the selected native association.';end if;
 elsif t.type in ('payment.edit','payment.void','payment.reopen','payment.unmatch') then
  if prior_posting is not null or n->'association' is not null or (t.type='payment.unmatch' and (b->'association' is null or b->'voidedAt' is not null or n->'voidedAt' is not null))
  or (t.type<>'payment.unmatch' and b->'association' is not null)
  or (t.type='payment.edit' and (b->'voidedAt' is not null or n->'voidedAt' is not null))
  or (t.type='payment.void' and (b->'voidedAt' is not null or (private.native_payment_text(n->'voidedAt'))::bigint is distinct from t.occurred_at::bigint))
  or (t.type='payment.reopen' and (b->'voidedAt' is null or n->'voidedAt' is not null)) then raise invalid_parameter_value using message='Keep the exact native metadata transition.';end if;
 end if;
 money:=t.type in ('payment.record','payment.record-undo');
 if money then
  posting:=(n->'postings')->(jsonb_array_length(n->'postings')-1);
  if b->'voidedAt' is not null or n->'voidedAt' is not null or posting is null then raise invalid_parameter_value using message='Keep the actual original financial recording.';end if;
  target_kind:=private.native_payment_text((posting->'target')->'kind');expected_receipt:=(private.native_payment_text((posting->'receipt')->'id'))::public.ulid;
  if t.type='payment.record' then
   if prior_posting is not null or private.native_payment_text(c->'confirmedNewMoney')<>'true' or jsonb_array_length(n->'postings')<>jsonb_array_length(coalesce(b->'postings','[]'::jsonb))+1 or private.native_payment_text(posting->'eventId')<>t.command_id or (private.native_payment_text(posting->'at'))::bigint<>t.occurred_at or posting->'undo' is not null
   or target_kind is distinct from private.native_payment_text((c->'target')->'kind') or (target_kind<>'counter' and private.native_payment_text((posting->'target')->'id') is distinct from private.native_payment_text((c->'target')->'id'))
   or expected_receipt<>private.native_payment_id(t.command_id,case when target_kind='credit' then 'money-entry' else 'money-sale' end) then raise invalid_parameter_value using message='Keep the explicit native money confirmation and children.';end if;
   expected_events:=(posting->'receipt')->'eventIds';mode:=null;
  else
   undo:=posting->'undo';mode:=private.native_payment_text(undo->'mode');ack:=mode='already-undone';
   if prior_posting is null or private.native_payment_text(c->'confirmedUndo')<>'true' or jsonb_array_length(n->'postings')<>jsonb_array_length(b->'postings') or undo is null or mode not in ('performed','already-undone') or private.native_payment_text(undo->'eventId')<>t.command_id or (private.native_payment_text(undo->'at'))::bigint<>t.occurred_at
   or n->'association' is not null or private.native_payment_equal(prior_posting,(select jsonb_object_agg(e.key,e.value) from jsonb_each(posting) e where e.key<>'undo')) is not true then raise invalid_parameter_value using message='Keep the explicit original native undo.';end if;
   if not ack then
    select (a.receipt->>'at')::bigint into recorded_server_at from private.native_payment_actions a where a.id=private.native_payment_text(prior_posting->'eventId') and a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.type='payment.record';
    if recorded_server_at is null or at_ms<(private.native_payment_text(prior_posting->'at'))::bigint or at_ms-least((private.native_payment_text(prior_posting->'at'))::bigint,recorded_server_at::bigint)>600000 then raise sqlstate 'PT409' using message='The original native money undo window expired.';end if;
   end if;
   expected_events:=undo->'eventIds';
  end if;
  if jsonb_typeof(expected_events) is distinct from 'array' or jsonb_array_length(expected_events) not between 1 and 3 then raise invalid_parameter_value using message='Keep the genuine financial event identities.';end if;
 end if;
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records)>6 or octet_length(records::text)>52428800 or event_payloads is null or jsonb_typeof(event_payloads)<>'array' or jsonb_array_length(event_payloads) not between 2 and 1000 or octet_length(event_payloads::text)>104857600 then raise invalid_parameter_value using message='Keep the bounded complete native transaction.';end if;
 if exists(select 1 from jsonb_array_elements(records) x group by x->>'table',x->'values'->>'id' having count(*)>1) then raise invalid_parameter_value using message='Keep distinct native companion rows.';end if;
 select count(*) filter(where x->>'table'='sales'),count(*) filter(where x->>'table'='credit_entries'),count(*) filter(where x->>'table'='orders'),count(*) filter(where x->>'table'='events') into sale_count,entry_count,order_count,public_events from jsonb_array_elements(records) x;
 if sale_count<>(case when money and not ack and target_kind in ('order','counter') then 1 else 0 end) or entry_count<>(case when money and not ack and target_kind='credit' then 1 else 0 end)
 or order_count<>(case when money and not ack and target_kind='order' then 1 else 0 end) or public_events<>(case when money and not ack then jsonb_array_length(expected_events) else 0 end)
 or sale_count+entry_count+order_count+public_events<>jsonb_array_length(records) then raise invalid_parameter_value using message='Keep every financial row and audit atomically.';end if;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if allowed is null or jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>2 or jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed)
  or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k) or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
  or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Keep native companion table fields and scope.';end if;
  if table_name='orders' then
   if v->>'id' is distinct from private.native_payment_text((posting->'target')->'id') or v->>'event_id'<>private.native_payment_id(t.command_id,'money-orderEvent') or (v->>'revision')::bigint<>(select o.revision+1 from public.orders o where o.id=v->>'id') or (v->>'updated_at')::bigint<>t.occurred_at
   or private.native_payment_matches_current(table_name,v,array['payment','revision','updated_at','event_id']) is not true then raise invalid_parameter_value using message='Native payment cannot replace unrelated order data.';end if;
   update public.orders o set payment=(v->>'payment')::json,revision=(v->>'revision')::bigint,updated_at=(v->>'updated_at')::bigint,event_id=(v->>'event_id')::public.ulid where o.id=v->>'id';
  elsif table_name='sales' and t.type='payment.record-undo' then
   if v->>'id' is distinct from expected_receipt::text or (v->>'voided_at')::bigint is distinct from t.occurred_at::bigint or v->>'void_reason'<>'undo' or (v->>'updated_at')::bigint<>t.occurred_at
   or private.native_payment_matches_current(table_name,v,array['voided_at','void_reason','updated_at']) is not true then raise invalid_parameter_value using message='Keep the exact original sale undo.';end if;
   update public.sales x set voided_at=t.occurred_at,void_reason='undo',updated_at=t.occurred_at where x.id=expected_receipt;
  else
   if table_name='sales' then
    if v->>'id'<>private.native_payment_id(t.command_id,'money-sale') or v->>'event_id'<>private.native_payment_id(t.command_id,'money-saleEvent') or v->>'created_by'<>t.actor_id or (v->>'created_at')::bigint<>t.occurred_at or (v->>'updated_at')::bigint<>t.occurred_at
    or (v->>'amount')::numeric is distinct from (private.native_payment_text(n->'amount'))::numeric or v->>'currency' is distinct from private.native_payment_text(n->'currency') or v->>'method' is distinct from private.native_payment_text(n->'method')
    or private.native_payment_equal(private.native_payment_tokens((v->>'method_name')::json),n->'methodName') is not true or v->>'voided_at' is not null or v->>'void_reason' is not null
    or (target_kind='order' and v->>'order_id' is distinct from private.native_payment_text((posting->'target')->'id')) or (target_kind='counter' and (v->>'order_id' is not null or v->>'credit_account_id' is not null)) then raise invalid_parameter_value using message='Keep the received money and actual native sale.';end if;
   elsif table_name='credit_entries' then
    select * into account from public.credit_accounts a where a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.id=v->>'account_id';
    if not found then raise invalid_parameter_value using message='Use the actual scoped khata.';end if;
    select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0) into balance from public.credit_entries e where e.account_id=account.id;
    if v->>'id'<>private.native_payment_id(t.command_id,'money-entry') or v->>'event_id'<>private.native_payment_id(t.command_id,'money-creditEvent') or v->>'customer_id'<>account.customer_id or v->>'created_by'<>t.actor_id or (v->>'created_at')::bigint<>t.occurred_at or (v->>'updated_at')::bigint<>t.occurred_at or v->>'currency'<>account.currency
    or (v->>'sequence')::bigint<>(select coalesce(max(e.sequence),0)+1 from public.credit_entries e where e.account_id=account.id) or v->>'sale_id' is not null or v->>'order_id' is not null or v->>'refund_id' is not null then raise invalid_parameter_value using message='Keep the genuine native collection sequence and IDs.';end if;
    if t.type='payment.record' then
     if account.id::text is distinct from private.native_payment_text((posting->'target')->'id') or v->>'type'<>'payment' or (v->>'amount')::numeric is distinct from (private.native_payment_text(n->'amount'))::numeric or (v->>'amount')::numeric>balance or v->>'reversal_of' is not null
     or private.native_payment_equal(private.native_payment_tokens((v->>'method_name')::json),n->'methodName') is not true then raise invalid_parameter_value using message='Keep actual received money within the current debt.';end if;
    else
     select * into target_entry from public.credit_entries e where e.id=expected_receipt and e.business_id=t.business_id and e.outlet_id=t.outlet_id;
     if target_entry.id is null or target_entry.type<>'payment' or target_entry.reversal_of is not null or target_entry.account_id<>account.id or v->>'type'<>'adjustment' or v->>'reversal_of' is distinct from target_entry.id::text or (v->>'amount')::numeric is distinct from target_entry.amount::numeric then raise invalid_parameter_value using message='Undo only the original native collection.';end if;
    end if;
   elsif table_name='events' then
    if v->>'actor_type'<>'member' or v->>'actor_id'<>t.actor_id or (v->>'at')::bigint<>t.occurred_at or not exists(select 1 from jsonb_array_elements(expected_events) e where private.native_payment_text(e)=v->>'id')
    or not ((v->>'id'=private.native_payment_id(t.command_id,'money-orderEvent') and v->>'command'=case when t.type='payment.record' then 'order.payment' else 'order.payment-undo' end)
     or (v->>'id'=private.native_payment_id(t.command_id,'money-saleEvent') and v->>'command'=case when t.type='payment.record' then 'sale.record' else 'sale.undo' end)
     or (v->>'id'=private.native_payment_id(t.command_id,'money-creditEvent') and v->>'command'=case when t.type='payment.record' then 'khata.payment' else 'khata.undo' end)) then raise invalid_parameter_value using message='Keep the genuine native financial audit.';end if;
   else raise invalid_parameter_value using message='Unsupported native companion table.';end if;
   select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key) into keys,casts from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
   execute format('insert into public.%I(%s) select %s',table_name,keys,casts) using v;
  end if;
 end loop;
 if money then
  if exists(select 1 from jsonb_array_elements(expected_events) e where not exists(select 1 from public.events x where x.id=private.native_payment_text(e) and x.business_id=t.business_id and x.outlet_id=t.outlet_id)) then raise invalid_parameter_value using message='The actual native financial events are missing.';end if;
  financial:=jsonb_build_object('kind',case when t.type='payment.record' then 'record' else 'undo' end,'postingEventId',private.native_payment_text(posting->'eventId'),'receiptKind',private.native_payment_text((posting->'receipt')->'kind'),'receiptId',expected_receipt,'eventIds',(select jsonb_agg(to_jsonb(private.native_payment_text(e))) from jsonb_array_elements(expected_events) e),'mode',mode);
 end if;
 for raw in select jsonb_array_elements_text(event_payloads) loop
  if raw is null or raw<>private.native_payment_canonical(raw::json) then raise invalid_parameter_value using message='Keep canonical literal native history.';end if;payload:=private.native_payment_tokens(raw::json);
  perform pg_advisory_xact_lock(hashtextextended('mise-native-payment-audit-v1:'||private.native_payment_text(payload->'id'),0));
  if private.native_payment_text(payload->'outletId')<>t.outlet_id or private.native_payment_text((payload->'actor')->'type')<>'member' or private.native_payment_text((payload->'actor')->'id')<>t.actor_id or (private.native_payment_text(payload->'at'))::bigint<>t.occurred_at or exists(select 1 from public.events e where e.id=private.native_payment_text(payload->'id')) then raise invalid_parameter_value using message='Keep the exact scoped native audit.';end if;
  if private.native_payment_text(payload->'command')=t.type then
   native_count:=native_count+1;
   if private.native_payment_text(payload->'id')<>t.command_id or private.native_payment_text(payload->'paymentId') is distinct from private.native_payment_text(n->'id') or private.native_payment_text(payload->'paymentRevision') is distinct from private.native_payment_text(n->'revision') or private.native_payment_equal(payload->'before',b) is not true or private.native_payment_equal(payload->'after',n) is not true then raise invalid_parameter_value using message='Native history must match actual before and after data.';end if;
  elsif private.native_payment_text(payload->'command')='source.payment-invocation' then
   invocation_count:=invocation_count+1;
   if private.native_payment_text(payload->'id')<>private.native_payment_id(t.command_id,'invocation') or jsonb_typeof(payload->'before')<>'null' or private.native_payment_equal((payload->'after')->'command',c) is not true or private.native_payment_text((payload->'after')->'paymentHash')<>encode(sha256(convert_to(payment_json,'UTF8')),'hex') then raise invalid_parameter_value using message='Keep the exact invocation and payment result.';end if;
  elsif private.native_payment_text(payload->'command')<>'source.payment-evidence' then raise invalid_parameter_value using message='Unsupported native audit companion.';end if;
  if exists(select 1 from private.native_payment_events e where e.id=private.native_payment_text(payload->'id')) then
   if not exists(select 1 from private.native_payment_events e where e.id=private.native_payment_text(payload->'id') and e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.record_json=raw) then raise unique_violation using message='An original native audit cannot be replaced.';end if;
  else insert into private.native_payment_events values((private.native_payment_text(payload->'id'))::public.ulid,t.business_id,t.outlet_id,private.native_payment_text(payload->'command'),raw);end if;
 end loop;
 if native_count<>1 or invocation_count<>1 then raise invalid_parameter_value using message='Keep the native action and invocation together.';end if;
 insert into private.native_payment_observations values((private.native_payment_text(n->'id'))::public.ulid,t.business_id,t.outlet_id,(private.native_payment_text(n->'inboxId'))::public.ulid,(private.native_payment_text(n->'revision'))::bigint,private.native_payment_text(n->'referenceKey'),private.native_payment_text(n->'matchKey'),payment_json)
 on conflict(id) do update set revision=excluded.revision,reference_key=excluded.reference_key,match_key=excluded.match_key,record_json=excluded.record_json;
 metadata:=jsonb_build_object('format','mise-native-payment-receipt','version',1,'id',t.command_id,'type',t.type,'businessId',t.business_id,'outletId',t.outlet_id,'actorId',t.actor_id,'paymentId',private.native_payment_text(n->'id'),'inboxId',private.native_payment_text(n->'inboxId'),'occurredAt',t.occurred_at,'at',t.created_at,'revision',(private.native_payment_text(n->'revision'))::bigint,'paymentHash',encode(sha256(convert_to(payment_json,'UTF8')),'hex'),'eventId',t.command_id,'invocationId',private.native_payment_id(t.command_id,'invocation'),'financial',financial);
 insert into private.native_payment_actions values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.request_hash,t.plan->>'intentJson',metadata);
 delete from private.native_payment_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;

revoke all on function private.native_payment_id(public.ulid,text),private.guard_native_payment_audit_identity(),private.native_payment_tokens(json),private.native_payment_canonical(json),private.native_payment_text(jsonb),private.native_payment_equal(jsonb,jsonb),private.native_payment_token_canonical(jsonb),private.native_payment_matches_current(text,jsonb,text[]),private.native_payment_write_context(public.ulid,public.ulid,public.ulid),private.admit_native_payment_write(public.ulid),private.prepare_native_payment_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),private.finish_native_payment_write(public.ulid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.admit_native_payment_write(public.ulid),private.prepare_native_payment_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_native_payment_write(public.ulid,text,text,jsonb,jsonb) to service_role;
create function public.admit_native_payment_write(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_native_payment_write(p_outlet_id)$$;
create function public.prepare_native_payment_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_native_payment_write(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_native_payment_write(p_ticket_id public.ulid,p_token text,p_payment_json text,p_events jsonb,p_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_native_payment_write(p_ticket_id,p_token,p_payment_json,p_events,p_records)$$;
revoke all on function public.admit_native_payment_write(public.ulid),public.prepare_native_payment_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),public.finish_native_payment_write(public.ulid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admit_native_payment_write(public.ulid),public.prepare_native_payment_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_native_payment_write(public.ulid,text,text,jsonb,jsonb) to service_role;
