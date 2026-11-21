-- A short code selects an approval request. It never authorizes a device.
-- Only a live owner/assigned manager may approve the matching verification.
-- The screen generates its secret; SQL persists only its SHA-256 hash.
create table private.device_pairings (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 event_id public.ulid not null unique,created_by public.ulid not null,
 name text not null check(length(btrim(name)) between 1 and 80),mode text not null check(mode in ('kitchen','counter')),
 code text not null check(code~'^[0-9]{6}$'),created_at public.utc_ms not null,expires_at public.utc_ms not null,
 closed_at public.utc_ms,device_id public.ulid,
 check(expires_at=created_at+600000),check(closed_at is null or closed_at>=created_at),
 check(device_id is null or closed_at is not null),unique(business_id,outlet_id,id),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),
 foreign key(business_id,created_by) references public.members(business_id,id)
);
create unique index device_pairings_active_code_idx on private.device_pairings(code) where closed_at is null;
create index device_pairings_scope_idx on private.device_pairings(business_id,outlet_id,id);
create index device_pairings_creator_idx on private.device_pairings(business_id,created_by);
create table private.device_pairing_requests (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,pairing_id public.ulid not null,
 token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,
 approved_at public.utc_ms,approved_by public.ulid,approval_event_id public.ulid,
 check((approved_at is null)=(approved_by is null) and (approved_at is null)=(approval_event_id is null)),
 check(approved_at is null or approved_at>=created_at),
 foreign key(business_id,outlet_id,pairing_id) references private.device_pairings(business_id,outlet_id,id),
 foreign key(business_id,approved_by) references public.members(business_id,id)
);
create index device_pairing_requests_parent_idx on private.device_pairing_requests(business_id,outlet_id,pairing_id,id);
create index device_pairing_requests_approver_idx on private.device_pairing_requests(business_id,approved_by);
alter table private.device_pairings enable row level security;
alter table private.device_pairings force row level security;
alter table private.device_pairing_requests enable row level security;
alter table private.device_pairing_requests force row level security;
revoke all on private.device_pairings,private.device_pairing_requests from public,anon,authenticated,service_role;

create function private.device_pairing_metadata(p private.device_pairings) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('v',1,'id',p.id,'businessId',p.business_id,'outletId',p.outlet_id,'name',p.name,'mode',p.mode,
  'code',p.code,'createdAt',p.created_at,'expiresAt',p.expires_at,'closedAt',p.closed_at,'deviceId',p.device_id)
$$;
create function private.device_pairing_verification(p_hash bytea) returns text
language sql immutable security invoker set search_path='' as $$
 select upper(substr(encode(p_hash,'hex'),1,4)||'-'||substr(encode(p_hash,'hex'),5,4)||'-'||substr(encode(p_hash,'hex'),9,4)||'-'||substr(encode(p_hash,'hex'),13,4))
$$;
create function private.device_access_actor(p_outlet_id public.ulid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare business public.ulid;actor public.ulid;actor_role text;
begin
 if not exists(select 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous) then raise insufficient_privilege using message='Sign in with the original phone account.';end if;
 select o.business_id into business from public.outlets o where o.id=p_outlet_id;
 if not found then raise insufficient_privilege using message='This screen cannot be changed.';end if;
 actor:=private.public_link_actor(business,p_outlet_id);
 -- The actor helper now holds the Auth row; recheck this additional condition
 -- after that lock, so an anonymous-account change cannot race authorization.
 if not exists(select 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous) then raise insufficient_privilege using message='Sign in with the original phone account.';end if;
 select m.role into actor_role from public.members m where m.business_id=business and m.id=actor;
 return jsonb_build_object('businessId',business,'outletId',p_outlet_id,'actorId',actor,'actorRole',actor_role);
end $$;

create function private.start_device_pairing(p_id public.ulid,p_event_id public.ulid,p_outlet_id public.ulid,p_name text,p_mode text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb;saved private.device_pairings;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;bytes bytea;candidate text;
begin
 perform pg_advisory_xact_lock(hashtextextended('mise-screen-pairing:'||p_outlet_id::text,0));
 scope:=private.device_access_actor(p_outlet_id);
 if p_id is null or p_event_id is null or p_id=p_event_id or p_name is null or p_name<>btrim(p_name) or length(p_name) not between 1 and 80 or p_name~'[[:cntrl:]]' or p_mode is null or p_mode not in ('kitchen','counter') then raise invalid_parameter_value using message='Choose the screen name and mode.';end if;
 select * into saved from private.device_pairings p where p.id=p_id for update;
 if found then
  if saved.business_id::text<>scope->>'businessId' or saved.outlet_id<>p_outlet_id or saved.created_by::text<>scope->>'actorId' or saved.event_id<>p_event_id or saved.name<>p_name or saved.mode<>p_mode then raise sqlstate 'PT409' using message='Keep the original pairing request.';end if;
  return private.device_pairing_metadata(saved);
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 update private.device_pairings p set closed_at=greatest(at_ms,p.created_at) where p.business_id=(scope->>'businessId')::public.ulid and p.outlet_id=p_outlet_id and p.closed_at is null and p.expires_at<=at_ms;
 if (select count(*) from private.device_pairings p where p.business_id=(scope->>'businessId')::public.ulid and p.outlet_id=p_outlet_id and p.closed_at is null)>=20 then raise sqlstate 'PT429' using message='Close an older pairing request first.';end if;
 for attempt in 1..10 loop
  bytes:=sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid()));
  candidate:=lpad(mod(get_byte(bytes,0)::bigint*16777216+get_byte(bytes,1)::bigint*65536+get_byte(bytes,2)::bigint*256+get_byte(bytes,3),1000000)::text,6,'0');
  begin
   insert into private.device_pairings(id,business_id,outlet_id,event_id,created_by,name,mode,code,created_at,expires_at)
    values(p_id,(scope->>'businessId')::public.ulid,p_outlet_id,p_event_id,(scope->>'actorId')::public.ulid,p_name,p_mode,candidate,at_ms,at_ms+600000) returning * into saved;
   exit;
  exception when unique_violation then if attempt=10 then raise sqlstate 'PT409' using message='Keep this request and check its outcome.';end if;end;
 end loop;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(p_event_id,saved.business_id,saved.outlet_id,'member',saved.created_by,'device.pairing_start','null',jsonb_build_object('id',saved.id,'name',saved.name,'mode',saved.mode,'expiresAt',saved.expires_at)::json,at_ms);
 return private.device_pairing_metadata(saved);
end $$;
create function private.inspect_device_pairing(p_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.device_pairings;scope jsonb;requests jsonb;
begin
 select * into saved from private.device_pairings p where p.id=p_id;
 if not found then raise insufficient_privilege using message='This pairing request is unavailable.';end if;
 scope:=private.device_access_actor(saved.outlet_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'verification',private.device_pairing_verification(r.token_hash),'createdAt',r.created_at,'approvedAt',r.approved_at) order by r.created_at,r.id),'[]') into requests from private.device_pairing_requests r where r.business_id=saved.business_id and r.outlet_id=saved.outlet_id and r.pairing_id=saved.id;
 return scope||jsonb_build_object('v',1,'pairing',private.device_pairing_metadata(saved),'requests',requests);
end $$;
create function private.request_device_pairing(p_id public.ulid,p_code text,p_pairing_id public.ulid,p_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.device_pairings;request private.device_pairing_requests;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if p_id is null or p_code is null or p_code!~'^[0-9]{6}$' or p_token_hash is null or p_token_hash!~'^[a-f0-9]{64}$' then raise invalid_parameter_value using message='Keep the screen request and code.';end if;
 select * into saved from private.device_pairings p where p.code=p_code and (p_pairing_id is null or p.id=p_pairing_id) and p.closed_at is null for update;
 if not found then return null;end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if saved.expires_at<=at_ms or saved.closed_at is not null then return null;end if;
 select * into request from private.device_pairing_requests r where r.id=p_id;
 if found then
  if request.pairing_id<>saved.id or request.token_hash<>decode(p_token_hash,'hex') then return null;end if;
 else
  if (select count(*) from private.device_pairing_requests r where r.pairing_id=saved.id)>=5 then return null;end if;
  insert into private.device_pairing_requests(id,business_id,outlet_id,pairing_id,token_hash,created_at)
   values(p_id,saved.business_id,saved.outlet_id,saved.id,decode(p_token_hash,'hex'),at_ms) returning * into request;
 end if;
 return jsonb_build_object('v',1,'id',request.id,'verification',private.device_pairing_verification(request.token_hash),'expiresAt',saved.expires_at);
end $$;
create function private.approve_device_pairing(p_pairing_id public.ulid,p_request_id public.ulid,p_verification text,p_event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.device_pairings;request private.device_pairing_requests;device private.devices;scope jsonb;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 select * into saved from private.device_pairings p where p.id=p_pairing_id;
 if not found then raise insufficient_privilege using message='This pairing request is unavailable.';end if;
 scope:=private.device_access_actor(saved.outlet_id);
 select * into saved from private.device_pairings p where p.id=p_pairing_id for update;
 select * into request from private.device_pairing_requests r where r.id=p_request_id and r.business_id=saved.business_id and r.outlet_id=saved.outlet_id and r.pairing_id=saved.id for update;
 if not found or p_verification is null or p_verification<>private.device_pairing_verification(request.token_hash) then raise invalid_parameter_value using message='Compare the complete verification shown on both screens.';end if;
 if request.approved_at is not null then
  select * into device from private.devices d where d.id=request.id and d.business_id=saved.business_id and d.outlet_id=saved.outlet_id;
  return private.device_metadata(device);
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if saved.closed_at is not null or saved.expires_at<=at_ms or p_event_id is null or p_event_id in (saved.id,request.id,saved.event_id) then raise sqlstate 'PT409' using message='Review this screen pairing again.';end if;
 insert into private.devices(id,business_id,outlet_id,name,mode,token_hash,created_by,created_at,expires_at)
  values(request.id,saved.business_id,saved.outlet_id,saved.name,saved.mode,request.token_hash,(scope->>'actorId')::public.ulid,at_ms,at_ms+7776000000) returning * into device;
 update private.device_pairing_requests r set approved_at=at_ms,approved_by=(scope->>'actorId')::public.ulid,approval_event_id=p_event_id where r.id=request.id;
 update private.device_pairings p set closed_at=at_ms,device_id=device.id where p.id=saved.id;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(p_event_id,device.business_id,device.outlet_id,'member',device.created_by,'device.enrol','null',private.device_metadata(device)::json,at_ms);
 return private.device_metadata(device);
end $$;
create function private.cancel_device_pairing(p_id public.ulid,p_event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.device_pairings;scope jsonb;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 select * into saved from private.device_pairings p where p.id=p_id;
 if not found then raise insufficient_privilege using message='This pairing request is unavailable.';end if;
 scope:=private.device_access_actor(saved.outlet_id);
 select * into saved from private.device_pairings p where p.id=p_id for update;
 if saved.closed_at is not null then return private.device_pairing_metadata(saved);end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if p_event_id is null or p_event_id in (saved.id,saved.event_id) then raise invalid_parameter_value using message='Keep the original cancellation identity.';end if;
 update private.device_pairings p set closed_at=greatest(at_ms,p.created_at) where p.id=saved.id returning * into saved;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(p_event_id,saved.business_id,saved.outlet_id,'member',(scope->>'actorId')::public.ulid,'device.pairing_cancel','null',jsonb_build_object('id',saved.id,'closedAt',saved.closed_at)::json,at_ms);
 return private.device_pairing_metadata(saved);
end $$;
create function private.read_device_pairing(p_request_id public.ulid,p_device_secret text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare request private.device_pairing_requests;saved private.device_pairings;device private.devices;outlet_name text;at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
 if p_device_secret is null or p_device_secret!~'^[A-Za-z0-9_-]{43}$' then return null;end if;
 select * into request from private.device_pairing_requests r where r.id=p_request_id and r.token_hash=sha256(convert_to(p_device_secret,'UTF8'));
 if not found then return null;end if;
 select * into saved from private.device_pairings p where p.id=request.pairing_id;
 if request.approved_at is not null then
  select * into device from private.devices d where d.id=request.id and d.token_hash=request.token_hash and d.business_id=request.business_id and d.outlet_id=request.outlet_id and d.revoked_at is null and d.expires_at>at_ms;
  if not found then return jsonb_build_object('v',1,'id',request.id,'state','cancelled');end if;
  select o.name into outlet_name from public.outlets o where o.business_id=device.business_id and o.id=device.outlet_id;
  return jsonb_build_object('v',1,'id',request.id,'state','approved','device',private.device_metadata(device),'outletNameJson',outlet_name);
 end if;
 if saved.expires_at<=at_ms then return jsonb_build_object('v',1,'id',request.id,'state','expired');end if;
 if saved.closed_at is not null then return jsonb_build_object('v',1,'id',request.id,'state','cancelled');end if;
 return jsonb_build_object('v',1,'id',request.id,'state','waiting','verification',private.device_pairing_verification(request.token_hash),'expiresAt',saved.expires_at);
end $$;
create function private.read_device_signin(p_device_secret text,p_after_id public.ulid,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare device private.devices;outlet_name text;members jsonb;next_id public.ulid;at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
 if p_device_secret is null or p_device_secret!~'^[A-Za-z0-9_-]{43}$' then return null;end if;
 if p_limit is null or p_limit not between 1 and 100 then raise invalid_parameter_value using message='Use a bounded staff page.';end if;
 select * into device from private.devices d where d.token_hash=sha256(convert_to(p_device_secret,'UTF8')) and d.revoked_at is null and d.expires_at>at_ms;
 if not found then return null;end if;
 select o.name into outlet_name from public.outlets o where o.business_id=device.business_id and o.id=device.outlet_id;
 with eligible as(select m.id,m.name from public.members m join private.staff_pins pin on pin.business_id=m.business_id and pin.member_id=m.id where m.business_id=device.business_id and (p_after_id is null or m.id>p_after_id) and private.staff_device_allowed(device,pin) and cardinality(private.device_permissions(device.mode,m.role,m.permissions))>0 order by m.id limit p_limit+1),
 page as(select * from eligible order by id limit p_limit)
 select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'nameJson',p.name::text) order by p.id) from page p),'[]'),case when (select count(*) from eligible)>p_limit then(select p.id from page p order by p.id desc limit 1)end into members,next_id;
 return jsonb_build_object('v',1,'device',private.device_metadata(device),'outletNameJson',outlet_name,'members',members,'next',next_id);
end $$;

revoke all on function private.device_pairing_metadata(private.device_pairings),private.device_pairing_verification(bytea),private.device_access_actor(public.ulid),private.start_device_pairing(public.ulid,public.ulid,public.ulid,text,text),private.inspect_device_pairing(public.ulid),private.approve_device_pairing(public.ulid,public.ulid,text,public.ulid),private.cancel_device_pairing(public.ulid,public.ulid),private.request_device_pairing(public.ulid,text,public.ulid,text),private.read_device_pairing(public.ulid,text),private.read_device_signin(text,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.start_device_pairing(public.ulid,public.ulid,public.ulid,text,text),private.inspect_device_pairing(public.ulid),private.approve_device_pairing(public.ulid,public.ulid,text,public.ulid),private.cancel_device_pairing(public.ulid,public.ulid) to authenticated;
grant execute on function private.request_device_pairing(public.ulid,text,public.ulid,text),private.read_device_pairing(public.ulid,text),private.read_device_signin(text,public.ulid,integer) to service_role;
create function public.start_device_pairing(p_id public.ulid,p_event_id public.ulid,p_outlet_id public.ulid,p_name text,p_mode text) returns jsonb language sql security invoker set search_path='' as $$select private.start_device_pairing(p_id,p_event_id,p_outlet_id,p_name,p_mode)$$;
create function public.inspect_device_pairing(p_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.inspect_device_pairing(p_id)$$;
create function public.approve_device_pairing(p_pairing_id public.ulid,p_request_id public.ulid,p_verification text,p_event_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.approve_device_pairing(p_pairing_id,p_request_id,p_verification,p_event_id)$$;
create function public.cancel_device_pairing(p_id public.ulid,p_event_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.cancel_device_pairing(p_id,p_event_id)$$;
create function public.request_device_pairing(p_id public.ulid,p_code text,p_pairing_id public.ulid,p_token_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.request_device_pairing(p_id,p_code,p_pairing_id,p_token_hash)$$;
create function public.read_device_pairing(p_request_id public.ulid,p_device_secret text) returns jsonb language sql security invoker set search_path='' as $$select private.read_device_pairing(p_request_id,p_device_secret)$$;
create function public.read_device_signin(p_device_secret text,p_after_id public.ulid,p_limit integer) returns jsonb language sql security invoker set search_path='' as $$select private.read_device_signin(p_device_secret,p_after_id,p_limit)$$;
revoke all on function public.start_device_pairing(public.ulid,public.ulid,public.ulid,text,text),public.inspect_device_pairing(public.ulid),public.approve_device_pairing(public.ulid,public.ulid,text,public.ulid),public.cancel_device_pairing(public.ulid,public.ulid),public.request_device_pairing(public.ulid,text,public.ulid,text),public.read_device_pairing(public.ulid,text),public.read_device_signin(text,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.start_device_pairing(public.ulid,public.ulid,public.ulid,text,text),public.inspect_device_pairing(public.ulid),public.approve_device_pairing(public.ulid,public.ulid,text,public.ulid),public.cancel_device_pairing(public.ulid,public.ulid) to authenticated;
grant execute on function public.request_device_pairing(public.ulid,text,public.ulid,text),public.read_device_pairing(public.ulid,text),public.read_device_signin(text,public.ulid,integer) to service_role;

create function private.read_device_admin(p_outlet_id public.ulid,p_kind text,p_after_id public.ulid,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb;entries jsonb;next_id public.ulid;
begin
 scope:=private.device_access_actor(p_outlet_id);
 if p_kind is null or p_kind not in ('devices','pairings','members') or p_limit is null or p_limit not between 1 and 100 then raise invalid_parameter_value using message='Choose a bounded device settings page.';end if;
 if p_kind='members' and scope->>'actorRole'<>'owner' then raise insufficient_privilege using message='Only the owner can manage staff PINs.';end if;
 with selected as(
  select d.id,private.device_metadata(d) value from private.devices d where p_kind='devices' and d.business_id=(scope->>'businessId')::public.ulid and d.outlet_id=p_outlet_id
  union all
  select p.id,private.device_pairing_metadata(p) from private.device_pairings p where p_kind='pairings' and p.business_id=(scope->>'businessId')::public.ulid and p.outlet_id=p_outlet_id
  union all
  select m.id,jsonb_build_object('id',m.id,'nameJson',m.name::text,'role',m.role,'active',m.active,
   'assigned',exists(select 1 from public.member_outlets a where a.business_id=m.business_id and a.outlet_id=p_outlet_id and a.member_id=m.id),
   'configured',exists(select 1 from private.staff_pins p where p.business_id=m.business_id and p.member_id=m.id))
  from public.members m where p_kind='members' and m.business_id=(scope->>'businessId')::public.ulid and
   (m.role in ('staff','kitchen') or exists(select 1 from private.staff_pins p where p.business_id=m.business_id and p.member_id=m.id))
 ),bounded as(select * from selected where p_after_id is null or id>p_after_id order by id limit p_limit+1),page as(select * from bounded order by id limit p_limit)
 select coalesce((select jsonb_agg(p.value order by p.id) from page p),'[]'),case when(select count(*) from bounded)>p_limit then(select p.id from page p order by p.id desc limit 1)end into entries,next_id;
 return scope||jsonb_build_object('v',1,'kind',p_kind,'entries',entries,'next',next_id);
end $$;
revoke all on function private.read_device_admin(public.ulid,text,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_device_admin(public.ulid,text,public.ulid,integer) to authenticated;
create function public.read_device_admin(p_outlet_id public.ulid,p_kind text,p_after_id public.ulid,p_limit integer) returns jsonb
language sql security invoker set search_path='' as $$select private.read_device_admin(p_outlet_id,p_kind,p_after_id,p_limit)$$;
revoke all on function public.read_device_admin(public.ulid,text,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_device_admin(public.ulid,text,public.ulid,integer) to authenticated;

-- Recovery of a PIN response that never reached the browser. The durable
-- attempt ID is retired before any later finish, including a begin that has
-- not reached SQL yet. This never resets PIN guessing counters or enrollment.
create function private.reset_device_signins(p_device_secret text,p_id public.ulid,p_attempt_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d private.devices;a private.staff_pin_attempts;e public.events;result jsonb;
 at_ms public.utc_ms;
begin
 if p_device_secret is null or p_device_secret!~'^[A-Za-z0-9_-]{43}$' or p_id is null or p_attempt_id=p_id then return null;end if;
 select * into d from private.devices x where x.token_hash=sha256(convert_to(p_device_secret,'UTF8')) for update;
 if not found then return null;end if;
 select * into e from public.events x where x.id=p_id;
 if found then
  if e.business_id is distinct from d.business_id or e.outlet_id is distinct from d.outlet_id or e.command is distinct from 'device.signins_reset'
    or e.actor_type is distinct from 'system' or e.actor_id is distinct from d.id or e.after_data::jsonb is distinct from jsonb_build_object('id',p_id,'deviceId',d.id,'signedOut',true,'attemptId',p_attempt_id)
    then raise insufficient_privilege using message='Keep the original screen sign-out.';end if;
  return jsonb_build_object('id',p_id,'deviceId',d.id,'signedOut',true);
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if p_attempt_id is not null then
  select * into a from private.staff_pin_attempts x where x.id=p_attempt_id for update;
  if found then
   if a.device_id<>d.id then return null;end if;
   update private.staff_pin_attempts x set used_at=coalesce(x.used_at,greatest(at_ms,x.created_at)) where x.id=p_attempt_id;
  else
   insert into private.staff_pin_attempts(id,business_id,outlet_id,device_id,device_window,created_at,expires_at,used_at)
    values(p_attempt_id,d.business_id,d.outlet_id,d.id,d.window_start,at_ms,at_ms+60000,at_ms);
  end if;
 end if;
 -- Finish and begin also lock the device first. Retiring the outstanding
 -- attempts and sessions under that lock closes both orders of the race.
 update private.staff_pin_attempts x set used_at=greatest(at_ms,x.created_at)
  where x.business_id=d.business_id and x.outlet_id=d.outlet_id and x.device_id=d.id and x.used_at is null;
 update private.device_sessions x set revoked_at=greatest(at_ms,x.created_at)
  where x.business_id=d.business_id and x.outlet_id=d.outlet_id and x.device_id=d.id and x.revoked_at is null;
 result:=jsonb_build_object('id',p_id,'deviceId',d.id,'signedOut',true);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(p_id,d.business_id,d.outlet_id,'system',d.id,'device.signins_reset','null',(result||jsonb_build_object('attemptId',p_attempt_id))::json,at_ms);
 return result;
end $$;
revoke all on function private.reset_device_signins(text,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.reset_device_signins(text,public.ulid,public.ulid) to service_role;
create function public.reset_device_signins(p_device_secret text,p_id public.ulid,p_attempt_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.reset_device_signins(p_device_secret,p_id,p_attempt_id)$$;
revoke all on function public.reset_device_signins(text,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.reset_device_signins(text,public.ulid,public.ulid) to service_role;
