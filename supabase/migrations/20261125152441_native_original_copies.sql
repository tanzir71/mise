-- Own immutable content-addressed copies are evidence, never financial authority.
create table private.native_original_copies(
 id public.ulid primary key,owner_uid uuid not null references auth.users(id) on delete cascade,
 business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 manifest_json text not null,manifest_hash text not null,root text not null,node_count integer not null,node_bytes bigint not null,
 created_at public.utc_ms not null,receipt jsonb,queued integer not null default 1,checked integer not null default 0,checked_bytes bigint not null default 0
);
create index native_original_copies_owner on private.native_original_copies(owner_uid,outlet_id);
create table private.native_original_nodes(
 owner_uid uuid not null references auth.users(id) on delete cascade,business_id public.ulid not null,outlet_id public.ulid not null,
 digest text not null check(digest~'^[0-9a-f]{64}$'),json text not null,bytes bigint not null,refs text[] not null,
 primary key(owner_uid,business_id,outlet_id,digest)
);
create table private.native_original_parts(
 owner_uid uuid not null references auth.users(id) on delete cascade,business_id public.ulid not null,outlet_id public.ulid not null,
 digest text not null,index integer not null,bytes bigint not null,body bytea not null,
 primary key(owner_uid,business_id,outlet_id,digest,index)
);
create table private.native_original_membership(
 copy_id public.ulid not null references private.native_original_copies(id) on delete cascade,digest text not null,bytes bigint,
 primary key(copy_id,digest)
);
create index native_original_frontier on private.native_original_membership(copy_id,digest) where bytes is null;
create table private.native_original_budgets(owner_uid uuid not null references auth.users(id) on delete cascade,minute bigint not null,used integer not null,primary key(owner_uid,minute));
alter table private.native_original_copies enable row level security;alter table private.native_original_copies force row level security;
alter table private.native_original_nodes enable row level security;alter table private.native_original_nodes force row level security;
alter table private.native_original_parts enable row level security;alter table private.native_original_parts force row level security;
alter table private.native_original_membership enable row level security;alter table private.native_original_membership force row level security;
alter table private.native_original_budgets enable row level security;alter table private.native_original_budgets force row level security;
revoke all on private.native_original_copies,private.native_original_nodes,private.native_original_parts,private.native_original_membership,private.native_original_budgets from public,anon,authenticated,service_role;
create function private.native_original_refs(raw text) returns text[] language plpgsql security invoker set search_path='' as $$
declare n jsonb;tag text;v jsonb;r text;result text[]:='{}';begin
 if left(raw,5)='["a",' then
  n:=raw::jsonb;if jsonb_array_length(n)<>2 or jsonb_typeof(n->1)<>'array' or exists(select 1 from jsonb_array_elements(n->1) x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-9a-f]{64}$') then raise invalid_parameter_value;end if;
  return array(select jsonb_array_elements_text(n->1));
 end if;
 n:=private.native_payment_tokens(raw::json);if jsonb_typeof(n)<>'array' then raise invalid_parameter_value;end if;tag:=private.native_payment_text(n->0);
 if tag='z' then if jsonb_array_length(n)<>1 then raise invalid_parameter_value;end if;
 elsif tag in ('s','b','n') then
  if jsonb_array_length(n)<>2 or jsonb_typeof(n->1)<>(case tag when 's' then 'string' when 'b' then 'boolean' else 'number' end) then raise invalid_parameter_value;end if;
 elsif tag='j' then
  if jsonb_array_length(n)<>2 then raise invalid_parameter_value;end if;r:=private.native_payment_text(n->1);if r is null or r!~'^[0-9a-f]{64}$' then raise invalid_parameter_value;end if;result:=array[r];
 elsif tag in ('a','o') then
  if jsonb_array_length(n)<>2 or jsonb_typeof(n->1)<>'array' then raise invalid_parameter_value;end if;
  for v in select x from jsonb_array_elements(n->1) x loop
   if tag='o' then if jsonb_typeof(v)<>'array' or jsonb_array_length(v)<>2 or jsonb_typeof(v->0)<>'string' then raise invalid_parameter_value;end if;v:=v->1;end if;
   r:=private.native_payment_text(v);if r is null or r!~'^[0-9a-f]{64}$' then raise invalid_parameter_value;end if;result:=array_append(result,r);
  end loop;
 else raise invalid_parameter_value;end if;return result;
end $$;
create function private.native_original_copy(op text,outlet public.ulid,copy_id public.ulid,body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare subject uuid:=(select auth.uid());session_claim text:=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id';business public.ulid;actor public.ulid;c private.native_original_copies;m jsonb;raw text;key text;hash text;v jsonb;old text;data bytea;combined bytea;
 at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;budget_minute bigint:=floor(extract(epoch from clock_timestamp())/60);used integer;counted bigint;size bigint;reserved bigint;node_bytes bigint;part integer;expected integer;refs text[];keys text[];
 visited record;nodes jsonb:='[]';large jsonb:='[]';bytes integer:=32;row_value jsonb;item private.native_original_nodes;manifest_hash text;count_nodes bigint;missing bigint;
begin
 if subject is null then raise insufficient_privilege;end if;
 perform pg_advisory_xact_lock(hashtextextended('mise-original-copy-v1:'||subject::text,0));
 perform 1 from auth.users u where u.id=subject and not u.is_anonymous and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>'' and u.deleted_at is null and (u.banned_until is null or u.banned_until<=clock_timestamp()) for share;
 if not found then raise insufficient_privilege using message='Verify the original account.';end if;
 if session_claim is null or session_claim!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then raise insufficient_privilege using message='Verify the original session.';end if;
 perform 1 from auth.sessions s where s.id=session_claim::uuid and s.user_id=subject and (s.not_after is null or s.not_after>clock_timestamp()) for share;
 if not found then raise insufficient_privilege using message='Verify the original session.';end if;
 if op is null or op not in ('admit','begin','missing','put','part','seal','verify','finish','inspect','read','read-part') or outlet is null or copy_id is null or body is null or jsonb_typeof(body)<>'object' or octet_length(body::text)>256000 then raise invalid_parameter_value using message='Keep the bounded original request.';end if;
 insert into private.native_original_budgets values(subject,budget_minute,1) on conflict(owner_uid,minute) do update set used=private.native_original_budgets.used+1 returning native_original_budgets.used into used;
 if used>4096 then raise sqlstate 'PT429' using message='Resume the original copy shortly.';end if;
 delete from private.native_original_budgets b where b.owner_uid=subject and b.minute<budget_minute-2;
 select * into c from private.native_original_copies x where x.id=copy_id for update;
 if c.id is not null and (c.owner_uid<>subject or c.outlet_id<>outlet) then raise insufficient_privilege using message='This original copy is unavailable.';end if;
 if op='admit' then
  if (select array_agg(k) from jsonb_object_keys(body) k) is distinct from array['operation'] or body->>'operation' not in ('begin','missing','put','part','seal','verify','finish','inspect','read','read-part') then raise invalid_parameter_value;end if;
  op:=body->>'operation';
  if c.id is not null and op in ('begin','inspect','read','read-part','finish') and (op<>'finish' or c.receipt is not null) then return 'true'::jsonb;end if;
  if op<>'begin' and c.id is null then raise insufficient_privilege;end if;
  select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege;end if;
  actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,subject);return 'true'::jsonb;
 end if;
 if op='inspect' then
  if c.id is null or body<>'{}'::jsonb then raise insufficient_privilege;end if;return jsonb_build_object('manifest',c.manifest_json::jsonb,'receipt',c.receipt);
 end if;
 if op='begin' then
  if (select array_agg(k) from jsonb_object_keys(body) k) is distinct from array['manifest'] or jsonb_typeof(body->'manifest')<>'string' then raise invalid_parameter_value;end if;
  raw:=body->>'manifest';m:=raw::jsonb;manifest_hash:=encode(sha256(convert_to(raw,'UTF8')),'hex');
  if (select array_agg(k order by k) from jsonb_object_keys(m) k) is distinct from array['actorId','businessId','format','id','nodeBytes','nodeCount','outletId','root','version'] or m->>'format'<>'mise-original-copy' or m->>'version'<>'1' or m->>'id' is distinct from copy_id::text or m->>'outletId' is distinct from outlet::text
   or m->>'root'!~'^[0-9a-f]{64}$' or (m->>'nodeCount')::numeric not between 1 and 819200 or (m->>'nodeCount')::numeric<>trunc((m->>'nodeCount')::numeric) or (m->>'nodeBytes')::numeric not between 1 and 52428800 or (m->>'nodeBytes')::numeric<>trunc((m->>'nodeBytes')::numeric) then raise invalid_parameter_value;end if;
  if c.id is not null then if c.manifest_hash<>manifest_hash then raise unique_violation using message='Keep the original copy manifest.';end if;return jsonb_build_object('manifest',c.manifest_json::jsonb,'receipt',c.receipt);end if;
  select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege;end if;
  actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,subject);
  if m->>'businessId' is distinct from business::text or m->>'actorId' is distinct from actor::text then raise insufficient_privilege;end if;
  if (select count(*) from private.native_original_copies x where x.owner_uid=subject and x.receipt is null)>=20 then raise sqlstate 'PT429' using message='Resume pending originals first.';end if;
  if (select count(*)>=512 or coalesce(sum(x.node_count),0)+(m->>'nodeCount')::integer>1638400 from private.native_original_copies x where x.owner_uid=subject) then raise sqlstate 'PT429' using message='Keep existing original copies; the private copy index is full.';end if;
  insert into private.native_original_copies(id,owner_uid,business_id,outlet_id,actor_id,manifest_json,manifest_hash,root,node_count,node_bytes,created_at,receipt) values(copy_id,subject,business,outlet,actor,raw,manifest_hash,m->>'root',(m->>'nodeCount')::integer,(m->>'nodeBytes')::bigint,at_ms,null);
  insert into private.native_original_membership(copy_id,digest) values(copy_id,m->>'root');
  return jsonb_build_object('manifest',m,'receipt',null);
 end if;
 if c.id is null then raise insufficient_privilege;end if;
 if op in ('read','read-part') then
  if c.receipt is null then raise sqlstate 'PT409' using message='Finish retaining this original first.';end if;
  if op='read-part' then
   if (select array_agg(k order by k) from jsonb_object_keys(body) k) is distinct from array['digest','index'] then raise invalid_parameter_value;end if;
   key:=body->>'digest';part:=(body->>'index')::integer;
   select n.* into item from private.native_original_nodes n join private.native_original_membership x on x.copy_id=c.id and x.digest=n.digest where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=key;
   if item.digest is null or part<0 or part>=ceil(item.bytes::numeric/147456) then raise insufficient_privilege;end if;
   return jsonb_build_object('digest',key,'bytes',item.bytes,'index',part,'data',replace(encode(substring(convert_to(item.json,'UTF8') from part*147456+1 for 147456),'base64'),chr(10),''));
  end if;
  if (select array_agg(k) from jsonb_object_keys(body) k) is distinct from array['digests'] or jsonb_typeof(body->'digests')<>'array' or jsonb_array_length(body->'digests') not between 1 and 128 then raise invalid_parameter_value;end if;
  for key in select jsonb_array_elements_text(body->'digests') loop
   select n.* into item from private.native_original_nodes n join private.native_original_membership x on x.copy_id=c.id and x.digest=n.digest where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=key;
   if item.digest is null then raise insufficient_privilege;end if;
   if item.bytes>98304 then large:=large||jsonb_build_array(jsonb_build_object('digest',key,'bytes',item.bytes));
   else row_value:=jsonb_build_object('digest',key,'json',item.json);if bytes+octet_length(row_value::text)>196608 then exit;end if;nodes:=nodes||jsonb_build_array(row_value);bytes:=bytes+octet_length(row_value::text);end if;
  end loop;return jsonb_build_object('nodes',nodes,'large',large);
 end if;
 if op='finish' and c.receipt is not null then if body<>'{}'::jsonb then raise invalid_parameter_value;end if;return c.receipt;end if;
 perform private.customer_write_actor(c.business_id,outlet,c.actor_id,subject);

 if c.receipt is not null then raise sqlstate 'PT409' using message='The completed original is immutable.';end if;
 if op='missing' then
  if (select array_agg(k) from jsonb_object_keys(body) k) is distinct from array['digests'] or jsonb_typeof(body->'digests')<>'array' or jsonb_array_length(body->'digests') not between 1 and 512 then raise invalid_parameter_value;end if;
  select coalesce(jsonb_agg(x),'[]') into nodes from jsonb_array_elements_text(body->'digests') x where not exists(select 1 from private.native_original_nodes n where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=x);return nodes;
 elsif op='put' then
  if (select array_agg(k) from jsonb_object_keys(body) k) is distinct from array['nodes'] or jsonb_typeof(body->'nodes')<>'array' or jsonb_array_length(body->'nodes') not between 1 and 512 then raise invalid_parameter_value;end if;
  for v in select x from jsonb_array_elements(body->'nodes') x loop
   if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from array['digest','json'] or jsonb_typeof(v->'json')<>'string' then raise invalid_parameter_value;end if;
   key:=v->>'digest';raw:=v->>'json';node_bytes:=octet_length(raw);
   if key is null or key!~'^[0-9a-f]{64}$' or node_bytes>196608 or encode(sha256(convert_to(raw,'UTF8')),'hex')<>key then raise invalid_parameter_value;end if;
   refs:=private.native_original_refs(raw);select n.json into old from private.native_original_nodes n where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=key;
   if found then if old<>raw then raise unique_violation;end if;continue;end if;
   insert into private.native_original_nodes values(subject,c.business_id,outlet,key,raw,node_bytes,refs);
  end loop;
 elsif op='part' then
  if (select array_agg(k order by k) from jsonb_object_keys(body) k) is distinct from array['bytes','data','digest','index'] then raise invalid_parameter_value;end if;
  key:=body->>'digest';node_bytes:=(body->>'bytes')::bigint;part:=(body->>'index')::integer;
  if key is null or key!~'^[0-9a-f]{64}$' or node_bytes not between 1 and 52428800 or part<0 or part>=ceil(node_bytes::numeric/147456) or body->>'data'!~'^[A-Za-z0-9+/]*={0,2}$' then raise invalid_parameter_value;end if;
  data:=decode(body->>'data','base64');expected:=least(147456,node_bytes-part*147456);
  if octet_length(data)<>expected then raise invalid_parameter_value;end if;
  select n.json into old from private.native_original_nodes n where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=key;
  if found then if substring(convert_to(old,'UTF8') from part*147456+1 for 147456)<>data or octet_length(old)<>node_bytes then raise unique_violation;end if;return 'true'::jsonb;end if;
  if exists(select 1 from private.native_original_parts p where p.owner_uid=subject and p.business_id=c.business_id and p.outlet_id=outlet and p.digest=key and (p.bytes<>node_bytes or p.index=part and p.body<>data)) then raise unique_violation;end if;
  insert into private.native_original_parts values(subject,c.business_id,outlet,key,part,node_bytes,data) on conflict do nothing;
 elsif op='seal' then
  if (select array_agg(k) from jsonb_object_keys(body) k) is distinct from array['digest'] then raise invalid_parameter_value;end if;key:=body->>'digest';
  if exists(select 1 from private.native_original_nodes n where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=key) then return 'true'::jsonb;end if;
  select min(p.bytes),count(*),string_agg(p.body,''::bytea order by p.index) into node_bytes,counted,combined from private.native_original_parts p where p.owner_uid=subject and p.business_id=c.business_id and p.outlet_id=outlet and p.digest=key;
  if node_bytes is null or counted<>ceil(node_bytes::numeric/147456) or octet_length(combined)<>node_bytes or encode(sha256(combined),'hex')<>key then raise sqlstate 'PT409' using message='Resume the complete original node.';end if;
  raw:=convert_from(combined,'UTF8');refs:=private.native_original_refs(raw);
  insert into private.native_original_nodes values(subject,c.business_id,outlet,key,raw,node_bytes,refs);
  delete from private.native_original_parts p where p.owner_uid=subject and p.business_id=c.business_id and p.outlet_id=outlet and p.digest=key;
 elsif op='verify' then
  if body<>'{}'::jsonb then raise invalid_parameter_value;end if;
  select array_agg(q.digest) into keys from (select x.digest from private.native_original_membership x where x.copy_id=c.id and x.bytes is null order by x.digest limit 512) q;
  if keys is null then return jsonb_build_object('done',true,'queued',c.queued,'checked',c.checked,'bytes',c.checked_bytes);end if;
  select count(*),coalesce(sum(n.bytes),0) into counted,size from private.native_original_nodes n where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=any(keys);
  if counted<>cardinality(keys) then raise sqlstate 'PT409' using message='Resume every original node before verification.';end if;
  with added as(
   insert into private.native_original_membership(copy_id,digest)
   select c.id,unnest(n.refs) from private.native_original_nodes n where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=any(keys)
   on conflict do nothing returning 1
  ) select count(*) into count_nodes from added;
  if c.queued+count_nodes>c.node_count or c.checked+counted>c.node_count or c.checked_bytes+size>c.node_bytes then raise invalid_parameter_value using message='Keep the exact bounded original graph.';end if;
  -- Exact primary-key updates avoid a generic join plan repeatedly scanning an
  -- entire historical frontier for every node in the requested batch.
  for visited in select n.digest,n.bytes from private.native_original_nodes n where n.owner_uid=subject and n.business_id=c.business_id and n.outlet_id=outlet and n.digest=any(keys) loop
   update private.native_original_membership x set bytes=visited.bytes where x.copy_id=c.id and x.digest=visited.digest and x.bytes is null;
  end loop;
  update private.native_original_copies x set queued=c.queued+count_nodes,checked=c.checked+counted,checked_bytes=c.checked_bytes+size where x.id=c.id;
  return jsonb_build_object('done',c.checked+counted=c.queued+count_nodes,'queued',c.queued+count_nodes,'checked',c.checked+counted,'bytes',c.checked_bytes+size);
 elsif op='finish' then
  if body<>'{}'::jsonb then raise invalid_parameter_value;end if;
  select count(*),coalesce(sum(x.bytes),0),count(*) filter(where x.bytes is null) into count_nodes,size,missing from private.native_original_membership x where x.copy_id=c.id;
  if missing<>0 or count_nodes<>c.node_count or size<>c.node_bytes or c.queued<>count_nodes or c.checked<>count_nodes or c.checked_bytes<>size then raise sqlstate 'PT409' using message='Resume every original node before completion.';end if;
  m:=c.manifest_json::jsonb||jsonb_build_object('acceptedAt',at_ms,'manifestHash',c.manifest_hash,'verification','content-addressed-copy');
  update private.native_original_copies x set receipt=m where x.id=c.id;return m;
 else raise invalid_parameter_value;end if;
 select coalesce(sum(n.bytes),0) into size from private.native_original_nodes n where n.owner_uid=subject;
 select coalesce(sum(x.bytes),0) into reserved from (select distinct p.business_id,p.outlet_id,p.digest,p.bytes from private.native_original_parts p where p.owner_uid=subject) x;
 if size+reserved>536870912 then raise sqlstate 'PT429' using message='Keep the original copies; the private storage budget is full.';end if;
 return 'true'::jsonb;
end $$;
revoke all on function private.native_original_refs(text),private.native_original_copy(text,public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.native_original_copy(text,public.ulid,public.ulid,jsonb) to authenticated;
create function public.native_original_copy(p_op text,p_outlet_id public.ulid,p_copy_id public.ulid,p_body jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.native_original_copy(p_op,p_outlet_id,p_copy_id,p_body)$$;
revoke all on function public.native_original_copy(text,public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.native_original_copy(text,public.ulid,public.ulid,jsonb) to authenticated;
