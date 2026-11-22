-- Public ordering has its own approval, customer-secret-bound attempts and
-- service-only completion. Customer text cannot select a tenant or record money.
create table private.public_shops (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 token_hash bytea unique check(token_hash is null or octet_length(token_hash)=32),
 source_url text,payload json,table_label text,issued_by public.ulid,create_event_id public.ulid,
 created_at public.utc_ms,expires_at public.utc_ms,revoked_at public.utc_ms,revoked_by public.ulid,revoke_event_id public.ulid unique,
 request_window bigint not null default 0,request_count integer not null default 0 check(request_count between 0 and 60000),
 unique(business_id,outlet_id,id),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),
 foreign key(business_id,issued_by) references public.members(business_id,id),
 foreign key(business_id,revoked_by) references public.members(business_id,id),
 check((created_at is not null and token_hash is not null and payload is not null and source_url is not null and issued_by is not null and create_event_id is not null)
   or(created_at is null and token_hash is null and payload is null and revoked_at is not null and revoke_event_id is not null)),
 check((revoked_at is null)=(revoke_event_id is null)),
 check(expires_at is null or expires_at>created_at),check(table_label is null or length(btrim(table_label)) between 1 and 40)
);
alter table private.public_shops enable row level security;alter table private.public_shops force row level security;
revoke all on private.public_shops from public,anon,authenticated,service_role;
create index public_shops_outlet_idx on private.public_shops(business_id,outlet_id,id);
create index public_shops_issuer_idx on private.public_shops(business_id,issued_by);
create index public_shops_revoker_idx on private.public_shops(business_id,revoked_by);

create table private.public_order_budget(id boolean primary key default true check(id),window_at bigint not null,requests integer not null check(requests between 0 and 60000));
insert into private.public_order_budget values(true,0,0);
alter table private.public_order_budget enable row level security;alter table private.public_order_budget force row level security;
revoke all on private.public_order_budget from public,anon,authenticated,service_role;

create table private.public_order_attempts (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,shop_id public.ulid not null,
 tracking_hash bytea not null unique check(octet_length(tracking_hash)=32),request_hash bytea not null check(octet_length(request_hash)=32),intent_json text not null,
 state text not null check(state in ('pending','created','closed')),created_at public.utc_ms not null,closed_at public.utc_ms,
 ticket_hash bytea check(ticket_hash is null or octet_length(ticket_hash)=32),prepared_at public.utc_ms,expires_at public.utc_ms,
 context_json text,snapshot_hash bytea check(snapshot_hash is null or octet_length(snapshot_hash)=32),receipt jsonb,
 foreign key(business_id,outlet_id,shop_id) references private.public_shops(business_id,outlet_id,id),
 check((state='created')=(receipt is not null)),check((state='closed')=(closed_at is not null)),
 check(octet_length(intent_json)<=65536)
);
alter table private.public_order_attempts enable row level security;alter table private.public_order_attempts force row level security;
revoke all on private.public_order_attempts from public,anon,authenticated,service_role;
create index public_order_attempts_shop_idx on private.public_order_attempts(business_id,outlet_id,shop_id,state);

create function private.public_order_attempt_id(hash bytea) returns public.ulid language plpgsql immutable security invoker set search_path='' as $$
declare value numeric:=0;answer text:='';alphabet text:='0123456789ABCDEFGHJKMNPQRSTVWXYZ';i integer;
begin
 if hash is null or octet_length(hash)<>32 then raise invalid_parameter_value using message='Keep the customer request secret.';end if;
 for i in 0..15 loop value:=value*256+get_byte(hash,i);end loop;
 for i in 1..26 loop answer:=substr(alphabet,mod(value,32)::integer+1,1)||answer;value:=div(value,32);end loop;
 return answer::public.ulid;
end $$;
revoke all on function private.public_order_attempt_id(bytea) from public,anon,authenticated,service_role;

create function private.public_shop_metadata(g private.public_shops) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',g.id,'createEventId',g.create_event_id,'createdAt',g.created_at,'expiresAt',g.expires_at,
  'revokedAt',g.revoked_at,'revokeEventId',g.revoke_event_id,'revokedBy',g.revoked_by,'table',g.table_label)
$$;
revoke all on function private.public_shop_metadata(private.public_shops) from public,anon,authenticated,service_role;

create function private.public_shop_actor(outlet public.ulid) returns public.ulid language plpgsql security invoker set search_path='' as $$
declare business public.ulid;actor public.ulid;
begin
 select s.business_id into business from public.outlets s where s.id=outlet;
 if not found then raise insufficient_privilege using message='This public shop cannot be changed.';end if;
 actor:=private.public_link_actor(business,outlet);
 if exists(select 1 from auth.users u where u.id=(select auth.uid()) and u.is_anonymous) then raise insufficient_privilege using message='Use a verified phone account.';end if;
 return actor;
end $$;
revoke all on function private.public_shop_actor(public.ulid) from public,anon,authenticated,service_role;

create function private.publish_public_shop(grant_id public.ulid,event_id public.ulid,outlet_id public.ulid,source_url text,payload_json text,secret_hash text,table_name text,expiry public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;o public.outlets;b public.businesses;g private.public_shops;p jsonb;e jsonb;i public.items;stamp public.utc_ms;
begin
 actor:=private.public_shop_actor(outlet_id);
 select * into b from public.businesses s where s.id=(select x.business_id from public.outlets x where x.id=outlet_id) for share;
 select * into o from public.outlets s where s.id=outlet_id and s.business_id=b.id for update;
 if not found then raise insufficient_privilege using message='This public shop cannot be changed.';end if;
 perform pg_advisory_xact_lock(hashtextextended('public-shop:'||grant_id::text,0));
 select * into g from private.public_shops s where s.id=grant_id for update;
 if found then
  if g.business_id<>o.business_id or g.outlet_id<>o.id then raise insufficient_privilege using message='This public shop cannot be changed.';end if;
  if g.created_at is null then raise object_not_in_prerequisite_state using message='This publication attempt was closed.';end if;
  if g.create_event_id<>event_id or g.token_hash<>decode(secret_hash,'hex') or g.source_url<>source_url or g.payload::text<>payload_json
   or g.table_label is distinct from table_name or g.expires_at is distinct from expiry then raise unique_violation using message='Keep the original public shop publication.';end if;
  return private.public_shop_metadata(g);
 end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if grant_id is null or event_id is null or grant_id=event_id or secret_hash is null or secret_hash!~'^[0-9a-f]{64}$'
  or source_url is distinct from o.shop_link or source_url is null or octet_length(source_url)>8192 or payload_json is null or octet_length(payload_json)>65536
  or expiry is not null and (expiry<=stamp or expiry>stamp+31536000000) or table_name is not null and length(btrim(table_name)) not between 1 and 40 then
  raise invalid_parameter_value using message='Review the published shop and table.';
 end if;
 p:=payload_json::jsonb;
 if jsonb_typeof(p)<>'object' or (select count(*) from jsonb_object_keys(p))<>14 or not p ?& array['v','code','edition','publishedAt','name','address','hours','phone','deliveryNote','market','currency','timezone','mode','items']
  or p->'v'<>'1'::jsonb or p->>'code'!~'^[A-Z0-9]{1,4}-[A-Z0-9]{4,12}$' or jsonb_typeof(p->'edition')<>'string' or p->>'edition'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
  or p->'name' is distinct from o.name::jsonb or p->'address' is distinct from o.address::jsonb
  or p->>'currency'<>o.currency or p->>'timezone'<>o.timezone or p->>'market'<>b.market_code or p->>'phone'!~'^\+[1-9][0-9]{6,14}$'
  or jsonb_typeof(p->'publishedAt')<>'number' or (p->>'publishedAt')::numeric not between 0 and 8640000000000000 or trunc((p->>'publishedAt')::numeric)<>(p->>'publishedAt')::numeric
  or jsonb_typeof(p->'hours')<>'string' or length(p->>'hours')>200 or jsonb_typeof(p->'deliveryNote')<>'string' or length(p->>'deliveryNote')>400
  or p->>'mode' not in ('list','menu') or jsonb_typeof(p->'items')<>'array' or jsonb_array_length(p->'items')>20
  or p->>'mode'='menu' and jsonb_array_length(p->'items')=0 then raise invalid_parameter_value using message='Use the reviewed public shop snapshot.';end if;
 if (select count(distinct x->>'id') from jsonb_array_elements(p->'items') x)<>jsonb_array_length(p->'items') then raise invalid_parameter_value using message='Choose unique public items.';end if;
 for e in select x from jsonb_array_elements(p->'items') x loop
  select * into i from public.items x where x.business_id=o.business_id and x.outlet_id=o.id and x.id=e->>'id' for share;
  if not found or jsonb_typeof(e)<>'object' or (select count(*) from jsonb_object_keys(e))<>8 or not e ?& array['id','name','nameLocal','unit','price','category','available','oftenBought']
   or e->'name' is distinct from i.name::jsonb or e->'nameLocal' is distinct from i.name_local::jsonb or e->'unit' is distinct from i.unit::jsonb
   or e->'price' is distinct from to_jsonb(i.price) or e->'available' is distinct from to_jsonb(i.available) or e->'oftenBought' is distinct from to_jsonb(coalesce(i.often_bought,false))
   or e->'category' is distinct from coalesce((select c.name::jsonb from public.categories c where c.business_id=o.business_id and c.outlet_id=o.id and c.id=i.category_id),'""'::jsonb)
   then raise invalid_parameter_value using message='Review the current catalogue before publishing.';end if;
 end loop;
 insert into private.public_shops(id,business_id,outlet_id,token_hash,source_url,payload,table_label,issued_by,create_event_id,created_at,expires_at)
 values(grant_id,o.business_id,o.id,decode(secret_hash,'hex'),source_url,payload_json::json,table_name,actor,event_id,stamp,expiry) returning * into g;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(event_id,o.business_id,o.id,'member',actor,'public_shop.publish','null',private.public_shop_metadata(g)::json,stamp);
 return private.public_shop_metadata(g);
end $$;
revoke all on function private.publish_public_shop(public.ulid,public.ulid,public.ulid,text,text,text,text,public.utc_ms) from public,anon,authenticated,service_role;
grant execute on function private.publish_public_shop(public.ulid,public.ulid,public.ulid,text,text,text,text,public.utc_ms) to authenticated;
create function public.publish_public_shop(p_id public.ulid,p_event_id public.ulid,p_outlet_id public.ulid,p_source_url text,p_payload_json text,p_secret_hash text,p_table text default null,p_expiry public.utc_ms default null)
returns jsonb language sql security invoker set search_path='' as $$ select private.publish_public_shop(p_id,p_event_id,p_outlet_id,p_source_url,p_payload_json,p_secret_hash,p_table,p_expiry) $$;
revoke all on function public.publish_public_shop(public.ulid,public.ulid,public.ulid,text,text,text,text,public.utc_ms) from public,anon,authenticated,service_role;
grant execute on function public.publish_public_shop(public.ulid,public.ulid,public.ulid,text,text,text,text,public.utc_ms) to authenticated;

create function private.revoke_public_shop(grant_id public.ulid,event_id public.ulid,outlet_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;o public.outlets;g private.public_shops;previous jsonb;stamp public.utc_ms;
begin
 actor:=private.public_shop_actor(outlet_id);select * into o from public.outlets s where s.id=outlet_id for update;
 if grant_id is null or event_id is null or grant_id=event_id then raise invalid_parameter_value using message='Keep the original publication and event.';end if;
 perform pg_advisory_xact_lock(hashtextextended('public-shop:'||grant_id::text,0));
 select * into g from private.public_shops s where s.id=grant_id for update;
 if found then
  if g.business_id<>o.business_id or g.outlet_id<>o.id then raise insufficient_privilege using message='This public shop cannot be changed.';end if;
  if g.revoked_at is not null then return private.public_shop_metadata(g);end if;
  previous:=private.public_shop_metadata(g);
 end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 insert into private.public_shops(id,business_id,outlet_id,revoked_at,revoked_by,revoke_event_id)
 values(grant_id,o.business_id,o.id,stamp,actor,event_id)
 on conflict(id) do update set revoked_at=excluded.revoked_at,revoked_by=excluded.revoked_by,revoke_event_id=excluded.revoke_event_id returning * into g;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(event_id,o.business_id,o.id,'member',actor,'public_shop.revoke',coalesce(previous,'null'::jsonb)::json,private.public_shop_metadata(g)::json,stamp);
 return private.public_shop_metadata(g);
end $$;
revoke all on function private.revoke_public_shop(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.revoke_public_shop(public.ulid,public.ulid,public.ulid) to authenticated;
create function public.revoke_public_shop(p_id public.ulid,p_event_id public.ulid,p_outlet_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$ select private.revoke_public_shop(p_id,p_event_id,p_outlet_id) $$;
revoke all on function public.revoke_public_shop(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.revoke_public_shop(public.ulid,public.ulid,public.ulid) to authenticated;

create function private.public_order_context(g private.public_shops,intent jsonb) returns json language sql stable security invoker set search_path='' as $$
 select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=g.business_id),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=g.business_id and o.id=g.outlet_id),
  'items',(select coalesce(json_agg(row_to_json(i) order by i.id),'[]') from public.items i where i.business_id=g.business_id and i.outlet_id=g.outlet_id
   and i.id in(select x->>'itemId' from jsonb_array_elements(intent->'selections') x)),
  'sequence',(select coalesce(max(o.sequence),0)+1 from public.orders o where o.business_id=g.business_id and o.outlet_id=g.outlet_id),'table',g.table_label)
$$;
revoke all on function private.public_order_context(private.public_shops,jsonb) from public,anon,authenticated,service_role;
create function private.public_order_result(a private.public_order_attempts) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('v',1,'state',a.state,'attemptId',a.id,'closedAt',a.closed_at,'receipt',a.receipt,
  'link',(select private.public_link_metadata(c) from private.public_links c where a.state='created' and c.id=a.receipt->>'linkId' and c.business_id=a.business_id and c.outlet_id=a.outlet_id))
$$;
revoke all on function private.public_order_result(private.public_order_attempts) from public,anon,authenticated,service_role;

create function private.prepare_public_order(shop_secret text,tracking_hash text,intent_json text,operation text,global_limit integer,shop_limit integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare source jsonb;g private.public_shops;a private.public_order_attempts;budget private.public_order_budget;stamp public.utc_ms;window_ms bigint;
 request_id public.ulid;digest bytea;secret_digest bytea;ticket text;context json;member_role text;retry_seconds integer;
begin
 if shop_secret is null or shop_secret!~'^[A-Za-z0-9_-]{43}$' or tracking_hash is null or tracking_hash!~'^[0-9a-f]{64}$'
  or intent_json is null or octet_length(intent_json)>65536 or operation is null or operation not in ('submit','inspect','close') or global_limit is null or shop_limit is null
  or global_limit not between 1 and 60000 or shop_limit not between 1 and 60000 then raise invalid_parameter_value using message='Use one complete public order request.';end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;window_ms:=stamp/60000*60000;retry_seconds:=greatest(1,ceil((window_ms+60000-stamp)/1000.0)::integer);
 select * into strict budget from private.public_order_budget where id for update;
 if budget.window_at=window_ms and budget.requests>=global_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',retry_seconds);end if;
 update private.public_order_budget set window_at=window_ms,requests=case when window_at=window_ms then requests+1 else 1 end where id;
 source:=intent_json::jsonb;secret_digest:=decode(tracking_hash,'hex');request_id:=private.public_order_attempt_id(secret_digest);digest:=sha256(convert_to(intent_json,'UTF8'));
 if source->>'id' is distinct from request_id::text then return jsonb_build_object('v',1,'state','changed');end if;
 select * into g from private.public_shops s where s.token_hash=sha256(convert_to(shop_secret,'UTF8'));
 if not found then return jsonb_build_object('v',1,'state','missing');end if;
 perform 1 from public.businesses b where b.id=g.business_id for share;
 perform 1 from public.outlets o where o.business_id=g.business_id and o.id=g.outlet_id for update;
 select * into g from private.public_shops s where s.id=g.id for update;
 perform pg_advisory_xact_lock(hashtextextended('public-order:'||request_id::text,0));
 select * into a from private.public_order_attempts x where x.id=request_id for update;
 if found then
  if a.shop_id<>g.id or a.tracking_hash<>secret_digest then return jsonb_build_object('v',1,'state','missing');end if;
  if a.request_hash<>digest then return jsonb_build_object('v',1,'state','changed');end if;
  if a.state<>'pending' or operation='inspect' then return private.public_order_result(a);end if;
 elsif operation='inspect' then return jsonb_build_object('v',1,'state','missing');
 else
  if g.revoked_at is not null or g.expires_at is not null and g.expires_at<=stamp then return jsonb_build_object('v',1,'state','unavailable');end if;
  if operation<>'close' and not exists(select 1 from public.outlets o where o.id=g.outlet_id and o.business_id=g.business_id and o.shop_link=g.source_url) then return jsonb_build_object('v',1,'state','changed');end if;
  if source->'shop' is distinct from g.payload::jsonb then return jsonb_build_object('v',1,'state','changed');end if;
  if g.request_window=window_ms and g.request_count>=shop_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',retry_seconds);end if;
  update private.public_shops set request_window=window_ms,request_count=case when request_window=window_ms then request_count+1 else 1 end where id=g.id;
  insert into private.public_order_attempts(id,business_id,outlet_id,shop_id,tracking_hash,request_hash,intent_json,state,created_at)
   values(request_id,g.business_id,g.outlet_id,g.id,secret_digest,digest,intent_json,'pending',stamp) returning * into a;
 end if;
 if operation='close' then
  update private.public_order_attempts set state='closed',closed_at=stamp,ticket_hash=null,context_json=null,snapshot_hash=null,expires_at=null where id=a.id returning * into a;
  return private.public_order_result(a);
 end if;
 if g.revoked_at is not null or g.expires_at is not null and g.expires_at<=stamp then return jsonb_build_object('v',1,'state','unavailable');end if;
 if not exists(select 1 from public.outlets o where o.id=g.outlet_id and o.business_id=g.business_id and o.shop_link=g.source_url) then return jsonb_build_object('v',1,'state','changed');end if;
 select m.role into member_role from public.members m where m.business_id=g.business_id and m.id=g.issued_by and m.active and m.role in ('owner','manager') for share;
 if not found then return jsonb_build_object('v',1,'state','unavailable');end if;
 if member_role='manager' then
  perform 1 from public.member_outlets m where m.business_id=g.business_id and m.outlet_id=g.outlet_id and m.member_id=g.issued_by for share;
  if not found then return jsonb_build_object('v',1,'state','unavailable');end if;
 end if;
 if (source->>'fulfilment'='dine_in') is distinct from (g.table_label is not null) then return jsonb_build_object('v',1,'state','changed');end if;
 context:=private.public_order_context(g,source);
 ticket:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 update private.public_order_attempts set ticket_hash=sha256(convert_to(ticket,'UTF8')),prepared_at=stamp,expires_at=stamp+30000,
  context_json=context::text,snapshot_hash=sha256(convert_to(context::text,'UTF8')) where id=a.id;
 return jsonb_build_object('v',1,'state','prepared','attemptId',request_id,'ticketToken',ticket,'businessId',g.business_id,'outletId',g.outlet_id,'actorId',g.issued_by,'at',stamp,'contextJson',context::text);
end $$;
revoke all on function private.prepare_public_order(text,text,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.prepare_public_order(text,text,text,text,integer,integer) to service_role;
create function public.prepare_public_order(p_shop_secret text,p_tracking_hash text,p_intent_json text,p_operation text,p_global_limit integer,p_shop_limit integer)
returns jsonb language sql security invoker set search_path='' as $$ select private.prepare_public_order(p_shop_secret,p_tracking_hash,p_intent_json,p_operation,p_global_limit,p_shop_limit) $$;
revoke all on function public.prepare_public_order(text,text,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.prepare_public_order(text,text,text,text,integer,integer) to service_role;

-- Match JavaScript trim without losing original text in the retained intent.
create function private.public_request_trim(value text) returns text language sql immutable security invoker set search_path='' as $$
 select btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
revoke all on function private.public_request_trim(text) from public,anon,authenticated,service_role;
create function private.public_request_parts(value text) returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare answer jsonb:='[]';part text:='';character text;units integer:=0;size integer;
begin
 if private.public_request_trim(value)='' then return answer;end if;
 for character in select regexp_split_to_table(value,'') loop
  size:=case when ascii(character)>65535 then 2 else 1 end;
  if units+size>500 then answer:=answer||jsonb_build_array(part);part:='';units:=0;end if;
  part:=part||character;units:=units+size;
 end loop;
 if part<>'' then answer:=answer||jsonb_build_array(part);end if;
 return answer;
end $$;
revoke all on function private.public_request_parts(text) from public,anon,authenticated,service_role;

create function private.finish_public_order(attempt_id public.ulid,ticket text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare a private.public_order_attempts;g private.public_shops;o public.outlets;b public.businesses;c private.public_links;
 source jsonb;v jsonb;e jsonb;line jsonb;selected jsonb;offered jsonb;parts jsonb;expected_line jsonb;logical_order jsonb;
 stamp public.utc_ms;member_role text;expected_status text;expected_total numeric;subtotal numeric:=0;index_value integer;line_count integer;selected_count integer;
 columns text;casts text;table_name text;row_values jsonb;allowed text[];
begin
 if attempt_id is null or ticket is null or ticket!~'^[A-Za-z0-9_-]{43}$' then return jsonb_build_object('v',1,'state','conflict');end if;
 select * into a from private.public_order_attempts x where x.id=attempt_id and x.ticket_hash=sha256(convert_to(ticket,'UTF8'));
 if not found then return jsonb_build_object('v',1,'state','conflict');end if;
 if a.state='created' then return private.public_order_result(a);end if;
 select * into g from private.public_shops x where x.id=a.shop_id;
 select m.role into member_role from public.members m where m.business_id=g.business_id and m.id=g.issued_by and m.active and m.role in ('owner','manager') for share;
 if not found then return jsonb_build_object('v',1,'state','unavailable');end if;
 if member_role='manager' then
  perform 1 from public.member_outlets m where m.business_id=g.business_id and m.outlet_id=g.outlet_id and m.member_id=g.issued_by for share;
  if not found then return jsonb_build_object('v',1,'state','unavailable');end if;
 end if;
 select * into b from public.businesses x where x.id=g.business_id for share;
 select * into o from public.outlets x where x.business_id=g.business_id and x.id=g.outlet_id for update;
 select * into g from private.public_shops x where x.id=g.id for update;
 select * into a from private.public_order_attempts x where x.id=attempt_id and x.ticket_hash=sha256(convert_to(ticket,'UTF8')) for update;
 if not found then return jsonb_build_object('v',1,'state','conflict');end if;
 if a.state='created' then return private.public_order_result(a);end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if g.revoked_at is not null or g.expires_at is not null and g.expires_at<=stamp then return jsonb_build_object('v',1,'state','unavailable');end if;
 if o.shop_link is distinct from g.source_url then return jsonb_build_object('v',1,'state','changed');end if;
 if a.state<>'pending' or a.expires_at is null or a.expires_at<=stamp then return jsonb_build_object('v',1,'state','conflict');end if;
 source:=a.intent_json::jsonb;
 if sha256(convert_to(private.public_order_context(g,source)::text,'UTF8'))<>a.snapshot_hash then return jsonb_build_object('v',1,'state','conflict');end if;
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records)<>2 or octet_length(records::text)>262144
  or records->0->>'table'<>'orders' or records->1->>'table'<>'events'
  or exists(select 1 from jsonb_array_elements(records) r where jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>2 or not r ?& array['table','values']) then
  raise invalid_parameter_value using message='Use the complete prepared customer order.';
 end if;
 v:=records->0->'values';e:=records->1->'values';
 expected_status:=case b.business_type when 'corner_shop' then 'requested' when 'food_stall' then 'ordered' else 'new' end;
 if v->>'id' is distinct from source->>'orderId' or v->>'business_id' is distinct from g.business_id::text or v->>'outlet_id' is distinct from g.outlet_id::text
  or v->>'created_by' is distinct from g.issued_by::text or v->>'handled_by' is distinct from g.issued_by::text
  or v->>'event_id' is distinct from source->>'eventId' or v->>'status_event_id' is distinct from source->>'eventId'
  or (v->>'created_at')::bigint is distinct from a.prepared_at or (v->>'updated_at')::bigint is distinct from a.prepared_at or (v->>'status_changed_at')::bigint is distinct from a.prepared_at
  or (v->>'revision')::bigint<>1 or v->>'business_type' is distinct from b.business_type or v->>'status' is distinct from expected_status
  or (v->>'sequence')::bigint is distinct from (a.context_json::jsonb->>'sequence')::bigint
  or v->>'number' is distinct from 'A-'||lpad((v->>'sequence'),greatest(4,length(v->>'sequence')),'0')
  or v->>'customer_id' is not null or v->>'customer_phone' is distinct from source->>'phone'
  or (v->>'customer_name')::jsonb is distinct from to_jsonb(private.public_request_trim(source->>'name'))
  or v->>'type' is distinct from source->>'fulfilment' or v->>'source' is distinct from (case when g.table_label is not null then 'table' else 'other' end)
  or (v->>'address')::jsonb is distinct from to_jsonb(case when source->>'fulfilment'='delivery' then private.public_request_trim(source->>'address') else '' end)
  or (v->>'table_label')::jsonb is distinct from to_jsonb(coalesce(g.table_label,''))
  or (v->>'scheduled_for')::bigint is distinct from (source->>'scheduledFor')::bigint
  or v->>'currency' is distinct from o.currency or v->>'timezone' is distinct from o.timezone
  or (v->>'delivery_fee')::bigint<>0 or (v->>'discount')::bigint<>0 or (v->>'payment')::jsonb<>'{"method":"cash","status":"pending"}'::jsonb then
  raise invalid_parameter_value using message='Keep the actual customer source, scope and pending payment.';
 end if;
 if length(source->>'text')>0 and position((source->>'text') in ((v->>'source_text')::jsonb#>>'{}'))=0 then raise invalid_parameter_value using message='Keep the complete original customer text.';end if;
 parts:=private.public_request_parts(source->>'text');selected_count:=jsonb_array_length(source->'selections');line_count:=selected_count+jsonb_array_length(parts)+case when source->>'fulfilment'='delivery' then 1 else 0 end;
 if jsonb_typeof((v->>'lines')::jsonb)<>'array' or jsonb_array_length((v->>'lines')::jsonb)<>line_count or line_count<1
  or jsonb_array_length(source->'lineIds')<>line_count or (select count(distinct x) from jsonb_array_elements_text(source->'lineIds') x)<>line_count then
  raise invalid_parameter_value using message='Keep the complete customer line plan.';
 end if;
 for index_value in 0..line_count-1 loop
  line:=(v->>'lines')::jsonb->index_value;
  if index_value<selected_count then
   selected:=source->'selections'->index_value;
   select x into offered from jsonb_array_elements(g.payload::jsonb->'items') x where x->>'id'=selected->>'itemId';
   if offered is null or offered->>'available'<>'true' or (selected->>'qty')::numeric not between 1 and 99 or trunc((selected->>'qty')::numeric)<>(selected->>'qty')::numeric then
    raise invalid_parameter_value using message='Choose an available published item.';end if;
   expected_line:=jsonb_build_object('id',source->'lineIds'->index_value,'itemId',offered->'id','name',offered->'name','unit',offered->'unit',
    'qty',selected->'qty','unitPrice',offered->'price','lineTotal',(offered->>'price')::numeric*(selected->>'qty')::numeric,'note','','unavailable',false);
   subtotal:=subtotal+(offered->>'price')::numeric*(selected->>'qty')::numeric;
  elsif index_value=selected_count+jsonb_array_length(parts) then
   expected_line:=jsonb_build_object('id',source->'lineIds'->index_value,'name','Delivery fee to confirm','unit','request','qty',1,'unitPrice',null,'lineTotal',null,
    'note','The shop will confirm the delivery fee before accepting this order.','unavailable',false);
  else
   expected_line:=jsonb_build_object('id',source->'lineIds'->index_value,'name',case when jsonb_array_length(parts)=1 then 'Customer request' else
    'Customer request ('||(index_value-selected_count+1)::text||'/'||jsonb_array_length(parts)::text||')' end,'unit','request','qty',1,'unitPrice',null,'lineTotal',null,
    'note',private.public_request_trim(parts->>(index_value-selected_count)),'unavailable',false);
  end if;
  if line is distinct from expected_line then raise invalid_parameter_value using message='Keep the actual published price and complete unpriced request.';end if;
 end loop;
 expected_total:=case when jsonb_array_length(parts)=0 and source->>'fulfilment'<>'delivery' then subtotal else null end;
 if (v->>'subtotal')::numeric is distinct from subtotal or (v->>'total')::numeric is distinct from expected_total then raise invalid_parameter_value using message='Keep integer customer order totals.';end if;
 logical_order:=jsonb_build_object('id',source->'orderId','outletId',g.outlet_id,'businessType',b.business_type,'sequence',(v->>'sequence')::bigint,'number',v->>'number','revision',1,
  'source',v->>'source','sourceText',(v->>'source_text')::jsonb,'customer',jsonb_build_object('name',(v->>'customer_name')::jsonb,'phone',source->>'phone'),
  'type',source->>'fulfilment','status',expected_status,'statusChangedAt',a.prepared_at,'statusEventId',source->'eventId','lines',(v->>'lines')::jsonb,'subtotal',subtotal,
  'deliveryFee',0,'discount',0,'total',expected_total,'currency',o.currency,'timezone',o.timezone,'address',(v->>'address')::jsonb,'table',(v->>'table_label')::jsonb,
  'payment',(v->>'payment')::jsonb,'handledBy',g.issued_by,'createdBy',g.issued_by,'eventId',source->'eventId','createdAt',a.prepared_at,'updatedAt',a.prepared_at)
  ||case when source->>'scheduledFor' is null then '{}'::jsonb else jsonb_build_object('scheduledFor',source->'scheduledFor') end;
 if e->>'id' is distinct from source->>'eventId' or e->>'business_id' is distinct from g.business_id::text or e->>'outlet_id' is distinct from g.outlet_id::text
  or e->>'actor_type'<>'system' or e->>'actor_id'<>'public-order' or e->>'command'<>'order.create' or (e->>'at')::bigint is distinct from a.prepared_at
  or e->>'order_id' is distinct from source->>'orderId' or (e->>'order_revision')::bigint<>1 or (e->>'before_data')::jsonb<>'null'::jsonb
  or (e->>'after_data')::jsonb is distinct from logical_order
  or exists(select 1 from unnest(array['undo_of','customer_id','stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) key where e->>key is not null) then
  raise invalid_parameter_value using message='Keep the actual customer submission audit.';
 end if;
 for table_name,row_values in select 'orders',v union all select 'events',e loop
  allowed:=case when table_name='orders' then array['id','created_at','updated_at','outlet_id','created_by','event_id','revision','business_type','sequence','number','source','source_text','customer_id','customer_name','customer_phone','type','status','status_changed_at','status_event_id','lines','subtotal','delivery_fee','discount','total','currency','timezone','address','table_label','scheduled_for','payment','handled_by','business_id']
   else array['id','outlet_id','actor_type','actor_id','command','before_data','after_data','at','undo_of','customer_id','order_id','order_revision','stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision','business_id'] end;
  if jsonb_typeof(row_values)<>'object' or not row_values ?& allowed or (select count(*) from jsonb_object_keys(row_values))<>array_length(allowed,1) then raise invalid_parameter_value using message='Keep only the prepared order and audit fields.';end if;
  select string_agg(format('%I',key),',' order by key),string_agg(format('($1->>%L)::%s',key,format_type(att.atttypid,att.atttypmod)),',' order by key)
   into columns,casts from unnest(allowed) key join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=key and att.attnum>0 and not att.attisdropped;
  execute format('insert into public.%I(%s) select %s',table_name,columns,casts) using row_values;
 end loop;
 insert into private.public_links(id,business_id,outlet_id,kind,order_id,account_id,token_hash,issued_by,created_at,expires_at,created_event_id)
 values((source->>'linkId')::public.ulid,g.business_id,g.outlet_id,'order',(source->>'orderId')::public.ulid,null,a.tracking_hash,g.issued_by,stamp,stamp+604800000,(source->>'linkEventId')::public.ulid) returning * into c;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,order_id,order_revision)
 values((source->>'linkEventId')::public.ulid,g.business_id,g.outlet_id,'system','public-order','public_link.create','null',private.public_link_metadata(c)::json,stamp,(source->>'orderId')::public.ulid,1);
 update private.public_order_attempts set state='created',context_json=null,snapshot_hash=null,expires_at=null,
  receipt=jsonb_build_object('orderId',source->'orderId','eventId',source->'eventId','linkId',source->'linkId','number',v->>'number','currency',o.currency,'total',expected_total,'createdAt',a.prepared_at,'receivedAt',stamp)
  where id=a.id returning * into a;
 return private.public_order_result(a);
end $$;
revoke all on function private.finish_public_order(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.finish_public_order(public.ulid,text,jsonb) to service_role;
create function public.finish_public_order(p_attempt_id public.ulid,p_ticket text,p_records jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.finish_public_order(p_attempt_id,p_ticket,p_records) $$;
revoke all on function public.finish_public_order(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_public_order(public.ulid,text,jsonb) to service_role;

notify pgrst,'reload schema';
