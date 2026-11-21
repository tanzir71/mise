-- Saved physical counts are retained as opaque source text. These read-only
-- preparations cannot write shop data or authorize an ordinary closing alone.
create table private.closing_review_tickets (
 id public.ulid primary key,command_id public.ulid not null,replacement_id public.ulid not null,
 business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 type text not null check(type in('closing.record','closing.undo')),
 closing_id public.ulid not null,sale_id public.ulid,sale_event_id public.ulid,occurred_at public.utc_ms not null,facts jsonb not null,
 original_hash text not null check(original_hash~'^[a-f0-9]{64}$'),source_hash text not null check(source_hash~'^[a-f0-9]{64}$'),
 original_intent text not null check(octet_length(original_intent)<=32000),source_json text not null check(octet_length(source_json)<=16000000),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null check(octet_length(token_hash)=32),
 created_at public.utc_ms not null,expires_at public.utc_ms not null,
 check(id<>command_id and id<>replacement_id and command_id<>replacement_id),check((sale_id is null)=(sale_event_id is null))
);
create index closing_review_tickets_actor_idx on private.closing_review_tickets(auth_user_id,expires_at);
create index closing_review_tickets_command_idx on private.closing_review_tickets(command_id);
create index closing_review_tickets_replacement_idx on private.closing_review_tickets(replacement_id);
create table private.closing_command_resolutions (
 id public.ulid primary key,command_id public.ulid not null unique,replacement_id public.ulid,
 business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,type text not null,
 closing_id public.ulid not null,sale_id public.ulid,sale_event_id public.ulid,occurred_at public.utc_ms not null,
 original_hash text not null,source_hash text not null,original_intent text not null,source_json text not null,facts jsonb not null,reserved_ids public.ulid[] not null,
 outcome text not null check(outcome in('withdrawn','replaced')),receipt jsonb not null,created_at public.utc_ms not null,
 position bigint generated always as identity unique,check((outcome='withdrawn')=(replacement_id is null))
);
create index closing_command_resolutions_reserved_idx on private.closing_command_resolutions using gin(reserved_ids);
alter table private.closing_review_tickets enable row level security;
alter table private.closing_review_tickets force row level security;
alter table private.closing_command_resolutions enable row level security;
alter table private.closing_command_resolutions force row level security;
revoke all on private.closing_review_tickets,private.closing_command_resolutions from public,anon,authenticated,service_role;
revoke all on sequence private.closing_command_resolutions_position_seq from public,anon,authenticated,service_role;

create function private.closing_review_access_subject(business public.ulid,outlet public.ulid,actor public.ulid,subject uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform private.customer_write_actor(business,outlet,actor,subject);
 perform 1 from auth.users u where u.id=subject and not coalesce(u.is_anonymous,false) for share;
 if not found then raise insufficient_privilege using message='Verify the original phone account.';end if;
end $$;

-- Match the ordinary codec exactly, without parsing an unrelated literal note
-- or a summary containing escaped NUL/surrogate code units as JSON/JSONB.
create function private.closing_review_intent(kind text,command_id public.ulid,outlet public.ulid,closing public.ulid,sale public.ulid,sale_event public.ulid,occurred public.utc_ms,facts jsonb,review_json text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare prefix text;
begin
 prefix:='{"id":"'||command_id::text||'","outletId":"'||outlet::text||'","closingId":"'||closing::text||'","occurredAt":'||occurred::text
  ||',"saleId":'||case when sale is null then 'null' else '"'||sale::text||'"' end
  ||',"saleEventId":'||case when sale_event is null then 'null' else '"'||sale_event::text||'"' end||',"type":"'||kind||'"';
 if kind='closing.undo' then return prefix||'}';end if;
 return prefix||',"input":{"day":'||to_json(facts->>'day')::text||',"fingerprint":'||to_json(review_json)::text
  ||',"countedCash":'||(facts->>'countedCash')||',"addDifference":'||(sale is not null)::text||',"note":'||(facts->>'inputNoteJson')||'}}';
end $$;
create function private.closing_review_plan_valid(kind text,command_id public.ulid,outlet public.ulid,closing public.ulid,sale public.ulid,sale_event public.ulid,occurred public.utc_ms,intent_json text,facts jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
begin
 if kind is null or kind not in('closing.record','closing.undo') or command_id is null or outlet is null or closing is null or occurred is null or intent_json is null or octet_length(intent_json)>32000
  or (sale is null)<>(sale_event is null) or command_id in(closing,sale,sale_event) or closing in(sale,sale_event) or sale=sale_event
  or jsonb_typeof(facts) is distinct from 'object' or (select count(*) from jsonb_object_keys(facts))<>17
  or exists(select 1 from jsonb_object_keys(facts) k where k not in('businessId','actorId','at','currency','timezone','day','countedCash','expectedCash','difference','addedWalkIn','closingCreatedAt','closingEventId','saleCreatedAt','saleEventId','reviewJson','inputNoteJson','noteJson'))
  or exists(select 1 from unnest(array['businessId','actorId','closingEventId']) k where jsonb_typeof(facts->k) is distinct from 'string' or facts->>k!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  or exists(select 1 from unnest(array['at','countedCash','expectedCash','difference','addedWalkIn','closingCreatedAt']) k where jsonb_typeof(facts->k) is distinct from 'number' or (facts->>k)::numeric<>trunc((facts->>k)::numeric) or abs((facts->>k)::numeric)>9007199254740991)
  or exists(select 1 from unnest(array['at','countedCash','addedWalkIn','closingCreatedAt']) k where (facts->>k)::numeric<0)
  or jsonb_typeof(facts->'currency') is distinct from 'string' or facts->>'currency'!~'^[A-Z]{3}$'
  or jsonb_typeof(facts->'timezone') is distinct from 'string' or length(facts->>'timezone')>100
  or jsonb_typeof(facts->'day') is distinct from 'string' or facts->>'day'!~'^\d{4}-\d{2}-\d{2}$'
  or (facts->>'at')::numeric<>occurred or (facts->>'closingCreatedAt')::numeric>occurred
  or (facts->>'difference')::numeric<>(facts->>'countedCash')::numeric-(facts->>'expectedCash')::numeric
  or (facts->>'addedWalkIn')::numeric<>(case when sale is null then 0 else (facts->>'difference')::numeric end)
  or sale is not null and (facts->>'addedWalkIn')::numeric<=0 then return false;end if;
 if (to_timestamp(occurred::double precision/1000) at time zone (facts->>'timezone'))::date::text<>facts->>'day'
  or (to_timestamp((facts->>'closingCreatedAt')::double precision/1000) at time zone (facts->>'timezone'))::date::text<>facts->>'day' then return false;end if;
 if sale is null then
  if facts->'saleCreatedAt' is distinct from 'null'::jsonb or facts->'saleEventId' is distinct from 'null'::jsonb then return false;end if;
 else
  if jsonb_typeof(facts->'saleCreatedAt') is distinct from 'number' or (facts->>'saleCreatedAt')::numeric is distinct from (facts->>'closingCreatedAt')::numeric
   or jsonb_typeof(facts->'saleEventId') is distinct from 'string' or facts->>'saleEventId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' then return false;end if;
 end if;
 if kind='closing.record' then
  if facts->>'closingEventId'<>command_id::text or (facts->>'closingCreatedAt')::numeric<>occurred or facts->>'saleEventId' is distinct from sale_event::text
   or jsonb_typeof(facts->'reviewJson') is distinct from 'string' or octet_length(facts->>'reviewJson')>32000
   or jsonb_typeof(facts->'inputNoteJson') is distinct from 'string' or octet_length(facts->>'inputNoteJson')>32000
   or jsonb_typeof(facts->'noteJson') is distinct from 'string' or octet_length(facts->>'noteJson')>32000 then return false;end if;
 elsif facts->'reviewJson' is distinct from 'null'::jsonb or facts->'inputNoteJson' is distinct from 'null'::jsonb or facts->'noteJson' is distinct from 'null'::jsonb or facts->>'closingEventId'=command_id::text then return false;
 end if;
 return intent_json=private.closing_review_intent(kind,command_id,outlet,closing,sale,sale_event,occurred,facts,facts->>'reviewJson');
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_parameter_value then return false;
end $$;
create function private.closing_review_new_ids(kind text,command_id public.ulid,closing public.ulid,sale public.ulid,sale_event public.ulid) returns public.ulid[]
language sql immutable security invoker set search_path='' as $$
 select array_agg(distinct x order by x) from unnest(array[command_id,sale_event]||case when kind='closing.record' then array[closing,sale] else array[]::public.ulid[] end) x where x is not null
$$;
create function private.closing_review_state(p_business public.ulid,p_outlet public.ulid,p_actor public.ulid,p_kind text,p_command_id public.ulid,p_closing public.ulid,p_sale public.ulid,p_sale_event public.ulid) returns jsonb
language sql volatile security invoker set search_path='' as $$
 select jsonb_build_object('contextJson',private.closing_write_context(p_business,p_outlet,p_actor,p_kind,jsonb_build_object('closingId',p_closing,'saleId',p_sale))::text,
  'available',not exists(select 1 from public.events e where e.id=any(private.closing_review_new_ids(p_kind,p_command_id,p_closing,p_sale,p_sale_event)))
   and not exists(select 1 from private.closing_command_resolutions r where r.business_id=p_business and r.reserved_ids&&private.closing_review_new_ids(p_kind,p_command_id,p_closing,p_sale,p_sale_event))
   and (p_kind<>'closing.record' or not exists(select 1 from public.day_closings c where c.id=p_closing) and not exists(select 1 from public.sales s where s.id=p_sale)))
$$;
create function private.inspect_closing_outcome(command_id public.ulid,kind text,closing public.ulid,outlet public.ulid,fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;r private.shop_command_receipts;resolved private.closing_command_resolutions;
begin
 if command_id is null or kind is null or kind not in('closing.record','closing.undo') or closing is null or outlet is null or fingerprint is null or fingerprint!~'^[a-f0-9]{64}$' then raise invalid_parameter_value using message='Keep the original closing identity.';end if;
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 perform private.closing_review_access_subject(business,outlet,actor,(select auth.uid()));
 select * into r from private.shop_command_receipts x where x.id=command_id;
 if found then
  if r.business_id<>business or r.outlet_id<>outlet or r.actor_id<>actor or r.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This closing action is unavailable.';end if;
  if r.type<>kind or r.receipt->>'closingId' is distinct from closing::text or r.request_hash<>fingerprint then raise sqlstate 'PT409' using message='Keep the original closing receipt.';end if;return r.receipt;
 end if;
 select * into resolved from private.closing_command_resolutions x where x.command_id=inspect_closing_outcome.command_id;
 if not found then return null;end if;
 if resolved.business_id<>business or resolved.outlet_id<>outlet or resolved.actor_id<>actor or resolved.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This closing resolution is unavailable.';end if;
 if resolved.type<>kind or resolved.closing_id<>closing or resolved.original_hash<>fingerprint then raise sqlstate 'PT409' using message='Keep the original closing resolution.';end if;return resolved.receipt;
end $$;
create function private.closing_review_packet(t private.closing_review_tickets,secret text,state jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('done',false,'id',t.id,'replacementId',t.replacement_id,'commandId',t.command_id,'type',t.type,'closingId',t.closing_id,'saleId',t.sale_id,'saleEventId',t.sale_event_id,'occurredAt',t.occurred_at,
  'businessId',t.business_id,'outletId',t.outlet_id,'actorId',t.actor_id,'commandHash',t.original_hash,'sourceHash',t.source_hash,'sourceJsonHash',encode(sha256(convert_to(t.source_json,'UTF8')),'hex'),'facts',t.facts,
  'token',secret,'at',t.created_at,'expiresAt',t.expires_at,'stateJson',state::text)
$$;
create function private.admit_closing_review(outlet public.ulid) returns boolean
language plpgsql security definer set search_path='' as $$declare business public.ulid;actor public.ulid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 perform private.closing_review_access_subject(business,outlet,actor,(select auth.uid()));return true;
end $$;
create function private.prepare_closing_review(review_id public.ulid,replacement_id public.ulid,command_id public.ulid,kind text,outlet public.ulid,closing public.ulid,sale public.ulid,sale_event public.ulid,occurred public.utc_ms,fingerprint text,intent_json text,source_hash text,source_json text,facts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old jsonb;t private.closing_review_tickets;state jsonb;secret text;at_ms public.utc_ms;lock_id text;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Verify the original phone account.';end if;
 if review_id is null or replacement_id is null or review_id=replacement_id or fingerprint is null or fingerprint!~'^[a-f0-9]{64}$' or source_hash is null or source_hash!~'^[a-f0-9]{64}$' or source_json is null or octet_length(source_json)>16000000
  or private.closing_review_plan_valid(kind,command_id,outlet,closing,sale,sale_event,occurred,intent_json,facts) is not true or encode(sha256(convert_to(intent_json,'UTF8')),'hex')<>fingerprint
  or exists(select 1 from unnest(array[review_id,replacement_id]) x where x in(command_id,outlet,closing,sale,sale_event) or x::text in(facts->>'businessId',facts->>'actorId',facts->>'closingEventId',facts->>'saleEventId')) then raise invalid_parameter_value using message='Keep the complete original closing action and source.';end if;
 old:=private.inspect_closing_outcome(command_id,kind,closing,outlet,fingerprint);if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 if facts->>'businessId'<>business::text or facts->>'actorId'<>actor::text then raise insufficient_privilege using message='Use the original closing account and shop.';end if;
 for lock_id in select x from unnest(array[command_id::text,replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform 1 from public.businesses b where b.id=business for update;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.closing_review_access_subject(business,outlet,actor,(select auth.uid()));
 old:=private.inspect_closing_outcome(command_id,kind,closing,outlet,fingerprint);if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from private.closing_review_tickets r where r.auth_user_id=(select auth.uid()) and (r.expires_at<=at_ms or r.id=review_id);
 if (select count(*) from private.closing_review_tickets r where r.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Finish an existing closing review first.';end if;
 state:=private.closing_review_state(business,outlet,actor,kind,command_id,closing,sale,sale_event);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.closing_review_tickets values(review_id,command_id,replacement_id,business,outlet,actor,(select auth.uid()),kind,closing,sale,sale_event,occurred,facts,fingerprint,source_hash,intent_json,source_json,sha256(convert_to(state::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+120000) returning * into t;
 return private.closing_review_packet(t,secret,state);
end $$;
create function private.read_closing_review(review_id public.ulid,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.closing_review_tickets;old jsonb;state jsonb;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Verify the original phone account.';end if;
 if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Review the current closing values again.';end if;
 select * into t from private.closing_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current closing values again.';end if;
 if t.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='Use the original phone account.';end if;
 perform private.closing_review_access_subject(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 old:=private.inspect_closing_outcome(t.command_id,t.type,t.closing_id,t.outlet_id,t.original_hash);if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;state:=private.closing_review_state(t.business_id,t.outlet_id,t.actor_id,t.type,t.command_id,t.closing_id,t.sale_id,t.sale_event_id);
 if t.expires_at<=at_ms or sha256(convert_to(state::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed closing values changed. Review them again.';end if;
 return private.closing_review_packet(t,secret,state);
end $$;

revoke all on function private.closing_review_access_subject(public.ulid,public.ulid,public.ulid,uuid),private.closing_review_intent(text,public.ulid,public.ulid,public.ulid,public.ulid,public.ulid,public.utc_ms,jsonb,text),private.closing_review_plan_valid(text,public.ulid,public.ulid,public.ulid,public.ulid,public.ulid,public.utc_ms,text,jsonb),private.closing_review_new_ids(text,public.ulid,public.ulid,public.ulid,public.ulid),private.closing_review_state(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,public.ulid),private.closing_review_packet(private.closing_review_tickets,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.admit_closing_review(public.ulid),private.inspect_closing_outcome(public.ulid,text,public.ulid,public.ulid,text),private.prepare_closing_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,public.ulid,public.utc_ms,text,text,text,text,jsonb),private.read_closing_review(public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function private.admit_closing_review(public.ulid),private.inspect_closing_outcome(public.ulid,text,public.ulid,public.ulid,text),private.prepare_closing_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,public.ulid,public.utc_ms,text,text,text,text,jsonb),private.read_closing_review(public.ulid,text) to authenticated;
create function public.admit_closing_review(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_closing_review(p_outlet_id)$$;
create function public.inspect_closing_outcome(p_command_id public.ulid,p_type text,p_closing_id public.ulid,p_outlet_id public.ulid,p_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.inspect_closing_outcome(p_command_id,p_type,p_closing_id,p_outlet_id,p_hash)$$;
create function public.prepare_closing_review(p_id public.ulid,p_replacement_id public.ulid,p_command_id public.ulid,p_type text,p_outlet_id public.ulid,p_closing_id public.ulid,p_sale_id public.ulid,p_sale_event_id public.ulid,p_occurred_at public.utc_ms,p_hash text,p_intent_json text,p_source_hash text,p_source_json text,p_facts jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_closing_review(p_id,p_replacement_id,p_command_id,p_type,p_outlet_id,p_closing_id,p_sale_id,p_sale_event_id,p_occurred_at,p_hash,p_intent_json,p_source_hash,p_source_json,p_facts)$$;
create function public.read_closing_review(p_id public.ulid,p_token text) returns jsonb language sql security invoker set search_path='' as $$select private.read_closing_review(p_id,p_token)$$;
revoke all on function public.admit_closing_review(public.ulid),public.inspect_closing_outcome(public.ulid,text,public.ulid,public.ulid,text),public.prepare_closing_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,public.ulid,public.utc_ms,text,text,text,text,jsonb),public.read_closing_review(public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function public.admit_closing_review(public.ulid),public.inspect_closing_outcome(public.ulid,text,public.ulid,public.ulid,text),public.prepare_closing_review(public.ulid,public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,public.ulid,public.utc_ms,text,text,text,text,jsonb),public.read_closing_review(public.ulid,text) to authenticated;
