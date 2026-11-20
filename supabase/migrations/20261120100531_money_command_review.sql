-- Financial reviews retain the original intent and source. A withdrawal is an
-- audit outcome, never a fabricated sale/payment. Only the service may finish.
create table private.money_review_tickets (
 id public.ulid primary key,command_id public.ulid not null,replacement_id public.ulid not null,
 business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 type text not null,original_hash text not null check(original_hash~'^[0-9a-f]{64}$'),source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),currency text not null check(currency~'^[A-Z]{3}$'),
 plan jsonb not null,original_intent text not null,source_json text not null,occurred_at public.utc_ms not null,
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null check(octet_length(token_hash)=32),
 created_at public.utc_ms not null,expires_at public.utc_ms not null,
 check(id<>command_id and id<>replacement_id and command_id<>replacement_id),
 check(octet_length(original_intent)<=2000000 and octet_length(source_json)<=4000000)
);
create index money_review_tickets_actor_idx on private.money_review_tickets(auth_user_id,expires_at);
create table private.money_command_resolutions (
 id public.ulid primary key,command_id public.ulid not null unique,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,original_hash text not null,source_hash text not null,
 original_intent text not null,source_json text not null,outcome text not null check(outcome in ('withdrawn','replaced')),
 replacement_id public.ulid,reserved_ids public.ulid[] not null,receipt jsonb not null,created_at public.utc_ms not null,
 check((outcome='withdrawn')=(replacement_id is null))
);
create index money_command_resolutions_reserved_idx on private.money_command_resolutions using gin(reserved_ids);
alter table private.money_review_tickets enable row level security;
alter table private.money_review_tickets force row level security;
alter table private.money_command_resolutions enable row level security;
alter table private.money_command_resolutions force row level security;
revoke all on private.money_review_tickets,private.money_command_resolutions from public,anon,authenticated,service_role;

-- Keep literal commands/sources opaque, as in the original order protocol.
-- PostgreSQL json operators can reject escaped NUL/lone-surrogate text even
-- while selecting another field. The trusted formatter verifies these bindings
-- against the normalized command hash and independently parsed original source.
create function private.money_review_plan_valid(kind text,ids jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 if kind is null or kind not in ('sale.record','sale.credit','sale.undo','khata.payment','khata.undo') or jsonb_typeof(ids) is distinct from 'object' then return false;end if;
 if (select count(*) from jsonb_object_keys(ids))<>6 or exists(select 1 from jsonb_object_keys(ids) key where key not in ('saleId','accountId','entryId','reversalId','creditEventId','itemIds')) or jsonb_typeof(ids->'itemIds') is distinct from 'array' then return false;end if;
 if jsonb_array_length(ids->'itemIds')>200 or exists(select 1 from jsonb_array_elements(ids->'itemIds') item where jsonb_typeof(item)<>'string' or item#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  or exists(select 1 from jsonb_each(ids) entry where entry.key<>'itemIds' and entry.value<>'null' and (jsonb_typeof(entry.value)<>'string' or entry.value#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')) then return false;end if;
 if ((kind in ('sale.record','sale.credit','sale.undo'))<>(ids->>'saleId' is not null)) or ((kind in ('sale.credit','khata.payment'))<>(ids->>'accountId' is not null)) or ((kind='khata.undo')<>(ids->>'reversalId' is not null))
  or (kind='sale.record' and (ids->>'entryId' is not null or ids->>'creditEventId' is not null)) or (kind in ('sale.credit','khata.payment','khata.undo') and ids->>'entryId' is null)
  or (kind='sale.credit' and ids->>'creditEventId' is null) or (kind not in ('sale.credit','sale.undo') and ids->>'creditEventId' is not null) or (kind='sale.undo' and ((ids->>'entryId' is null)<>(ids->>'creditEventId' is null)))
  or (kind not in ('sale.record','sale.credit') and jsonb_array_length(ids->'itemIds')<>0) then return false;end if;
 return true;
end $$;
-- Reserve new financial/audit IDs across every writer, including other command
-- families and bulk admission. A legitimate reviewed replacement inserts before
-- its own resolution is recorded; ordinary retries read the genuine receipt.
create function private.reject_resolved_money_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.money_command_resolutions r where r.reserved_ids@>array[new.id]) then raise sqlstate 'PT409' using message='Keep the original resolved financial identities.';end if;
 return new;
end $$;
revoke all on function private.reject_resolved_money_identity() from public,anon,authenticated,service_role;
create trigger resolved_money_sale_identity before insert on public.sales for each row execute function private.reject_resolved_money_identity();
create trigger resolved_money_entry_identity before insert on public.credit_entries for each row execute function private.reject_resolved_money_identity();
create trigger resolved_money_event_identity before insert on public.events for each row execute function private.reject_resolved_money_identity();
create function private.money_review_new_ids(kind text,ids jsonb,command_id public.ulid) returns public.ulid[]
language sql immutable security invoker set search_path='' as $$
 select array_remove(array[command_id,
  case when kind in ('sale.record','sale.credit') then (ids->>'saleId')::public.ulid end,
  case when kind in ('sale.credit','khata.payment','sale.undo') then (ids->>'entryId')::public.ulid when kind='khata.undo' then (ids->>'reversalId')::public.ulid end,
  (ids->>'creditEventId')::public.ulid],null)
$$;
create function private.assert_money_resolution_access(command_id public.ulid,kind text,ids jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from private.money_command_resolutions r where r.command_id=assert_money_resolution_access.command_id or r.reserved_ids&&private.money_review_new_ids(kind,ids,assert_money_resolution_access.command_id)) then
  raise sqlstate 'PT409' using message='Keep the original financial resolution and reserved identities.';
 end if;
end $$;
create function private.money_review_state(business public.ulid,outlet public.ulid,kind text,ids jsonb,command_id public.ulid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare original public.sales;source public.credit_entries;customer public.ulid;account public.ulid;target public.ulid;valid boolean:=true;context json;
begin
 if kind='sale.undo' then
  select * into original from public.sales s where s.business_id=business and s.outlet_id=outlet and s.id=ids->>'saleId';
  valid:=found and original.order_id is null;
  if original.method='credit' then
   account:=original.credit_account_id;
   select * into source from public.credit_entries e where e.business_id=business and e.outlet_id=outlet and e.sale_id=original.id and e.type='charge' order by e.id limit 1;
   target:=source.id;valid:=valid and source.id is not null and (select count(*) from public.credit_entries e where e.business_id=business and e.outlet_id=outlet and e.sale_id=original.id and e.type='charge')=1;
  end if;
 elsif kind='khata.undo' then
  select * into source from public.credit_entries e where e.business_id=business and e.outlet_id=outlet and e.id=ids->>'entryId';
  account:=source.account_id;target:=source.id;valid:=found and source.sale_id is null and source.order_id is null and source.refund_id is null and source.returns_charge_id is null;
 else
  account:=(ids->>'accountId')::public.ulid;
 end if;
 if account is not null then
  select a.customer_id into customer from public.credit_accounts a where a.business_id=business and a.outlet_id=outlet and a.id=account
   and exists(select 1 from public.customer_outlets c where c.business_id=business and c.outlet_id=outlet and c.customer_id=a.customer_id);
  if not found then account:=null;target:=null;valid:=false;end if;
 elsif kind in ('sale.credit','khata.payment','khata.undo') then valid:=false;
 end if;
 if kind in ('sale.record','sale.credit') and exists(select 1 from public.sales s where s.id=ids->>'saleId') then valid:=false;end if;
 if kind in ('sale.credit','khata.payment','sale.undo') and exists(select 1 from public.credit_entries e where e.id=ids->>'entryId') or kind='khata.undo' and exists(select 1 from public.credit_entries e where e.id=ids->>'reversalId')
  or exists(select 1 from public.events e where e.id=ids->>'creditEventId') then valid:=false;end if;
 context:=private.money_write_context(business,outlet,customer,account,(ids->>'saleId')::public.ulid,target,ids->'itemIds');
 return jsonb_build_object('contextJson',context::text,'selectionValid',valid,'reserved',exists(select 1 from private.money_command_resolutions r where r.reserved_ids&&private.money_review_new_ids(kind,ids,money_review_state.command_id)));
end $$;
create function private.inspect_money_outcome(command_id public.ulid,kind text,outlet public.ulid,fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;r private.shop_command_receipts;
begin
 if command_id is null or outlet is null or kind is null or kind not in ('sale.record','sale.credit','sale.undo','khata.payment','khata.undo') or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Keep the original financial identity.';end if;
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);
 select * into r from private.shop_command_receipts x where x.id=command_id;
 if not found then return null;end if;
 if r.business_id<>business or r.outlet_id<>outlet or r.actor_id<>actor or r.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This financial action is unavailable.';end if;
 if r.type<>kind or r.request_hash<>fingerprint then raise sqlstate 'PT409' using message='Keep the original financial identity.';end if;
 return r.receipt;
end $$;
create function private.prepare_money_review(review_id public.ulid,replacement_id public.ulid,command_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms,intent_json text,source_hash text,source_json text,saved_currency text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old jsonb;t private.money_review_tickets;state jsonb;secret text;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null or review_id is null or replacement_id is null or command_id is null or outlet is null or occurred is null or review_id=command_id or review_id=replacement_id or command_id=replacement_id
  or kind is null or kind not in ('sale.record','sale.credit','sale.undo','khata.payment','khata.undo') or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or source_hash is null or source_hash!~'^[0-9a-f]{64}$'
  or intent_json is null or octet_length(intent_json)>2000000 or source_json is null or octet_length(source_json)>4000000
  or private.money_review_plan_valid(kind,ids) is not true or encode(sha256(convert_to(intent_json,'UTF8')),'hex')<>fingerprint or saved_currency is null or saved_currency!~'^[A-Z]{3}$'
 then raise invalid_parameter_value using message='Keep the complete original financial action and source.';end if;
 old:=private.inspect_money_outcome(command_id,kind,outlet,fingerprint);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 perform 1 from public.businesses b where b.id=business for update;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 old:=private.inspect_money_outcome(command_id,kind,outlet,fingerprint);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 if exists(select 1 from private.command_receipts r where r.id=command_id) or exists(select 1 from public.events e where e.id=command_id) then raise sqlstate 'PT409' using message='Keep the original financial identity.';end if;
 select * into t from private.money_review_tickets r where r.id=review_id;
 if found and (t.command_id<>command_id or t.replacement_id<>replacement_id or t.auth_user_id<>(select auth.uid()) or t.actor_id<>actor or t.original_hash<>fingerprint or t.source_hash<>source_hash or t.source_json<>source_json or t.plan<>ids or t.original_intent<>intent_json or t.currency<>saved_currency or t.occurred_at<>occurred) then raise sqlstate 'PT409' using message='Keep the original selected financial review.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from private.money_review_tickets r where r.auth_user_id=(select auth.uid()) and (r.expires_at<=at_ms or r.id=review_id);
 if (select count(*) from private.money_review_tickets r where r.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Finish an existing financial review first.';end if;
 state:=private.money_review_state(business,outlet,kind,ids,command_id);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.money_review_tickets values(review_id,command_id,replacement_id,business,outlet,actor,(select auth.uid()),kind,fingerprint,source_hash,saved_currency,ids,intent_json,source_json,occurred,sha256(convert_to(state->>'contextJson','UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+120000);
 return jsonb_build_object('done',false,'id',review_id,'replacementId',replacement_id,'commandId',command_id,'type',kind,'occurredAt',occurred,'businessId',business,'outletId',outlet,'actorId',actor,'commandHash',fingerprint,'sourceHash',source_hash,'sourceJsonHash',encode(sha256(convert_to(source_json,'UTF8')),'hex'),'savedCurrency',saved_currency,'plan',ids,'token',secret,'at',at_ms,'expiresAt',at_ms+120000)||state;
end $$;
create function private.read_money_review(review_id public.ulid,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.money_review_tickets;old jsonb;state jsonb;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise insufficient_privilege using message='Review this financial action with its original account.';end if;
 select * into t from private.money_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current financial values again.';end if;
 if t.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='Use the original phone account.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 old:=private.inspect_money_outcome(t.command_id,t.type,t.outlet_id,t.original_hash);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 state:=private.money_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 if t.expires_at<=at_ms or sha256(convert_to(state->>'contextJson','UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed financial values changed. Review them again.';end if;
 return jsonb_build_object('done',false,'id',t.id,'replacementId',t.replacement_id,'commandId',t.command_id,'type',t.type,'occurredAt',t.occurred_at,'businessId',t.business_id,'outletId',t.outlet_id,'actorId',t.actor_id,'commandHash',t.original_hash,'sourceHash',t.source_hash,'sourceJsonHash',encode(sha256(convert_to(t.source_json,'UTF8')),'hex'),'savedCurrency',t.currency,'plan',t.plan,'token',secret,'at',t.created_at,'expiresAt',t.expires_at)||state;
end $$;
create function private.finish_money_review(review_id public.ulid,secret text,outcome text,confirm_credit boolean,confirmation jsonb,replacement_ticket public.ulid,replacement_secret text,replacement_hash text,replacement_records jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t private.money_review_tickets;n private.money_write_tickets;old private.shop_command_receipts;state jsonb;after_state jsonb;at_ms public.utc_ms;metadata jsonb;applied jsonb;lock_id text;balance numeric;credit_limit numeric;charge numeric;over_limit boolean;
begin
 if outcome is null or outcome not in ('withdrawn','replaced') or confirm_credit is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise invalid_parameter_value using message='Choose the reviewed financial outcome.';end if;
 select * into t from private.money_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current financial values again.';end if;
 for lock_id in select x from unnest(array[t.command_id::text,t.replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for update;
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 select * into old from private.shop_command_receipts r where r.id=t.command_id;
 if found then
  if old.business_id<>t.business_id or old.outlet_id<>t.outlet_id or old.actor_id<>t.actor_id or old.auth_user_id<>t.auth_user_id or old.type<>t.type or old.request_hash<>t.original_hash then raise sqlstate 'PT409' using message='Keep the original financial receipt.';end if;
  return old.receipt;
 end if;
 select * into t from private.money_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Review the current financial values again.';end if;
 state:=private.money_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 if sha256(convert_to(state->>'contextJson','UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed financial values changed. Review them again.';end if;
 if exists(select 1 from private.command_receipts r where r.id=t.command_id) or exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Keep the original financial identity.';end if;
 if outcome='withdrawn' then
  if confirm_credit or confirmation is not null and confirmation<>'null'::jsonb or replacement_ticket is not null or replacement_secret is not null or replacement_hash is not null or replacement_records is not null and replacement_records<>'null'::jsonb then raise invalid_parameter_value using message='A withdrawal cannot record replacement money.';end if;
 else
  if (state->>'selectionValid')::boolean is not true or (state->>'reserved')::boolean is true then raise sqlstate 'PT409' using message='Keep the original financial source and parents.';end if;
  select * into n from private.money_write_tickets r where r.id=replacement_ticket and r.token_hash=sha256(convert_to(replacement_secret,'UTF8'));
  if not found or n.command_id<>t.replacement_id or n.business_id<>t.business_id or n.outlet_id<>t.outlet_id or n.actor_id<>t.actor_id or n.auth_user_id<>t.auth_user_id or n.type<>t.type or n.occurred_at<>t.occurred_at or n.request_hash<>replacement_hash or n.snapshot_hash<>t.snapshot_hash or n.plan<>t.plan then raise invalid_parameter_value using message='Keep the exact reviewed financial identities.';end if;
  if replacement_records is null or jsonb_typeof(replacement_records) is distinct from 'array' or exists(select 1 from jsonb_array_elements(replacement_records) item where item->>'table' in ('sales','credit_entries') and item->'values'->>'currency' is distinct from t.currency) then raise sqlstate 'PT409' using message='Keep the original saved monetary unit.';end if;
  if t.type='sale.credit' then
   select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0) into balance from public.credit_entries e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.account_id=n.account_id;
   select a.credit_limit into credit_limit from public.credit_accounts a where a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.id=n.account_id;
   select (r->'values'->>'amount')::numeric into charge from jsonb_array_elements(replacement_records) r where r->>'table'='sales';
   over_limit:=balance+charge>credit_limit;
   if over_limit then
    if not confirm_credit or confirmation is null or jsonb_typeof(confirmation) is distinct from 'object' or (select count(*) from jsonb_object_keys(confirmation))<>2 or jsonb_typeof(confirmation->'balance') is distinct from 'number' or jsonb_typeof(confirmation->'limit') is distinct from 'number' or confirmation->>'balance' is distinct from balance::text or confirmation->>'limit' is distinct from credit_limit::text then raise invalid_parameter_value using message='Explicitly confirm the exact current credit balance and limit.';end if;
   elsif confirm_credit or confirmation is not null and confirmation<>'null'::jsonb then raise invalid_parameter_value using message='Credit consent must match the actual reviewed limit.';end if;
  elsif confirm_credit or confirmation is not null and confirmation<>'null'::jsonb then raise invalid_parameter_value using message='This action has no credit override.';end if;
  applied:=private.finish_money_write(replacement_ticket,replacement_secret,t.occurred_at,replacement_records);
 end if;
 metadata:=jsonb_build_object('id',t.id,'type','command.resolved','commandId',t.command_id,'commandType',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'commandHash',t.original_hash,'sourceHash',t.source_hash,'at',at_ms,'outcome',outcome,'replacement',case when outcome='withdrawn' then null else jsonb_build_object('id',t.replacement_id,'commandHash',n.request_hash,'confirmation',confirmation,'receipt',applied) end);
 after_state:=private.money_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,customer_id)
 values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,'sync.resolve',json_build_object('resolutionId',t.id,'commandId',t.command_id,'commandType',t.type,'commandHash',t.original_hash,'sourceHash',t.source_hash,'originalCommandJson',t.original_intent,'sourceJson',t.source_json,'moneyBeforeJson',state->>'contextJson'),json_build_object('resolutionId',t.id,'outcome',outcome,'receipt',metadata,'replacementId',case when outcome='replaced' then t.replacement_id else null end,'moneyAfterJson',after_state->>'contextJson'),at_ms,case when outcome='replaced' then n.customer_id else null end);
 insert into private.money_command_resolutions values(t.id,t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.original_hash,t.source_hash,t.original_intent,t.source_json,outcome,case when outcome='replaced' then t.replacement_id else null end,private.money_review_new_ids(t.type,t.plan,t.command_id),metadata,at_ms);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,case when outcome='replaced' then n.customer_id else null end,t.original_hash,metadata);
 delete from private.money_write_tickets r where r.command_id=t.command_id;
 return metadata;
end $$;

revoke all on function private.money_review_plan_valid(text,jsonb),private.money_review_new_ids(text,jsonb,public.ulid),private.assert_money_resolution_access(public.ulid,text,jsonb),private.money_review_state(public.ulid,public.ulid,text,jsonb,public.ulid) from public,anon,authenticated,service_role;
revoke all on function private.inspect_money_outcome(public.ulid,text,public.ulid,text),private.prepare_money_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),private.read_money_review(public.ulid,text),private.finish_money_review(public.ulid,text,text,boolean,jsonb,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.inspect_money_outcome(public.ulid,text,public.ulid,text),private.prepare_money_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),private.read_money_review(public.ulid,text) to authenticated;
grant execute on function private.finish_money_review(public.ulid,text,text,boolean,jsonb,public.ulid,text,text,jsonb) to service_role;
create function public.inspect_money_outcome(p_command_id public.ulid,p_type text,p_outlet_id public.ulid,p_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.inspect_money_outcome(p_command_id,p_type,p_outlet_id,p_hash)$$;
create function public.prepare_money_review(p_id public.ulid,p_replacement_id public.ulid,p_command_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms,p_intent_json text,p_source_hash text,p_source_json text,p_saved_currency text) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_money_review(p_id,p_replacement_id,p_command_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at,p_intent_json,p_source_hash,p_source_json,p_saved_currency)$$;
create function public.read_money_review(p_id public.ulid,p_token text) returns jsonb language sql security invoker set search_path='' as $$select private.read_money_review(p_id,p_token)$$;
create function public.finish_money_review(p_id public.ulid,p_token text,p_outcome text,p_confirm_credit boolean,p_confirmation jsonb,p_replacement_ticket public.ulid,p_replacement_token text,p_replacement_hash text,p_replacement_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_money_review(p_id,p_token,p_outcome,p_confirm_credit,p_confirmation,p_replacement_ticket,p_replacement_token,p_replacement_hash,p_replacement_records)$$;
revoke all on function public.inspect_money_outcome(public.ulid,text,public.ulid,text),public.prepare_money_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),public.read_money_review(public.ulid,text),public.finish_money_review(public.ulid,text,text,boolean,jsonb,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.inspect_money_outcome(public.ulid,text,public.ulid,text),public.prepare_money_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,text),public.read_money_review(public.ulid,text) to authenticated;
grant execute on function public.finish_money_review(public.ulid,text,text,boolean,jsonb,public.ulid,text,text,jsonb) to service_role;
create function private.admit_money_review(outlet public.ulid) returns boolean language plpgsql security definer set search_path='' as $$
declare business public.ulid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 perform private.public_link_actor(business,outlet);return true;
end $$;
revoke all on function private.admit_money_review(public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.admit_money_review(public.ulid) to authenticated;
create function public.admit_money_review(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_money_review(p_outlet_id)$$;
revoke all on function public.admit_money_review(public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.admit_money_review(public.ulid) to authenticated;

-- A prepared ordinary writer cannot revive a resolved intent or reuse its new
-- financial identities after another transaction withdraws it. Keep all prior
-- mutation validation and actual clocks; check after the shared outlet lock.
create or replace function private.finish_money_write(ticket_id public.ulid,secret text,occurred public.utc_ms,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.money_write_tickets;r jsonb;v jsonb;allowed jsonb;table_name text;keys text;casts text;at_ms public.utc_ms;
 original public.sales;sale public.sales;target public.credit_entries;entry public.credit_entries;
 sale_count int;entry_count int;event_count int;has_credit boolean;balance numeric;metadata jsonb;expected_entry text;expected_audit text;
 specs jsonb:='{"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare again.';end if;
 select * into t from private.money_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Prepare again.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for update;
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 select * into t from private.money_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms or occurred is distinct from t.occurred_at then raise sqlstate 'PT409' using message='Prepare again.';end if;
 perform private.assert_money_resolution_access(t.command_id,t.type,t.plan);
 if sha256(convert_to(private.money_write_context(t.business_id,t.outlet_id,t.customer_id,t.account_id,(t.plan->>'saleId')::public.ulid,t.target_entry_id,t.plan->'itemIds')::text,'UTF8'))<>t.snapshot_hash then
  raise sqlstate 'PT409' using message='Money records changed. Prepare again.',detail='money_snapshot_changed';end if;
 if t.account_id is not null and not exists(select 1 from public.customer_outlets a where a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.customer_id=t.customer_id) then raise insufficient_privilege using message='This khata is unavailable.';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
 select * into original from public.sales s where s.id=t.plan->>'saleId';
 select * into target from public.credit_entries e where e.id=t.target_entry_id;
 has_credit:=t.type='sale.credit' or (t.type='sale.undo' and original.method='credit');
 if t.type='sale.undo' and (original.order_id is not null or original.closing_id is not null or original.voided_at is not null or at_ms<original.created_at or at_ms-original.created_at>600000 or occurred<original.created_at) then raise sqlstate 'PT409' using message='This receipt cannot be undone.';end if;
 if t.type in ('sale.undo','khata.undo') and t.target_entry_id is not null and
  (target.reversal_of is not null or target.type='reminder' or at_ms<target.created_at or at_ms-target.created_at>600000 or occurred<target.created_at
   or exists(select 1 from public.credit_entries e where e.account_id=t.account_id and e.reversal_of=target.id)) then raise sqlstate 'PT409' using message='This entry cannot be undone.';end if;
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 2 and 4 or octet_length(records::text)>512000 then raise invalid_parameter_value using message='Invalid money mutation.';end if;
 select count(*) filter(where x->>'table'='sales'),count(*) filter(where x->>'table'='credit_entries'),count(*) filter(where x->>'table'='events') into sale_count,entry_count,event_count from jsonb_array_elements(records) x;
 if sale_count<>(case when t.type like 'sale.%' then 1 else 0 end) or entry_count<>(case when has_credit or t.type like 'khata.%' then 1 else 0 end)
  or event_count<>(case when has_credit then 2 else 1 end) or sale_count+entry_count+event_count<>jsonb_array_length(records) then raise invalid_parameter_value using message='Invalid money mutation shape.';end if;
 expected_entry:=case when t.type='khata.undo' then t.plan->>'reversalId' else t.plan->>'entryId' end;
 select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0) into balance from public.credit_entries e where e.account_id=t.account_id;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if allowed is null or jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed)
   or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid money record fields.';end if;
  if table_name='sales' then
   if v->>'id' is distinct from t.plan->>'saleId' then raise invalid_parameter_value using message='Invalid sale identity.';end if;
   if t.type='sale.undo' then
    if (v->>'voided_at')::bigint is distinct from occurred::bigint or v->>'void_reason'<>'undo' then raise invalid_parameter_value using message='Invalid sale reversal.';end if;
    update public.sales s set voided_at=occurred,void_reason='undo',updated_at=greatest(t.created_at,s.created_at,occurred) where s.id=original.id;
    continue;
   end if;
   if v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.command_id::text or (v->>'created_at')::bigint is distinct from occurred::bigint
    or v->>'currency' is distinct from (select o.currency from public.outlets o where o.id=t.outlet_id)
    or (v->>'amount')::numeric<=0 or ((v->>'method'='credit') is distinct from has_credit)
    or v->>'customer_id' is distinct from t.customer_id::text or v->>'credit_account_id' is distinct from t.account_id::text
    or exists(select 1 from unnest(array['order_id','order_number','closing_id','delivery_fee','discount','voided_at','void_reason']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid counter sale.';end if;
   v:=jsonb_set(v,'{updated_at}',to_jsonb(greatest(t.created_at,occurred)));
  elsif table_name='credit_entries' then
   expected_audit:=case when has_credit then t.plan->>'creditEventId' else t.command_id::text end;
   if v->>'id' is distinct from expected_entry or v->>'event_id' is distinct from expected_audit
    or v->>'account_id' is distinct from t.account_id::text or v->>'customer_id' is distinct from t.customer_id::text
    or v->>'created_by' is distinct from t.actor_id::text or (v->>'created_at')::bigint is distinct from occurred::bigint
    or v->>'currency' is distinct from (select a.currency from public.credit_accounts a where a.id=t.account_id)
    or (v->>'sequence')::bigint is distinct from (select coalesce(max(e.sequence),0)+1 from public.credit_entries e where e.account_id=t.account_id)
    or exists(select 1 from unnest(array['order_id','refund_id','returns_charge_id','occurred_at']) k where v->>k is not null)
    or (t.type='sale.credit' and (v->>'type'<>'charge' or v->>'sale_id' is distinct from t.plan->>'saleId' or (v->>'amount')::numeric is distinct from
      (select (x->'values'->>'amount')::numeric from jsonb_array_elements(records) x where x->>'table'='sales')))
    or (t.type<>'sale.credit' and v->>'sale_id' is not null)
    or (t.type='khata.payment' and (v->>'type'<>'payment' or (v->>'amount')::numeric<=0 or (v->>'amount')::numeric>balance))
    or (t.type='khata.communication' and (v->>'type'<>'reminder' or (v->>'amount')::numeric<>0))
    or (t.type in ('sale.undo','khata.undo') and (v->>'type'<>'adjustment' or v->>'reversal_of' is distinct from target.id::text
      or (v->>'amount')::numeric is distinct from (case when target.type='payment' then target.amount else -target.amount end)
      or balance+(v->>'amount')::numeric<0))
    or (t.type not in ('sale.undo','khata.undo') and v->>'reversal_of' is not null) then raise invalid_parameter_value using message='Invalid khata entry.';end if;
   v:=jsonb_set(v,'{updated_at}',to_jsonb(greatest(t.created_at,occurred)));
  else
   if v->>'actor_type'<>'member' or v->>'actor_id' is distinct from t.actor_id::text or v->>'customer_id' is distinct from t.customer_id::text
    or exists(select 1 from unnest(array['order_id','order_revision','stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null)
    or (v->>'id'=t.command_id and not (v->>'command'=t.type or (t.type='sale.credit' and v->>'command'='sale.record') or (t.type='khata.communication' and v->>'command' in ('khata.reminder-sent','khata.receipt-sent','khata.call-sent'))))
    or (v->>'id'<>t.command_id and (not has_credit or v->>'id' is distinct from t.plan->>'creditEventId' or v->>'command'<>(case when t.type='sale.credit' then 'khata.charge' else 'khata.undo' end)))
    or v->>'undo_of' is distinct from (case when t.type='khata.undo' or (t.type='sale.undo' and v->>'id'<>t.command_id) then target.event_id::text when t.type='sale.undo' then original.event_id::text else null end) then raise invalid_parameter_value using message='Invalid money audit.';end if;
   v:=jsonb_set(v,'{at}',to_jsonb(t.created_at));
  end if;
  select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key) into keys,casts
   from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
  execute format('insert into public.%I(%s) select %s',table_name,keys,casts) using v;
 end loop;
 if not exists(select 1 from public.events e where e.id=t.command_id and e.business_id=t.business_id and e.outlet_id=t.outlet_id) then raise invalid_parameter_value using message='Missing primary audit.';end if;
 select * into sale from public.sales s where s.id=t.plan->>'saleId';
 select * into entry from public.credit_entries e where e.id=expected_entry;
 metadata:=jsonb_build_object('id',t.command_id,'occurredAt',occurred,'type',t.type,'outletId',t.outlet_id,'saleId',sale.id,'accountId',t.account_id,
  'entryId',entry.id,'amount',case when t.type='sale.undo' then -sale.amount when sale.id is not null then sale.amount else entry.amount end,
  'at',t.created_at,'saleUpdatedAt',sale.updated_at,'entrySequence',entry.sequence,'undoOf',case when t.type='sale.undo' then sale.id when t.type='khata.undo' then target.id else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt)
  values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.customer_id,t.request_hash,metadata);
 delete from private.money_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;
