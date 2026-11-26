-- Retain accepted original bytes under their outlet before sending native money.
-- Auth-account deletion must not delete the outlet's original financial evidence.
create table private.payment_original_copies(
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 manifest_json text not null,manifest_hash text not null,root text not null,node_count integer not null,node_bytes bigint not null,
 receipt jsonb not null,retained_at public.utc_ms not null,unique(id,business_id,outlet_id)
);
create index payment_original_copies_scope on private.payment_original_copies(business_id,outlet_id);
create table private.payment_original_nodes(
 business_id public.ulid not null,outlet_id public.ulid not null,digest text not null,json text not null,bytes bigint not null,
 primary key(business_id,outlet_id,digest)
);
create table private.payment_original_membership(
 copy_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,digest text not null,
 primary key(copy_id,digest),foreign key(copy_id,business_id,outlet_id) references private.payment_original_copies(id,business_id,outlet_id) on delete cascade,
 foreign key(business_id,outlet_id,digest) references private.payment_original_nodes(business_id,outlet_id,digest)
);
create table private.payment_original_links(
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 copy_id public.ulid not null references private.payment_original_copies(id) on delete cascade,record_json text not null
);
-- Pending source comparisons carry no financial acceptance. Auth/session rows
-- are deliberately not parents of durable outlet evidence or pending locators.
create table private.payment_original_stages(
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 copy_id public.ulid not null references private.payment_original_copies(id) on delete cascade,request_hash text not null,payment_hash text not null,ref jsonb not null
);
create index payment_original_stage_scope on private.payment_original_stages(business_id,outlet_id,actor_id,auth_user_id);
alter table private.payment_original_stages enable row level security;alter table private.payment_original_stages force row level security;
revoke all on private.payment_original_stages from public,anon,authenticated,service_role;
create index payment_original_links_scope on private.payment_original_links(business_id,outlet_id);
alter table private.payment_original_copies enable row level security;alter table private.payment_original_copies force row level security;
alter table private.payment_original_nodes enable row level security;alter table private.payment_original_nodes force row level security;
alter table private.payment_original_membership enable row level security;alter table private.payment_original_membership force row level security;
alter table private.payment_original_links enable row level security;alter table private.payment_original_links force row level security;
revoke all on private.payment_original_copies,private.payment_original_nodes,private.payment_original_membership,private.payment_original_links from public,anon,authenticated,service_role;

create function private.payment_original_actor(outlet public.ulid) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare business public.ulid;actor public.ulid;session uuid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege;end if;
 actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 session:=private.current_native_payment_session();
 return jsonb_build_object('businessId',business,'actorId',actor,'session',session);
end $$;
create function private.payment_original_retention(c private.payment_original_copies) returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('format','mise-payment-original-retention','version',1,'copy',(c).receipt,'retainedAt',(c).retained_at)
$$;
create function private.payment_original_read(c private.payment_original_copies,op text,body jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare key text;part integer;item private.payment_original_nodes;nodes jsonb:='[]';large jsonb:='[]';v jsonb;bytes integer:=32;
begin
 if op='payment-read-part' then
  if (select array_agg(k order by k) from jsonb_object_keys(body) k) is distinct from array['digest','index'] then raise invalid_parameter_value;end if;
  key:=body->>'digest';part:=(body->>'index')::integer;
  select n.* into item from private.payment_original_nodes n join private.payment_original_membership x on x.copy_id=c.id and x.digest=n.digest and x.business_id=n.business_id and x.outlet_id=n.outlet_id
   where n.business_id=c.business_id and n.outlet_id=c.outlet_id and n.digest=key;
  if item.digest is null or part is null or part<0 or part>=ceil(item.bytes::numeric/147456) then raise insufficient_privilege;end if;
  return jsonb_build_object('digest',key,'bytes',item.bytes,'index',part,'data',replace(encode(substring(convert_to(item.json,'UTF8') from part*147456+1 for 147456),'base64'),chr(10),''));
 end if;
 if op<>'payment-read' or (select array_agg(k order by k) from jsonb_object_keys(body) k) is distinct from array['digests'] or jsonb_typeof(body->'digests')<>'array' or jsonb_array_length(body->'digests') not between 1 and 128 then raise invalid_parameter_value;end if;
 for key in select jsonb_array_elements_text(body->'digests') loop
  select n.* into item from private.payment_original_nodes n join private.payment_original_membership x on x.copy_id=c.id and x.digest=n.digest and x.business_id=n.business_id and x.outlet_id=n.outlet_id
   where n.business_id=c.business_id and n.outlet_id=c.outlet_id and n.digest=key;
  if item.digest is null then raise insufficient_privilege;end if;
  if item.bytes>98304 then large:=large||jsonb_build_array(jsonb_build_object('digest',key,'bytes',item.bytes));
  else v:=jsonb_build_object('digest',key,'json',item.json);if bytes+octet_length(v::text)>196608 then exit;end if;nodes:=nodes||jsonb_build_array(v);bytes:=bytes+octet_length(v::text);end if;
 end loop;return jsonb_build_object('nodes',nodes,'large',large);
end $$;

-- Called only with an actual accepted native result. No new money is executed.
create function private.payment_original_complete(a private.native_payment_actions,s private.payment_original_stages) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c private.payment_original_copies;l private.payment_original_links;result jsonb;receipt_hash text;at_ms public.utc_ms;
begin
 if a.id is null or s.id is null or a.id<>s.id or a.business_id<>s.business_id or a.outlet_id<>s.outlet_id or a.actor_id<>s.actor_id or a.auth_user_id<>s.auth_user_id
  or a.request_hash<>s.request_hash or a.receipt->>'paymentHash' is distinct from s.payment_hash or a.receipt->>'paymentId' is distinct from s.ref->>'paymentId' or a.receipt->>'revision' is distinct from s.ref->>'revision' then raise unique_violation;end if;
 select * into c from private.payment_original_copies x where x.id=s.copy_id for share;
 if c.id is null or c.business_id<>a.business_id or c.outlet_id<>a.outlet_id or c.actor_id<>a.actor_id then raise insufficient_privilege;end if;
 receipt_hash:=encode(sha256(convert_to(private.native_payment_canonical(a.receipt::json),'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('mise-payment-original-link-v1:'||a.id::text,0));
 select * into l from private.payment_original_links x where x.id=a.id for update;
 if l.id is not null then
  result:=l.record_json::jsonb;
  if l.copy_id<>c.id or result->'ref' is distinct from s.ref or result->>'requestHash' is distinct from a.request_hash or result->>'paymentHash' is distinct from s.payment_hash or result->>'receiptHash' is distinct from receipt_hash then raise unique_violation;end if;
 else
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  result:=jsonb_build_object('format','mise-native-payment-original-link','version',1,'id',a.id,'businessId',a.business_id,'outletId',a.outlet_id,'actorId',a.actor_id,'requestHash',a.request_hash,'paymentHash',s.payment_hash,'receiptHash',receipt_hash,'ref',s.ref,'retention',private.payment_original_retention(c),'linkedAt',at_ms);
  insert into private.payment_original_links values(a.id,a.business_id,a.outlet_id,a.actor_id,c.id,private.native_payment_canonical(result::json));
 end if;
 delete from private.payment_original_stages x where x.id=s.id;return result;
end $$;
create function private.payment_original_action_accepted() returns trigger language plpgsql security invoker set search_path='' as $$
declare s private.payment_original_stages;
begin
 if tg_table_schema<>'private' or tg_table_name<>'native_payment_actions' or tg_op<>'INSERT' then raise insufficient_privilege;end if;
 -- Serialize with source staging before inspecting its committed comparison.
 perform pg_advisory_xact_lock(hashtextextended('mise-payment-original-stage-v1:'||new.id::text,0));
 select * into s from private.payment_original_stages x where x.id=new.id;
 if s.id is not null and s.business_id=new.business_id and s.outlet_id=new.outlet_id and s.actor_id=new.actor_id and s.auth_user_id=new.auth_user_id and s.request_hash=new.request_hash and s.payment_hash=new.receipt->>'paymentHash' and s.ref->>'paymentId'=new.receipt->>'paymentId' and s.ref->>'revision'=new.receipt->>'revision' then
  perform private.payment_original_complete(new,s);
 end if;return null;
end $$;
create trigger mise_payment_original_action_insert after insert on private.native_payment_actions for each row execute function private.payment_original_action_accepted();
revoke all on function private.payment_original_complete(private.native_payment_actions,private.payment_original_stages),private.payment_original_action_accepted() from public,anon,authenticated,service_role;

-- A genuine private privilege boundary for current scoped byte retention/reads.
-- It executes no financial command and accepts no customer text as instructions.
create function private.payment_original(op text,outlet public.ulid,original_id public.ulid,body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb;business public.ulid;member public.ulid;subject uuid:=(select auth.uid());session uuid;operation text;
 c private.payment_original_copies;owned private.native_original_copies;a private.native_payment_actions;l private.payment_original_links;staged private.payment_original_stages;
 result jsonb;ref jsonb;at_ms public.utc_ms;counted bigint;size bigint;used integer;budget_minute bigint;
begin
 actor:=private.payment_original_actor(outlet);business:=(actor->>'businessId')::public.ulid;member:=(actor->>'actorId')::public.ulid;session:=(actor->>'session')::uuid;
 if original_id is null or body is null or jsonb_typeof(body)<>'object' or octet_length(body::text)>256000 then raise invalid_parameter_value;end if;
 operation:=case when op='admit' then body->>'operation' else op end;
 if operation is null or operation not in ('payment-promote','payment-stage','payment-link','payment-inspect','payment-read','payment-read-part') then raise invalid_parameter_value;end if;
 if op='admit' and (select array_agg(k) from jsonb_object_keys(body) k) is distinct from array['operation'] then raise invalid_parameter_value;end if;
 budget_minute:=floor(extract(epoch from clock_timestamp())/60);
 insert into private.native_original_budgets values(subject,budget_minute,1) on conflict(owner_uid,minute) do update set used=private.native_original_budgets.used+1 returning native_original_budgets.used into used;
 if used>4096 then raise sqlstate 'PT429' using message='Resume original retention shortly.';end if;
 delete from private.native_original_budgets b where b.owner_uid=subject and b.minute<budget_minute-2;
 if operation='payment-promote' then
  select * into c from private.payment_original_copies x where x.id=original_id for share;
  if c.id is not null then
   if c.business_id<>business or c.outlet_id<>outlet or c.actor_id<>member then raise insufficient_privilege;end if;
  else
   select * into owned from private.native_original_copies x where x.id=original_id for share;
   if owned.id is null or owned.owner_uid<>subject or owned.business_id<>business or owned.outlet_id<>outlet or owned.actor_id<>member or owned.receipt is null then raise insufficient_privilege;end if;
  end if;
 elsif operation='payment-stage' then
  select * into a from private.native_payment_actions x where x.id=original_id;
  if a.id is not null and (a.business_id<>business or a.outlet_id<>outlet or a.actor_id<>member or a.auth_user_id<>subject) then raise insufficient_privilege;end if;
  select * into staged from private.payment_original_stages x where x.id=original_id;
  if staged.id is not null and (staged.business_id<>business or staged.outlet_id<>outlet or staged.actor_id<>member or staged.auth_user_id<>subject) then raise insufficient_privilege;end if;
 elsif operation='payment-link' then
  select * into a from private.native_payment_actions x where x.id=original_id for share;
  if a.id is null or a.business_id<>business or a.outlet_id<>outlet or a.actor_id<>member or a.auth_user_id<>subject then raise insufficient_privilege;end if;
 else
  select * into l from private.payment_original_links x where x.id=original_id for share;
  if l.id is null or l.business_id<>business or l.outlet_id<>outlet then raise insufficient_privilege;end if;
  select * into c from private.payment_original_copies x where x.id=l.copy_id for share;
  if c.id is null or c.business_id<>business or c.outlet_id<>outlet then raise insufficient_privilege;end if;
 end if;
 if op='admit' then result:='true'::jsonb;
 elsif operation='payment-promote' then
  if body<>'{}'::jsonb then raise invalid_parameter_value;end if;
  if c.id is null then
   perform pg_advisory_xact_lock(hashtextextended('mise-payment-original-retention-v1:'||outlet::text,0));
   -- Recheck after serialization, so retries never replace the accepted copy.
   select * into c from private.payment_original_copies x where x.id=original_id;
   if c.id is null then
    if (select count(*) from private.payment_original_copies x where x.business_id=business and x.outlet_id=outlet)>=512 then raise sqlstate 'PT429' using message='Keep retained originals; this outlet archive is full.';end if;
    select count(*),coalesce(sum(n.bytes),0) into counted,size from private.native_original_membership m join private.native_original_nodes n on n.owner_uid=subject and n.business_id=business and n.outlet_id=outlet and n.digest=m.digest where m.copy_id=owned.id;
    if counted<>owned.node_count or size<>owned.node_bytes then raise sqlstate 'PT409' using message='Keep every accepted original node.';end if;
    at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
    insert into private.payment_original_copies values(owned.id,business,outlet,member,owned.manifest_json,owned.manifest_hash,owned.root,owned.node_count,owned.node_bytes,owned.receipt,at_ms) returning * into c;
    insert into private.payment_original_nodes(business_id,outlet_id,digest,json,bytes)
     select business,outlet,n.digest,n.json,n.bytes from private.native_original_membership m join private.native_original_nodes n on n.owner_uid=subject and n.business_id=business and n.outlet_id=outlet and n.digest=m.digest where m.copy_id=owned.id on conflict do nothing;
    if exists(select 1 from private.native_original_membership m join private.native_original_nodes n on n.owner_uid=subject and n.business_id=business and n.outlet_id=outlet and n.digest=m.digest join private.payment_original_nodes s on s.business_id=business and s.outlet_id=outlet and s.digest=n.digest where m.copy_id=owned.id and (s.json<>n.json or s.bytes<>n.bytes)) then raise unique_violation;end if;
    insert into private.payment_original_membership(copy_id,business_id,outlet_id,digest) select owned.id,business,outlet,m.digest from private.native_original_membership m where m.copy_id=owned.id;
    if (select coalesce(sum(n.bytes),0) from private.payment_original_nodes n where n.business_id=business and n.outlet_id=outlet)>536870912 then raise sqlstate 'PT429' using message='Keep retained originals; this outlet archive is full.';end if;
   elsif c.business_id<>business or c.outlet_id<>outlet or c.actor_id<>member or c.manifest_hash<>owned.manifest_hash then raise unique_violation;end if;
  end if;
  result:=private.payment_original_retention(c);
 elsif operation='payment-stage' then
  if (select array_agg(k order by k) from jsonb_object_keys(body) k) is distinct from array['copyId','paymentHash','ref','requestHash'] or octet_length(body::text)>8192 then raise invalid_parameter_value;end if;
  ref:=body->'ref';
  if jsonb_typeof(ref) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(ref) k) is distinct from array['eventId','paymentId','revision','root']
   or jsonb_typeof(ref->'root') is distinct from 'string' or ref->>'root'!~'^[a-f0-9]{64}$' or ref->>'eventId' is distinct from original_id::text
   or jsonb_typeof(ref->'paymentId') is distinct from 'string' or ref->>'paymentId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
   or jsonb_typeof(ref->'revision') is distinct from 'number' or (ref->>'revision')::numeric not between 1 and 9007199254740991 or (ref->>'revision')::numeric<>trunc((ref->>'revision')::numeric)
   or jsonb_typeof(body->'requestHash') is distinct from 'string' or body->>'requestHash'!~'^[a-f0-9]{64}$' or jsonb_typeof(body->'paymentHash') is distinct from 'string' or body->>'paymentHash'!~'^[a-f0-9]{64}$' then raise invalid_parameter_value;end if;
  select * into c from private.payment_original_copies x where x.id=(body->>'copyId')::public.ulid for share;
  if c.id is null or c.business_id<>business or c.outlet_id<>outlet or c.actor_id<>member then raise insufficient_privilege;end if;
  perform pg_advisory_xact_lock(hashtextextended('mise-payment-original-stage-v1:'||original_id::text,0));
  select * into staged from private.payment_original_stages x where x.id=original_id for update;
  if staged.id is not null then
   if staged.business_id<>business or staged.outlet_id<>outlet or staged.actor_id<>member or staged.auth_user_id<>subject or staged.copy_id<>c.id or staged.request_hash is distinct from body->>'requestHash' or staged.payment_hash is distinct from body->>'paymentHash' or staged.ref is distinct from ref then raise unique_violation;end if;
  else
   if (select count(*) from private.payment_original_stages x where x.business_id=business and x.outlet_id=outlet and x.actor_id=member and x.auth_user_id=subject)>=1024 then raise sqlstate 'PT429' using message='Resume pending original payment sources first.';end if;
   insert into private.payment_original_stages values(original_id,business,outlet,member,subject,c.id,body->>'requestHash',body->>'paymentHash',ref) returning * into staged;
  end if;
  select * into a from private.native_payment_actions x where x.id=original_id for share;
  if a.id is not null then perform private.payment_original_complete(a,staged);end if;
  result:='true'::jsonb;
 elsif operation='payment-link' then
  if (select array_agg(k order by k) from jsonb_object_keys(body) k) is distinct from array['copyId','paymentHash','receiptHash','ref','requestHash'] or octet_length(body::text)>8192 then raise invalid_parameter_value;end if;
  ref:=body->'ref';
  if jsonb_typeof(ref) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(ref) k) is distinct from array['eventId','paymentId','revision','root']
   or jsonb_typeof(ref->'root') is distinct from 'string' or jsonb_typeof(ref->'eventId') is distinct from 'string' or jsonb_typeof(ref->'paymentId') is distinct from 'string' or jsonb_typeof(ref->'revision') is distinct from 'number' or ref->>'root'!~'^[a-f0-9]{64}$' or ref->>'eventId' is distinct from a.id::text or ref->>'paymentId' is distinct from a.receipt->>'paymentId' or ref->>'revision' is distinct from a.receipt->>'revision'
   or body->>'requestHash' is distinct from a.request_hash or body->>'paymentHash' is distinct from a.receipt->>'paymentHash' or body->>'receiptHash' is distinct from encode(sha256(convert_to(private.native_payment_canonical(a.receipt::json),'UTF8')),'hex') then raise invalid_parameter_value;end if;
  select * into c from private.payment_original_copies x where x.id=(body->>'copyId')::public.ulid for share;
  if c.id is null or c.business_id<>business or c.outlet_id<>outlet or c.actor_id<>member then raise insufficient_privilege;end if;
  perform pg_advisory_xact_lock(hashtextextended('mise-payment-original-link-v1:'||a.id::text,0));
  select * into l from private.payment_original_links x where x.id=a.id for update;
  if l.id is not null then
   result:=l.record_json::jsonb;
   if l.copy_id<>c.id or result->'ref' is distinct from ref or result->>'requestHash' is distinct from body->>'requestHash' or result->>'paymentHash' is distinct from body->>'paymentHash' or result->>'receiptHash' is distinct from body->>'receiptHash' then raise unique_violation using message='Keep the original payment source link.';end if;
  else
   at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
   result:=jsonb_build_object('format','mise-native-payment-original-link','version',1,'id',a.id,'businessId',business,'outletId',outlet,'actorId',member,'requestHash',a.request_hash,'paymentHash',body->>'paymentHash','receiptHash',body->>'receiptHash','ref',ref,'retention',private.payment_original_retention(c),'linkedAt',at_ms);
   insert into private.payment_original_links values(a.id,business,outlet,member,c.id,private.native_payment_canonical(result::json));
  end if;
 elsif operation='payment-inspect' then
  if body<>'{}'::jsonb then raise invalid_parameter_value;end if;result:=l.record_json::jsonb;
 else result:=private.payment_original_read(c,operation,body);
 end if;
 -- Expiry during persistence rolls the entire graph/link and feed capture back.
 if private.payment_original_actor(outlet) is distinct from actor then raise insufficient_privilege;end if;
 perform private.assert_native_payment_session(subject,session);
 if op='admit' then return result;end if;
 return jsonb_build_object('reader',jsonb_build_object('businessId',business,'outletId',outlet,'actorId',member),'value',result);
end $$;
revoke all on function private.payment_original_actor(public.ulid),private.payment_original_retention(private.payment_original_copies),private.payment_original_read(private.payment_original_copies,text,jsonb),private.payment_original(text,public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.payment_original(text,public.ulid,public.ulid,jsonb) to authenticated;
create function public.payment_original(p_op text,p_outlet_id public.ulid,p_copy_id public.ulid,p_body jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.payment_original(p_op,p_outlet_id,p_copy_id,p_body)$$;
revoke all on function public.payment_original(text,public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.payment_original(text,public.ulid,public.ulid,jsonb) to authenticated;

create or replace function private.sync_columns(kind text) returns jsonb language sql immutable security invoker set search_path='' as $$
 select case when kind='member_refs' then '["id","business_id","created_at","updated_at","name","role"]'::jsonb
 when kind in ('native_payments','native_payment_events','native_payment_originals') then '["id","business_id","outlet_id","record_json"]'::jsonb
 when kind='native_payment_actions' then '["id","business_id","outlet_id","actor_id","request_hash","intent_json","receipt"]'::jsonb else private.sync_columns_v1(kind) end
$$;
create function private.sync_capture_payment_original() returns trigger language plpgsql security invoker set search_path='' as $$
declare r record;
begin
 if tg_table_schema<>'private' or tg_table_name<>'payment_original_links' then raise insufficient_privilege;end if;
 if tg_op='TRUNCATE' then
  for r in select * from private.payment_original_links loop perform private.sync_emit(r.business_id,r.outlet_id,'native_payment_originals',r.id,'delete',null);end loop;return null;
 end if;
 if tg_op<>'INSERT' then
  r:=old;if tg_op='DELETE' or row(old.id,old.business_id,old.outlet_id) is distinct from row(new.id,new.business_id,new.outlet_id) then perform private.sync_emit(r.business_id,r.outlet_id,'native_payment_originals',r.id,'delete',null);end if;
 end if;
 if tg_op<>'DELETE' then r:=new;perform private.sync_emit(r.business_id,r.outlet_id,'native_payment_originals',r.id,'upsert',json_build_object('id',r.id,'business_id',r.business_id,'outlet_id',r.outlet_id,'record_json',r.record_json));end if;return null;
end $$;
create trigger mise_sync_payment_original after insert or update or delete on private.payment_original_links for each row execute function private.sync_capture_payment_original();
create trigger mise_sync_payment_original_truncate before truncate on private.payment_original_links for each statement execute function private.sync_capture_payment_original();
revoke all on function private.sync_capture_payment_original() from public,anon,authenticated,service_role;
-- Removing accepted action metadata also removes its current locator, retaining
-- the immutable outlet archive and emitting the locator tombstone atomically.
create function private.payment_original_action_removed() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_schema<>'private' or tg_table_name<>'native_payment_actions' then raise insufficient_privilege;end if;
 if tg_op='TRUNCATE' then delete from private.payment_original_links l using private.native_payment_actions a where l.id=a.id;delete from private.payment_original_stages s using private.native_payment_actions a where s.id=a.id;return null;
 elsif tg_op='DELETE' then delete from private.payment_original_links l where l.id=old.id;delete from private.payment_original_stages s where s.id=old.id;return null;
 else raise insufficient_privilege;end if;
end $$;
create trigger mise_payment_original_action_delete after delete on private.native_payment_actions for each row execute function private.payment_original_action_removed();
create trigger mise_payment_original_action_truncate before truncate on private.native_payment_actions for each statement execute function private.payment_original_action_removed();
revoke all on function private.payment_original_action_removed() from public,anon,authenticated,service_role;
-- No historical source link is fabricated; older actions need genuine originals.
update private.sync_epoch set id=gen_random_uuid();
