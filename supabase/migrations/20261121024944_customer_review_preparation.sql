-- Customer review preparation is read-only with respect to shop data. Completion
-- is a separate service-only transaction; these tickets never grant raw writes.
create table private.customer_review_tickets (
 id public.ulid primary key,command_id public.ulid not null,replacement_id public.ulid not null,
 business_id public.ulid not null,outlet_id public.ulid not null,customer_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,
 type text not null check(type in('customer.create','customer.update','customer.archive','customer.restore','khata.settings')),
 account_id public.ulid,ids jsonb,facts jsonb not null,
 original_hash text not null check(original_hash~'^[0-9a-f]{64}$'),source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),
 original_intent text not null check(octet_length(original_intent)<=32000),source_json text not null check(octet_length(source_json)<=4000000),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null check(octet_length(token_hash)=32),
 created_at public.utc_ms not null,expires_at public.utc_ms not null,
 check(id<>command_id and id<>replacement_id and command_id<>replacement_id)
);
create index customer_review_tickets_actor_idx on private.customer_review_tickets(auth_user_id,expires_at);
create table private.customer_command_resolutions (
 id public.ulid primary key,command_id public.ulid not null unique,replacement_id public.ulid,
 business_id public.ulid not null,outlet_id public.ulid not null,customer_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null,
 original_hash text not null,source_hash text not null,original_intent text not null,source_json text not null,
 ids jsonb,facts jsonb not null,reserved_ids public.ulid[] not null,
 outcome text not null check(outcome in('withdrawn','replaced')),receipt jsonb not null,created_at public.utc_ms not null,
 position bigint generated always as identity unique,check((outcome='withdrawn')=(replacement_id is null))
);
create index customer_command_resolutions_reserved_idx on private.customer_command_resolutions using gin(reserved_ids);
alter table private.customer_review_tickets enable row level security;
alter table private.customer_review_tickets force row level security;
alter table private.customer_command_resolutions enable row level security;
alter table private.customer_command_resolutions force row level security;
revoke all on private.customer_review_tickets,private.customer_command_resolutions from public,anon,authenticated,service_role;
revoke all on sequence private.customer_command_resolutions_position_seq from public,anon,authenticated,service_role;

create function private.customer_review_plan_valid(kind text,customer public.ulid,outlet public.ulid,command_id public.ulid,account public.ulid,ids jsonb,intent_json text,facts jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare a jsonb;entry jsonb;status boolean;prefix text;ids_json text;suffix text;opening_json text;
begin
 if kind is null or kind not in('customer.create','customer.update','customer.archive','customer.restore','khata.settings') or customer is null or outlet is null or command_id is null or intent_json is null or octet_length(intent_json)>32000
  or left(intent_json,length('{"id":"'||command_id::text||'",'))<>'{"id":"'||command_id::text||'",' then return false;end if;
 status:=kind in('customer.archive','customer.restore');
 -- Even a json field lookup decodes unrelated NUL/surrogate strings. Bind the
 -- ordinary codec's fixed envelope and scalar suffix without parsing the input.
 -- The authenticated gateway independently validates the whole normalized
 -- command and source before using any ticket for service-only completion.
 prefix:='{"id":"'||command_id::text||'","customerId":"'||customer::text||'","outletId":"'||outlet::text||'","type":"'||kind||'"';
 if left(intent_json,length(prefix))<>prefix then return false;end if;
 if status then
  if intent_json<>prefix||'}' or ids is not null or account is not null then return false;end if;
 else
  if kind<>'khata.settings' and account is not null then return false;end if;
  if kind='khata.settings' then
   prefix:=prefix||',"accountId":'||case when account is null then 'null' else '"'||account::text||'"' end;
  end if;
  if left(intent_json,length(prefix||',"input":{'))<>prefix||',"input":{' then return false;end if;
 end if;
 if not status then
  if jsonb_typeof(ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(ids))<>4
   or exists(select 1 from jsonb_object_keys(ids) k where k not in('accountId','accountEventId','openingEntryId','openingEventId'))
   or exists(select 1 from jsonb_each(ids) e where jsonb_typeof(e.value)<>'string' or e.value#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
   or (select count(distinct x) from (select e.value#>>'{}' x from jsonb_each(ids) e union all select command_id::text union all select customer::text) q)<>6
   or (account is not null and account::text is distinct from ids->>'accountId') then return false;end if;
  ids_json:='{"accountId":"'||(ids->>'accountId')||'","accountEventId":"'||(ids->>'accountEventId')||'","openingEntryId":"'||(ids->>'openingEntryId')||'","openingEventId":"'||(ids->>'openingEventId')||'"}';
  suffix:=',"ids":'||ids_json||'}';
  if right(intent_json,length(suffix))<>suffix then return false;end if;
 end if;
 if jsonb_typeof(facts) is distinct from 'object' or (select count(*) from jsonb_object_keys(facts))<>7
  or exists(select 1 from jsonb_object_keys(facts) k where k not in('businessId','actorId','at','phone','profile','account','opening'))
  or exists(select 1 from unnest(array['businessId','actorId']) k where jsonb_typeof(facts->k) is distinct from 'string' or facts->>k!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  or jsonb_typeof(facts->'at') is distinct from 'number' or (facts->>'at')::numeric not between 0 and 8640000000000000 or (facts->>'at')::numeric<>trunc((facts->>'at')::numeric)
  or facts->'phone' is null or facts->'phone'<>'null' and (jsonb_typeof(facts->'phone')<>'string' or facts->>'phone'!~'^\+[1-9][0-9]{6,14}$') then return false;end if;
 if kind in('customer.create','customer.update') then
  if jsonb_typeof(facts->'profile') is distinct from 'object' or (select count(*) from jsonb_object_keys(facts->'profile'))<>5
   or exists(select 1 from jsonb_object_keys(facts->'profile') k where k not in('nameJson','nicknameJson','addressJson','notesJson','tagsJson'))
   or exists(select 1 from jsonb_each(facts->'profile') e where jsonb_typeof(e.value)<>'string' or octet_length(e.value#>>'{}')>32000 or left(e.value#>>'{}',1)<>case when e.key='tagsJson' then '[' else '"' end or right(e.value#>>'{}',1)<>case when e.key='tagsJson' then ']' else '"' end) then return false;end if;
 elsif facts->'profile' is distinct from 'null'::jsonb then return false;end if;
 a:=facts->'account';entry:=facts->'opening';
 if a is null or entry is null or status and (a<>'null' or entry<>'null' or facts->'phone'<>'null') or kind='khata.settings' and facts->'phone'<>'null' then return false;end if;
 if a<>'null' then
  if status or jsonb_typeof(a)<>'object' or (select count(*) from jsonb_object_keys(a))<>4 or exists(select 1 from jsonb_object_keys(a) k where k not in('id','currency','created','eventId'))
   or jsonb_typeof(a->'id') is distinct from 'string' or a->>'id' is distinct from ids->>'accountId'
   or jsonb_typeof(a->'eventId') is distinct from 'string' or a->>'eventId' is distinct from (case when kind='khata.settings' then command_id::text else ids->>'accountEventId' end)
   or jsonb_typeof(a->'currency') is distinct from 'string' or a->>'currency'!~'^[A-Z]{3}$' or jsonb_typeof(a->'created') is distinct from 'boolean'
   or kind='customer.create' and a->>'created'<>'true'
   or kind='khata.settings' and (a->>'created')::boolean is distinct from (account is null) then return false;end if;
 elsif kind in('customer.create','khata.settings') then return false;
 end if;
 if entry<>'null' then
  if kind not in('customer.create','customer.update') or a->>'created' is distinct from 'true' or jsonb_typeof(entry)<>'object' or (select count(*) from jsonb_object_keys(entry))<>4
   or exists(select 1 from jsonb_object_keys(entry) k where k not in('id','eventId','amount','occurredAt'))
   or entry->>'id' is distinct from ids->>'openingEntryId' or entry->>'eventId' is distinct from ids->>'openingEventId'
   or jsonb_typeof(entry->'amount') is distinct from 'number' or (entry->>'amount')::numeric not between 1 and 9007199254740991 or (entry->>'amount')::numeric<>trunc((entry->>'amount')::numeric)
   or jsonb_typeof(entry->'occurredAt') is distinct from 'number' or (entry->>'occurredAt')::numeric not between 0 and (facts->>'at')::numeric or (entry->>'occurredAt')::numeric<>trunc((entry->>'occurredAt')::numeric) then return false;end if;
 end if;
 if kind in('customer.create','customer.update') then
  opening_json:=case when entry='null' then 'null' else '{"amount":'||(entry->>'amount')||',"occurredAt":'||(entry->>'occurredAt')||'}' end;
  suffix:=',"opening":'||opening_json||suffix;
  if right(intent_json,length(suffix))<>suffix then return false;end if;
 end if;
 return true;
exception when invalid_text_representation or check_violation or numeric_value_out_of_range or invalid_parameter_value or untranslatable_character then return false;
end $$;

create function private.customer_review_new_ids(kind text,customer public.ulid,command_id public.ulid,ids jsonb,facts jsonb) returns public.ulid[]
language sql immutable security invoker set search_path='' as $$
 select array_agg(distinct x::public.ulid) from (
  select command_id::text x union all select customer::text where kind='customer.create'
  union all select facts->'account'->>'eventId' where facts->'account'<>'null'
  union all select facts->'account'->>'id' where facts->'account'->>'created'='true'
  union all select facts->'opening'->>'id' where facts->'opening'<>'null'
  union all select facts->'opening'->>'eventId' where facts->'opening'<>'null') q where x is not null
$$;
create function private.customer_review_access(business public.ulid,outlet public.ulid,actor public.ulid,customer public.ulid,kind text) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 if exists(select 1 from public.customers c where c.id=customer and c.business_id=business) then
  if not exists(select 1 from public.members m where m.id=actor and m.business_id=business and m.role='owner')
   and not exists(select 1 from public.customer_outlets a where a.business_id=business and a.outlet_id=outlet and a.customer_id=customer) then raise insufficient_privilege using message='This customer review is unavailable.';end if;
  perform private.customer_status_scope(business,outlet,actor,customer,kind);
 end if;
end $$;
create function private.customer_review_state(business public.ulid,outlet public.ulid,customer public.ulid,kind text,command_id public.ulid,ids jsonb,facts jsonb) returns jsonb
language sql volatile security invoker set search_path='' as $$
 select jsonb_build_object(
  'contextJson',json_build_object(
   'business',(select row_to_json(b) from public.businesses b where b.id=business),
   'outlet',(select row_to_json(o) from public.outlets o where o.id=outlet and o.business_id=business),
   'customer',(select row_to_json(c) from public.customers c where c.id=customer and c.business_id=business),
   'accounts',(select coalesce(json_agg(row_to_json(a) order by a.id),'[]') from public.credit_accounts a where a.business_id=business and a.outlet_id=outlet and a.customer_id=customer),
   'hasBalance',kind in('customer.archive','customer.restore') and exists(select 1 from public.credit_entries e where e.business_id=business and e.customer_id=customer group by e.account_id having sum(case when e.type='payment' then -e.amount when e.type in('charge','adjustment') then e.amount else 0 end)<>0))::text,
  'balances',(select coalesce(jsonb_agg(jsonb_build_object('accountId',a.id,'balance',a.balance) order by a.id),'[]') from (
   select a.id,coalesce(sum(case when e.type='payment' then -e.amount when e.type in('charge','adjustment') then e.amount else 0 end),0) balance
   from public.credit_accounts a left join public.credit_entries e on e.business_id=a.business_id and e.outlet_id=a.outlet_id and e.account_id=a.id
   where a.business_id=business and a.outlet_id=outlet and a.customer_id=customer group by a.id) a),
  'phoneTaken',kind in('customer.create','customer.update') and facts->>'phone' is not null and exists(select 1 from public.customers c where c.business_id=business and c.id<>customer and c.phone=facts->>'phone'),
  'available',(case when kind='customer.create' then not exists(select 1 from public.customers c where c.id=customer) else exists(select 1 from public.customers c where c.id=customer and c.business_id=business) end)
   and not exists(select 1 from public.events e where e.id=any(private.customer_review_new_ids(kind,customer,command_id,ids,facts)))
   and not exists(select 1 from private.customer_command_resolutions r where r.business_id=business and r.reserved_ids&&private.customer_review_new_ids(kind,customer,command_id,ids,facts))
   and not (facts->'account'->>'created'='true' and exists(select 1 from public.credit_accounts a where a.id=facts->'account'->>'id'))
   and not exists(select 1 from public.credit_entries e where e.id=facts->'opening'->>'id'),
  'statusHash',case when kind in('customer.archive','customer.restore') then encode(private.customer_write_snapshot(business,outlet,customer,null,kind),'hex') else null end)
$$;

create function private.inspect_customer_outcome(command_id public.ulid,kind text,customer public.ulid,outlet public.ulid,fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;r private.shop_command_receipts;resolved private.customer_command_resolutions;
begin
 if command_id is null or kind is null or kind not in('customer.create','customer.update','customer.archive','customer.restore','khata.settings') or customer is null or outlet is null or fingerprint is null or fingerprint!~'^[a-f0-9]{64}$' then raise invalid_parameter_value using message='Keep the original customer identity.';end if;
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 perform private.customer_review_access(business,outlet,actor,customer,kind);
 select * into r from private.shop_command_receipts x where x.id=command_id;
 if found then
  if r.business_id<>business or r.outlet_id<>outlet or r.actor_id<>actor or r.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This customer action is unavailable.';end if;
  if r.type<>kind or r.customer_id is distinct from customer or r.request_hash<>fingerprint then raise sqlstate 'PT409' using message='Keep the original customer identity.';end if;
  return r.receipt;
 end if;
 select * into resolved from private.customer_command_resolutions x where x.command_id=inspect_customer_outcome.command_id;
 if not found then return null;end if;
 if resolved.business_id<>business or resolved.outlet_id<>outlet or resolved.actor_id<>actor or resolved.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This customer resolution is unavailable.';end if;
 if resolved.type<>kind or resolved.customer_id<>customer or resolved.original_hash<>fingerprint then raise sqlstate 'PT409' using message='Keep the original customer resolution.';end if;
 return resolved.receipt;
end $$;
create function private.customer_review_packet(t private.customer_review_tickets,secret text,state jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('done',false,'id',t.id,'replacementId',t.replacement_id,'commandId',t.command_id,'type',t.type,'customerId',t.customer_id,'accountId',t.account_id,
  'businessId',t.business_id,'outletId',t.outlet_id,'actorId',t.actor_id,'commandHash',t.original_hash,'sourceHash',t.source_hash,
  'sourceJsonHash',encode(sha256(convert_to(t.source_json,'UTF8')),'hex'),'ids',t.ids,'facts',t.facts,'token',secret,'at',t.created_at,'expiresAt',t.expires_at,'stateJson',state::text)
$$;
create function private.admit_customer_review(outlet public.ulid) returns boolean
language plpgsql security definer set search_path='' as $$declare business public.ulid;actor public.ulid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));return true;
end $$;
create function private.prepare_customer_review(review_id public.ulid,replacement_id public.ulid,command_id public.ulid,kind text,customer public.ulid,outlet public.ulid,account public.ulid,ids jsonb,fingerprint text,intent_json text,source_hash text,source_json text,facts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old jsonb;t private.customer_review_tickets;state jsonb;secret text;at_ms public.utc_ms;lock_id text;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Verify the original phone account.';end if;
 if review_id is null or replacement_id is null or review_id=replacement_id or review_id=command_id or replacement_id=command_id or fingerprint is null or fingerprint!~'^[a-f0-9]{64}$'
  or source_hash is null or source_hash!~'^[a-f0-9]{64}$' or source_json is null or octet_length(source_json)>4000000
  or private.customer_review_plan_valid(kind,customer,outlet,command_id,account,ids,intent_json,facts) is not true or encode(sha256(convert_to(intent_json,'UTF8')),'hex')<>fingerprint
  or exists(select 1 from unnest(array[review_id,replacement_id]) x where x in(customer,outlet,command_id) or x::text in(facts->>'businessId',facts->>'actorId') or exists(select 1 from jsonb_each(coalesce(ids,'{}')) e where e.value#>>'{}'=x::text)) then raise invalid_parameter_value using message='Keep the complete original customer action and source.';end if;
 old:=private.inspect_customer_outcome(command_id,kind,customer,outlet,fingerprint);if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 if facts->>'businessId'<>business::text or facts->>'actorId'<>actor::text then raise insufficient_privilege using message='Use the original customer account and shop.';end if;
 for lock_id in select x from unnest(array[command_id::text,replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform 1 from public.businesses b where b.id=business for update;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_review_access(business,outlet,actor,customer,kind);
 old:=private.inspect_customer_outcome(command_id,kind,customer,outlet,fingerprint);if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 if exists(select 1 from public.events e where e.id in(command_id,review_id,replacement_id)) or exists(select 1 from private.command_receipts r where r.id=command_id) then raise sqlstate 'PT409' using message='Keep the original customer review identities.';end if;
 select * into t from private.customer_review_tickets r where r.id=review_id;
 if found and (t.command_id<>command_id or t.replacement_id<>replacement_id or t.auth_user_id<>(select auth.uid()) or t.actor_id<>actor or t.original_hash<>fingerprint or t.source_hash<>source_hash or t.source_json<>source_json or t.original_intent<>intent_json or t.ids is distinct from ids or t.facts<>facts or t.account_id is distinct from account) then raise sqlstate 'PT409' using message='Keep the original selected customer review.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from private.customer_review_tickets r where r.auth_user_id=(select auth.uid()) and (r.expires_at<=at_ms or r.id=review_id);
 if (select count(*) from private.customer_review_tickets r where r.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Finish an existing customer review first.';end if;
 state:=private.customer_review_state(business,outlet,customer,kind,command_id,ids,facts);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.customer_review_tickets values(review_id,command_id,replacement_id,business,outlet,customer,actor,(select auth.uid()),kind,account,ids,facts,fingerprint,source_hash,intent_json,source_json,sha256(convert_to(state::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+120000) returning * into t;
 return private.customer_review_packet(t,secret,state);
end $$;
create function private.read_customer_review(review_id public.ulid,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.customer_review_tickets;old jsonb;state jsonb;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Verify the original phone account.';end if;
 if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Review the current customer values again.';end if;
 select * into t from private.customer_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current customer values again.';end if;
 if t.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='Use the original phone account.';end if;
 perform private.customer_review_access(t.business_id,t.outlet_id,t.actor_id,t.customer_id,t.type);
 old:=private.inspect_customer_outcome(t.command_id,t.type,t.customer_id,t.outlet_id,t.original_hash);if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;state:=private.customer_review_state(t.business_id,t.outlet_id,t.customer_id,t.type,t.command_id,t.ids,t.facts);
 if t.expires_at<=at_ms or sha256(convert_to(state::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed customer values changed. Review them again.';end if;
 return private.customer_review_packet(t,secret,state);
end $$;

revoke all on function private.customer_review_plan_valid(text,public.ulid,public.ulid,public.ulid,public.ulid,jsonb,text,jsonb),private.customer_review_new_ids(text,public.ulid,public.ulid,jsonb,jsonb),private.customer_review_access(public.ulid,public.ulid,public.ulid,public.ulid,text),private.customer_review_state(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,jsonb),private.customer_review_packet(private.customer_review_tickets,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.admit_customer_review(public.ulid),private.inspect_customer_outcome(public.ulid,text,public.ulid,public.ulid,text),private.prepare_customer_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,jsonb,text,text,text,text,jsonb),private.read_customer_review(public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function private.admit_customer_review(public.ulid),private.inspect_customer_outcome(public.ulid,text,public.ulid,public.ulid,text),private.prepare_customer_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,jsonb,text,text,text,text,jsonb),private.read_customer_review(public.ulid,text) to authenticated;
create function public.admit_customer_review(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_customer_review(p_outlet_id)$$;
create function public.inspect_customer_outcome(p_command_id public.ulid,p_type text,p_customer_id public.ulid,p_outlet_id public.ulid,p_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.inspect_customer_outcome(p_command_id,p_type,p_customer_id,p_outlet_id,p_hash)$$;
create function public.prepare_customer_review(p_id public.ulid,p_replacement_id public.ulid,p_command_id public.ulid,p_type text,p_customer_id public.ulid,p_outlet_id public.ulid,p_account_id public.ulid,p_ids jsonb,p_hash text,p_intent_json text,p_source_hash text,p_source_json text,p_facts jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_customer_review(p_id,p_replacement_id,p_command_id,p_type,p_customer_id,p_outlet_id,p_account_id,p_ids,p_hash,p_intent_json,p_source_hash,p_source_json,p_facts)$$;
create function public.read_customer_review(p_id public.ulid,p_token text) returns jsonb language sql security invoker set search_path='' as $$select private.read_customer_review(p_id,p_token)$$;
revoke all on function public.admit_customer_review(public.ulid),public.inspect_customer_outcome(public.ulid,text,public.ulid,public.ulid,text),public.prepare_customer_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,jsonb,text,text,text,text,jsonb),public.read_customer_review(public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function public.admit_customer_review(public.ulid),public.inspect_customer_outcome(public.ulid,text,public.ulid,public.ulid,text),public.prepare_customer_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,jsonb,text,text,text,text,jsonb),public.read_customer_review(public.ulid,text) to authenticated;
