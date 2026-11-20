-- Invoice reviews retain original source, financial identity and physical time.
-- The shared invoice mutation does not mark stock received or create refunds.
create table private.purchase_review_tickets (
 id public.ulid primary key,command_id public.ulid not null,replacement_id public.ulid not null,
 business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 type text not null check(type in ('purchase.record','purchase.undo')),original_hash text not null check(original_hash~'^[0-9a-f]{64}$'),source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),currency text not null check(currency~'^[A-Z]{3}$'),
 plan jsonb not null,original_intent text not null,source_json text not null,occurred_at public.utc_ms not null,
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null,
 check(id<>command_id and id<>replacement_id and command_id<>replacement_id),check(octet_length(original_intent)<=2000000 and octet_length(source_json)<=4000000)
);
create index purchase_review_tickets_actor_idx on private.purchase_review_tickets(auth_user_id,expires_at);
create table private.purchase_command_resolutions (
 id public.ulid primary key,command_id public.ulid not null unique,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,original_hash text not null,source_hash text not null,original_intent text not null,source_json text not null,
 outcome text not null check(outcome in ('withdrawn','replaced')),replacement_id public.ulid,reserved_ids public.ulid[] not null,receipt jsonb not null,created_at public.utc_ms not null,
 check((outcome='withdrawn')=(replacement_id is null))
);
create index purchase_command_resolutions_reserved_idx on private.purchase_command_resolutions using gin(reserved_ids);
alter table private.purchase_review_tickets enable row level security;
alter table private.purchase_review_tickets force row level security;
alter table private.purchase_command_resolutions enable row level security;
alter table private.purchase_command_resolutions force row level security;
revoke all on private.purchase_review_tickets,private.purchase_command_resolutions from public,anon,authenticated,service_role;

create function private.purchase_review_plan_valid(kind text,ids jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 if kind is null or kind not in ('purchase.record','purchase.undo') or jsonb_typeof(ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(ids))<>6
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
  or exists(select 1 from jsonb_array_elements_text(ids->'stockItemIds') x where not exists(select 1 from jsonb_array_elements(ids->'lineFacts') l where l->>'stockItemId'=x)) then return false;end if;
 if ids->>'purchaseId' is null or ids->>'revision' is not null or kind='purchase.undo' and (ids->>'supplierId' is not null or jsonb_array_length(ids->'stockItemIds')<>0) then return false;end if;
 return true;
end $$;

create function private.purchase_review_new_ids(kind text,ids jsonb,command_id public.ulid) returns public.ulid[]
language sql immutable security invoker set search_path='' as $$
 select array_remove(array[command_id,case when kind='purchase.record' then (ids->>'purchaseId')::public.ulid end],null)
$$;
create function private.assert_purchase_resolution_access(command_id public.ulid,kind text,ids jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from private.purchase_command_resolutions r where r.command_id=assert_purchase_resolution_access.command_id or r.reserved_ids&&private.purchase_review_new_ids(kind,ids,assert_purchase_resolution_access.command_id)) then
  raise sqlstate 'PT409' using message='Keep the original invoice resolution and reserved identities.';end if;
end $$;
create function private.reject_resolved_purchase_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Normal invoice undo uses INSERT ON CONFLICT. Keep updates to an existing
 -- scoped invoice with its actual birth event available after a replacement.
 if tg_table_name='purchases' then
  if exists(select 1 from public.purchases p where p.id=new.id and p.business_id=new.business_id and p.outlet_id=new.outlet_id and p.event_id=new.event_id) then return new;end if;
 end if;
 if exists(select 1 from private.purchase_command_resolutions r where r.reserved_ids@>array[new.id]) then raise sqlstate 'PT409' using message='Keep the original resolved invoice identities.';end if;
 return new;
end $$;
create trigger resolved_purchase_identity before insert on public.purchases for each row execute function private.reject_resolved_purchase_identity();
create trigger resolved_purchase_event_identity before insert on public.events for each row execute function private.reject_resolved_purchase_identity();
create function private.purchase_review_state(business public.ulid,outlet public.ulid,kind text,ids jsonb,command_id public.ulid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare valid boolean:=true;context json;
begin
 if kind='purchase.record' then
  if exists(select 1 from public.purchases p where p.id=ids->>'purchaseId') then valid:=false;end if;
  if ids->>'supplierId' is not null and not exists(select 1 from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=ids->>'supplierId' and s.archived_at is null) then valid:=false;end if;
  if (select count(*) from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.id in (select jsonb_array_elements_text(ids->'stockItemIds')))<>jsonb_array_length(ids->'stockItemIds') then valid:=false;end if;
 elsif not exists(select 1 from public.purchases p where p.business_id=business and p.outlet_id=outlet and p.id=ids->>'purchaseId') then valid:=false;
 end if;
 context:=private.purchase_write_context(business,outlet,ids);
 return jsonb_build_object('contextJson',context::text,'selectionValid',valid,'reserved',exists(select 1 from private.purchase_command_resolutions r where r.reserved_ids&&private.purchase_review_new_ids(kind,ids,purchase_review_state.command_id)));
end $$;

create function private.inspect_purchase_outcome(command_id public.ulid,kind text,outlet public.ulid,fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;r private.shop_command_receipts;
begin
 if command_id is null or outlet is null or kind is null or kind not in ('purchase.record','purchase.undo') or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Keep the original financial identity.';end if;
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);
 select * into r from private.shop_command_receipts x where x.id=command_id;
 if not found then return null;end if;
 if r.business_id<>business or r.outlet_id<>outlet or r.actor_id<>actor or r.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This financial action is unavailable.';end if;
 if r.type<>kind or r.request_hash<>fingerprint then raise sqlstate 'PT409' using message='Keep the original financial identity.';end if;
 return r.receipt;
end $$;
create function private.prepare_purchase_review(review_id public.ulid,replacement_id public.ulid,command_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms,intent_json text,source_hash text,source_json text,saved_currency text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old jsonb;t private.purchase_review_tickets;state jsonb;secret text;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null or review_id is null or replacement_id is null or command_id is null or outlet is null or occurred is null or review_id=command_id or review_id=replacement_id or command_id=replacement_id
  or kind is null or kind not in ('purchase.record','purchase.undo') or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or source_hash is null or source_hash!~'^[0-9a-f]{64}$'
  or intent_json is null or octet_length(intent_json)>2000000 or source_json is null or octet_length(source_json)>4000000
  or review_id=outlet or replacement_id=outlet or exists(select 1 from unnest(array[review_id,replacement_id,command_id]) x where x::text in (ids->>'supplierId',ids->>'purchaseId') or ids->'stockItemIds' ? x::text)
  or private.purchase_review_plan_valid(kind,ids) is not true or encode(sha256(convert_to(intent_json,'UTF8')),'hex')<>fingerprint or saved_currency is null or saved_currency!~'^[A-Z]{3}$'
 then raise invalid_parameter_value using message='Keep the complete original financial action and source.';end if;
 old:=private.inspect_purchase_outcome(command_id,kind,outlet,fingerprint);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 perform 1 from public.businesses b where b.id=business for update;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 old:=private.inspect_purchase_outcome(command_id,kind,outlet,fingerprint);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 if exists(select 1 from private.command_receipts r where r.id=command_id) or exists(select 1 from public.events e where e.id=command_id) then raise sqlstate 'PT409' using message='Keep the original financial identity.';end if;
 select * into t from private.purchase_review_tickets r where r.id=review_id;
 if found and (t.command_id<>command_id or t.replacement_id<>replacement_id or t.auth_user_id<>(select auth.uid()) or t.actor_id<>actor or t.original_hash<>fingerprint or t.source_hash<>source_hash or t.source_json<>source_json or t.plan<>ids or t.original_intent<>intent_json or t.currency<>saved_currency or t.occurred_at<>occurred) then raise sqlstate 'PT409' using message='Keep the original selected financial review.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from private.purchase_review_tickets r where r.auth_user_id=(select auth.uid()) and (r.expires_at<=at_ms or r.id=review_id);
 if (select count(*) from private.purchase_review_tickets r where r.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Finish an existing financial review first.';end if;
 state:=private.purchase_review_state(business,outlet,kind,ids,command_id);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.purchase_review_tickets values(review_id,command_id,replacement_id,business,outlet,actor,(select auth.uid()),kind,fingerprint,source_hash,saved_currency,ids,intent_json,source_json,occurred,sha256(convert_to(state->>'contextJson','UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+120000);
 return jsonb_build_object('done',false,'id',review_id,'replacementId',replacement_id,'commandId',command_id,'type',kind,'occurredAt',occurred,'businessId',business,'outletId',outlet,'actorId',actor,'commandHash',fingerprint,'sourceHash',source_hash,'sourceJsonHash',encode(sha256(convert_to(source_json,'UTF8')),'hex'),'savedCurrency',saved_currency,'plan',ids,'token',secret,'at',at_ms,'expiresAt',at_ms+120000)||state;
end $$;
create function private.read_purchase_review(review_id public.ulid,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.purchase_review_tickets;old jsonb;state jsonb;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise insufficient_privilege using message='Review this financial action with its original account.';end if;
 select * into t from private.purchase_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current financial values again.';end if;
 if t.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='Use the original phone account.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 old:=private.inspect_purchase_outcome(t.command_id,t.type,t.outlet_id,t.original_hash);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 state:=private.purchase_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 if t.expires_at<=at_ms or sha256(convert_to(state->>'contextJson','UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed financial values changed. Review them again.';end if;
 return jsonb_build_object('done',false,'id',t.id,'replacementId',t.replacement_id,'commandId',t.command_id,'type',t.type,'occurredAt',t.occurred_at,'businessId',t.business_id,'outletId',t.outlet_id,'actorId',t.actor_id,'commandHash',t.original_hash,'sourceHash',t.source_hash,'sourceJsonHash',encode(sha256(convert_to(t.source_json,'UTF8')),'hex'),'savedCurrency',t.currency,'plan',t.plan,'token',secret,'at',t.created_at,'expiresAt',t.expires_at)||state;
end $$;


create function private.finish_purchase_review(review_id public.ulid,secret text,outcome text,replacement_ticket public.ulid,replacement_secret text,replacement_hash text,replacement_records jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t private.purchase_review_tickets;n private.purchase_write_tickets;old private.shop_command_receipts;state jsonb;after_state jsonb;at_ms public.utc_ms;metadata jsonb;applied jsonb;lock_id text;
begin
 if outcome is null or outcome not in ('withdrawn','replaced') or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise invalid_parameter_value using message='Choose the reviewed invoice outcome.';end if;
 select * into t from private.purchase_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current invoice values again.';end if;
 for lock_id in select x from unnest(array[t.command_id::text,t.replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for update;
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 select * into old from private.shop_command_receipts r where r.id=t.command_id;
 if found then
  if old.business_id<>t.business_id or old.outlet_id<>t.outlet_id or old.actor_id<>t.actor_id or old.auth_user_id<>t.auth_user_id or old.type<>t.type or old.request_hash<>t.original_hash then raise sqlstate 'PT409' using message='Keep the original invoice receipt.';end if;
  return old.receipt;
 end if;
 select * into t from private.purchase_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Review the current invoice values again.';end if;
 state:=private.purchase_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 if sha256(convert_to(state->>'contextJson','UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed invoice values changed. Review them again.';end if;
 if exists(select 1 from private.command_receipts r where r.id=t.command_id) or exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Keep the original invoice identity.';end if;
 if outcome='withdrawn' then
  if replacement_ticket is not null or replacement_secret is not null or replacement_hash is not null or replacement_records is not null and replacement_records<>'null'::jsonb then raise invalid_parameter_value using message='A withdrawal cannot record a replacement invoice.';end if;
 else
  if (state->>'selectionValid')::boolean is not true or (state->>'reserved')::boolean is true then raise sqlstate 'PT409' using message='Keep the original invoice source and parents.';end if;
  select * into n from private.purchase_write_tickets r where r.id=replacement_ticket and r.token_hash=sha256(convert_to(replacement_secret,'UTF8'));
  if not found or n.command_id<>t.replacement_id or n.business_id<>t.business_id or n.outlet_id<>t.outlet_id or n.actor_id<>t.actor_id or n.auth_user_id<>t.auth_user_id or n.type<>t.type or n.occurred_at<>t.occurred_at or n.request_hash<>replacement_hash or n.snapshot_hash<>t.snapshot_hash or n.plan<>t.plan then raise invalid_parameter_value using message='Keep the exact reviewed invoice identities.';end if;
  if replacement_records is null or jsonb_typeof(replacement_records) is distinct from 'array' or (select count(*) from jsonb_array_elements(replacement_records) item where item->>'table'='purchases')<>1
   or exists(select 1 from jsonb_array_elements(replacement_records) item where item->>'table'='purchases' and item->'values'->>'currency' is distinct from t.currency) then raise sqlstate 'PT409' using message='Keep the original saved invoice unit.';end if;
  applied:=private.finish_purchase_write(replacement_ticket,replacement_secret,replacement_records);
 end if;
 metadata:=jsonb_build_object('id',t.id,'type','command.resolved','commandId',t.command_id,'commandType',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'commandHash',t.original_hash,'sourceHash',t.source_hash,'at',at_ms,'outcome',outcome,'replacement',case when outcome='withdrawn' then null else jsonb_build_object('id',t.replacement_id,'commandHash',n.request_hash,'receipt',applied) end);
 after_state:=private.purchase_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,'sync.resolve',json_build_object('resolutionId',t.id,'commandId',t.command_id,'commandType',t.type,'commandHash',t.original_hash,'sourceHash',t.source_hash,'originalCommandJson',t.original_intent,'sourceJson',t.source_json,'purchaseBeforeJson',state->>'contextJson'),json_build_object('resolutionId',t.id,'outcome',outcome,'receipt',metadata,'replacementId',case when outcome='replaced' then t.replacement_id else null end,'purchaseAfterJson',after_state->>'contextJson'),at_ms);
 insert into private.purchase_command_resolutions values(t.id,t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.original_hash,t.source_hash,t.original_intent,t.source_json,outcome,case when outcome='replaced' then t.replacement_id else null end,private.purchase_review_new_ids(t.type,t.plan,t.command_id),metadata,at_ms);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.original_hash,metadata);
 delete from private.purchase_write_tickets r where r.command_id=t.command_id;
 return metadata;
end $$;

revoke all on function private.purchase_review_plan_valid(text,jsonb),private.purchase_review_new_ids(text,jsonb,public.ulid),private.assert_purchase_resolution_access(public.ulid,text,jsonb),private.reject_resolved_purchase_identity(),private.purchase_review_state(public.ulid,public.ulid,text,jsonb,public.ulid) from public,anon,authenticated,service_role;
revoke all on function private.inspect_purchase_outcome(public.ulid,text,public.ulid,text),private.prepare_purchase_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),private.read_purchase_review(public.ulid,text),private.finish_purchase_review(public.ulid,text,text,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.inspect_purchase_outcome(public.ulid,text,public.ulid,text),private.prepare_purchase_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),private.read_purchase_review(public.ulid,text) to authenticated;
grant execute on function private.finish_purchase_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;
create function public.inspect_purchase_outcome(p_command_id public.ulid,p_type text,p_outlet_id public.ulid,p_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.inspect_purchase_outcome(p_command_id,p_type,p_outlet_id,p_hash)$$;
create function public.prepare_purchase_review(p_id public.ulid,p_replacement_id public.ulid,p_command_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms,p_intent_json text,p_source_hash text,p_source_json text,p_saved_currency text) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_purchase_review(p_id,p_replacement_id,p_command_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at,p_intent_json,p_source_hash,p_source_json,p_saved_currency)$$;
create function public.read_purchase_review(p_id public.ulid,p_token text) returns jsonb language sql security invoker set search_path='' as $$select private.read_purchase_review(p_id,p_token)$$;
create function public.finish_purchase_review(p_id public.ulid,p_token text,p_outcome text,p_replacement_ticket public.ulid,p_replacement_token text,p_replacement_hash text,p_replacement_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_purchase_review(p_id,p_token,p_outcome,p_replacement_ticket,p_replacement_token,p_replacement_hash,p_replacement_records)$$;
create function public.admit_purchase_review(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_purchase_record(p_outlet_id)$$;
revoke all on function public.inspect_purchase_outcome(public.ulid,text,public.ulid,text),public.prepare_purchase_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),public.read_purchase_review(public.ulid,text),public.finish_purchase_review(public.ulid,text,text,public.ulid,text,text,jsonb),public.admit_purchase_review(public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.inspect_purchase_outcome(public.ulid,text,public.ulid,text),public.prepare_purchase_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),public.read_purchase_review(public.ulid,text),public.admit_purchase_review(public.ulid) to authenticated;
grant execute on function public.finish_purchase_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;

create or replace function private.finish_purchase_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
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
 perform private.assert_purchase_resolution_access(t.command_id,t.type,t.plan);
 if sha256(convert_to(private.purchase_write_context(t.business_id,t.outlet_id,t.plan)::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The invoice source changed. Prepare again.',detail='purchase_snapshot_changed';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
 is_supplier:=t.type like 'supplier.%';
 select * into before_supplier from public.suppliers s where s.business_id=t.business_id and s.outlet_id=t.outlet_id and s.id=t.plan->>'supplierId';
 select * into before_purchase from public.purchases p where p.business_id=t.business_id and p.outlet_id=t.outlet_id and p.id=t.plan->>'purchaseId';
 if is_supplier and t.type<>'supplier.create' and (before_supplier.id is null or (before_supplier.revision<(t.plan->>'revision')::bigint or before_supplier.revision>=9007199254740991)) then raise sqlstate 'PT409' using message='Review the latest supplier revision.';end if;
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
    or (v->>'created_at')::bigint is distinct from coalesce(before_supplier.created_at,t.occurred_at) or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(before_supplier.created_at,t.occurred_at),coalesce(before_supplier.updated_at,t.occurred_at))
    or (v->>'archived_at')::bigint is distinct from (case when t.type='supplier.archive' then coalesce(before_supplier.archived_at,t.occurred_at) when t.type='supplier.restore' then null else before_supplier.archived_at end)
    or t.type in ('supplier.archive','supplier.restore') and (v->>'name' is distinct from before_supplier.name::text or v->>'phone' is distinct from before_supplier.phone or v->>'note' is distinct from before_supplier.note::text) then raise invalid_parameter_value using message='Invalid supplier mutation.';end if;
  elsif table_name='purchases' then
   if is_supplier or v->>'id' is distinct from t.plan->>'purchaseId' or v->>'supplier_id' is distinct from expected_supplier
    or (v->>'created_at')::bigint is distinct from coalesce(before_purchase.created_at,t.occurred_at) or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(before_purchase.created_at,t.occurred_at),coalesce(before_purchase.updated_at,t.occurred_at)) then raise invalid_parameter_value using message='Invalid invoice identity or clock.';end if;
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
