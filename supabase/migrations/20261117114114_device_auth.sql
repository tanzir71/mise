-- Shared screens carry a device secret; a PIN creates a separate short session.
-- This does not grant raw-table access or enable staff commands/screens.
create table private.devices (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  name text not null check(length(btrim(name)) between 1 and 80), mode text not null check(mode in ('kitchen','counter')),
  token_hash bytea not null unique check(octet_length(token_hash)=32),
  created_by public.ulid not null, created_at public.utc_ms not null, expires_at public.utc_ms not null,
  revoked_at public.utc_ms check(revoked_at>=created_at),
  window_start public.utc_ms not null default 0, attempts integer not null default 0 check(attempts between 0 and 5),
  check(expires_at>created_at and expires_at<=created_at+7776000000), unique(business_id,outlet_id,id),
  foreign key(business_id,outlet_id) references public.outlets(business_id,id),
  foreign key(business_id,created_by) references public.members(business_id,id)
);
create table private.staff_pins (
  business_id public.ulid not null, member_id public.ulid primary key, revision public.ulid not null,
  -- Retain the identity snapshot if Auth deletion sets members.auth_user_id to null.
  auth_user_id uuid,
  salt bytea not null check(octet_length(salt)=16), verifier bytea not null check(octet_length(verifier)=32),
  pepper_version text not null check(pepper_version ~ '^v[1-9][0-9]{0,3}$'),
  changed_by public.ulid not null, changed_at public.utc_ms not null,
  window_start public.utc_ms not null default 0, attempts integer not null default 0 check(attempts between 0 and 5),
  foreign key(business_id,member_id) references public.members(business_id,id),
  foreign key(business_id,changed_by) references public.members(business_id,id)
);
create table private.staff_pin_attempts (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  device_id public.ulid not null, member_id public.ulid, pin_revision public.ulid,
  device_window public.utc_ms not null, member_window public.utc_ms,
  created_at public.utc_ms not null, expires_at public.utc_ms not null check(expires_at=created_at+60000), used_at public.utc_ms,
  foreign key(business_id,outlet_id,device_id) references private.devices(business_id,outlet_id,id),
  foreign key(business_id,member_id) references public.members(business_id,id)
);
create table private.device_sessions (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  device_id public.ulid not null, member_id public.ulid not null, pin_revision public.ulid not null,
  token_hash bytea not null unique check(octet_length(token_hash)=32),
  created_at public.utc_ms not null, expires_at public.utc_ms not null check(expires_at=created_at+43200000),
  revoked_at public.utc_ms check(revoked_at>=created_at),
  foreign key(business_id,outlet_id,device_id) references private.devices(business_id,outlet_id,id),
  foreign key(business_id,member_id) references public.members(business_id,id)
);
alter table private.devices enable row level security; alter table private.devices force row level security;
alter table private.staff_pins enable row level security; alter table private.staff_pins force row level security;
alter table private.staff_pin_attempts enable row level security; alter table private.staff_pin_attempts force row level security;
alter table private.device_sessions enable row level security; alter table private.device_sessions force row level security;
revoke all on private.devices,private.staff_pins,private.staff_pin_attempts,private.device_sessions from public,anon,authenticated,service_role;
create index devices_outlet_idx on private.devices(business_id,outlet_id,created_at,id);
create index devices_creator_idx on private.devices(business_id,created_by);
create index staff_pins_changer_idx on private.staff_pins(business_id,changed_by);
create index pin_attempts_device_idx on private.staff_pin_attempts(business_id,outlet_id,device_id,created_at);
create index pin_attempts_member_idx on private.staff_pin_attempts(business_id,member_id,created_at);
create index device_sessions_device_idx on private.device_sessions(business_id,outlet_id,device_id,created_at);
create index device_sessions_member_idx on private.device_sessions(business_id,member_id,created_at);

create function private.device_metadata(d private.devices) returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',d.id,'businessId',d.business_id,'outletId',d.outlet_id,'name',d.name,'mode',d.mode,
    'createdAt',d.created_at,'expiresAt',d.expires_at,'revokedAt',d.revoked_at)
$$;
create function private.device_permissions(mode text,member_role text,permissions jsonb) returns text[]
language sql immutable security invoker set search_path='' as $$
  select coalesce(array_agg(k order by k),'{}'::text[]) from unnest(case when mode='kitchen' then
    array['orders.read','orders.acknowledge','orders.ready'] else
    array['counter.sell','orders.read','orders.create','orders.price','khata.read','khata.collect'] end) k
  where case when permissions ? k then permissions->k='true'::jsonb else mode='kitchen' and member_role='kitchen' end
$$;
create function private.staff_device_allowed(d private.devices,p private.staff_pins) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.members m join public.member_outlets a on a.business_id=m.business_id and a.member_id=m.id
    where m.business_id=d.business_id and m.id=p.member_id and a.outlet_id=d.outlet_id and m.active
      and (m.role='staff' or (m.role='kitchen' and d.mode='kitchen'))
      and m.auth_user_id is not distinct from p.auth_user_id
      and (p.auth_user_id is null or exists(select 1 from auth.users u where u.id=p.auth_user_id and u.deleted_at is null
        and (u.banned_until is null or u.banned_until<=statement_timestamp()))))
$$;
create function private.enrol_device(device_id public.ulid,event_id public.ulid,outlet public.ulid,label text,device_mode text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid; actor public.ulid; secret text; saved private.devices;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This device cannot be changed.'; end if;
  select o.business_id into business from public.outlets o where o.id=outlet;
  if not found then raise insufficient_privilege using message='This device cannot be changed.'; end if;
  actor:=private.public_link_actor(business,outlet);
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  insert into private.devices(id,business_id,outlet_id,name,mode,token_hash,created_by,created_at,expires_at)
    values(device_id,business,outlet,label,device_mode,sha256(convert_to(secret,'UTF8')),actor,at_ms,at_ms+7776000000) returning * into saved;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,business,outlet,'member',actor,'device.enrol','null',private.device_metadata(saved)::json,at_ms);
  return private.device_metadata(saved)||jsonb_build_object('token',secret);
end $$;
create function private.revoke_device(device_id public.ulid,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.devices; actor public.ulid; previous jsonb; at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This device cannot be changed.'; end if;
  select * into saved from private.devices d where d.id=device_id for update;
  if not found then raise insufficient_privilege using message='This device cannot be changed.'; end if;
  actor:=private.public_link_actor(saved.business_id,saved.outlet_id);
  if saved.revoked_at is not null then return private.device_metadata(saved); end if;
  previous:=private.device_metadata(saved);
  update private.devices d set revoked_at=greatest(at_ms,d.created_at) where d.id=device_id returning * into saved;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,saved.business_id,saved.outlet_id,'member',actor,'device.revoke',previous::json,private.device_metadata(saved)::json,at_ms);
  return private.device_metadata(saved);
end $$;

-- The global member PIN is owner-managed. Managers manage their outlet's devices.
-- The Edge Function derives this verifier using its pepper; raw PINs never enter SQL.
create function private.set_staff_pin(outlet public.ulid,member public.ulid,event_id public.ulid,salt_hex text,verifier_hex text,pepper text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid; actor public.ulid; linked_auth uuid;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint; result jsonb;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This PIN cannot be changed.'; end if;
  select m.business_id,m.auth_user_id into business,linked_auth from public.members m join public.member_outlets a on a.business_id=m.business_id and a.member_id=m.id
    where m.id=member and a.outlet_id=outlet and m.active and m.role in ('staff','kitchen');
  if not found then raise insufficient_privilege using message='This PIN cannot be changed.'; end if;
  actor:=private.public_link_actor(business,outlet);
  if not exists(select 1 from public.members m where m.id=actor and m.role='owner') then
    raise insufficient_privilege using message='This PIN cannot be changed.';
  end if;
  if salt_hex is null or salt_hex!~'^[0-9a-f]{32}$' or verifier_hex is null or verifier_hex!~'^[0-9a-f]{64}$'
    or pepper is null or pepper!~'^v[1-9][0-9]{0,3}$' then raise invalid_parameter_value using message='Invalid PIN credential.'; end if;
  insert into private.staff_pins(business_id,member_id,auth_user_id,revision,salt,verifier,pepper_version,changed_by,changed_at)
    values(business,member,linked_auth,event_id,decode(salt_hex,'hex'),decode(verifier_hex,'hex'),pepper,actor,at_ms)
    on conflict(member_id) do update set auth_user_id=excluded.auth_user_id,revision=excluded.revision,salt=excluded.salt,verifier=excluded.verifier,
      pepper_version=excluded.pepper_version,changed_by=excluded.changed_by,changed_at=excluded.changed_at,window_start=0,attempts=0;
  result:=jsonb_build_object('memberId',member,'revision',event_id,'changedAt',at_ms);
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,business,outlet,'member',actor,'staff_pin.set','null',result::json,at_ms);
  return result;
end $$;

-- Service-only, two-step verification. Reserve each try before the expensive KDF.
-- Returning failure normally (rather than raising) preserves the charged attempt.
create function private.begin_staff_pin(attempt_id public.ulid,device_secret text,member public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d private.devices; p private.staff_pins; eligible boolean; pin_window public.utc_ms;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if device_secret is null or device_secret!~'^[A-Za-z0-9_-]{43}$' then return null; end if;
  select * into d from private.devices x where x.token_hash=sha256(convert_to(device_secret,'UTF8')) and x.revoked_at is null and x.expires_at>at_ms for update;
  if not found then return null; end if;
  if d.window_start+900000<=at_ms then d.window_start:=at_ms;d.attempts:=0;end if;
  if d.attempts>=5 then return jsonb_build_object('allowed',false,'retryAt',d.window_start+900000);end if;
  update private.devices x set window_start=d.window_start,attempts=d.attempts+1 where x.id=d.id;
  select * into p from private.staff_pins x where x.business_id=d.business_id and x.member_id=member for update;
  eligible:=found and private.staff_device_allowed(d,p);
  if eligible then
    if p.window_start+900000<=at_ms then p.window_start:=at_ms;p.attempts:=0;end if;
    if p.attempts>=5 then return jsonb_build_object('allowed',false,'retryAt',p.window_start+900000);end if;
    pin_window:=p.window_start;
    update private.staff_pins x set window_start=p.window_start,attempts=p.attempts+1 where x.member_id=member;
  end if;
  insert into private.staff_pin_attempts(id,business_id,outlet_id,device_id,member_id,pin_revision,device_window,member_window,created_at,expires_at)
    values(attempt_id,d.business_id,d.outlet_id,d.id,case when eligible then member end,case when eligible then p.revision end,
      d.window_start,pin_window,at_ms,at_ms+60000);
  return jsonb_build_object('allowed',true,'attemptId',attempt_id,'businessId',d.business_id,'memberId',member,
    'salt',case when eligible then encode(p.salt,'hex') else substr(encode(sha256(uuid_send(gen_random_uuid())),'hex'),1,32) end,
    'pepperVersion',case when eligible then p.pepper_version else 'v1' end,'expiresAt',at_ms+60000);
end $$;
create function private.finish_staff_pin(device_secret text,attempt_id public.ulid,candidate text,session_id public.ulid,event_id public.ulid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.devices; a private.staff_pin_attempts; p private.staff_pins; secret text; result jsonb;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if device_secret is null or device_secret!~'^[A-Za-z0-9_-]{43}$' then return null; end if;
  select * into d from private.devices x where x.token_hash=sha256(convert_to(device_secret,'UTF8')) and x.revoked_at is null and x.expires_at>at_ms for update;
  if not found then return null;end if;
  select * into a from private.staff_pin_attempts x where x.id=attempt_id and x.device_id=d.id for update;
  if not found or a.used_at is not null or a.expires_at<=at_ms then return null;end if;
  update private.staff_pin_attempts x set used_at=at_ms where x.id=a.id;
  select * into p from private.staff_pins x where x.business_id=d.business_id and x.member_id=a.member_id and x.revision=a.pin_revision for update;
  if not found or candidate is null or candidate!~'^[0-9a-f]{64}$' then return null;end if;
  if p.verifier<>decode(candidate,'hex') or not private.staff_device_allowed(d,p) then return null;end if;
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  insert into private.device_sessions(id,business_id,outlet_id,device_id,member_id,pin_revision,token_hash,created_at,expires_at)
    values(session_id,d.business_id,d.outlet_id,d.id,p.member_id,p.revision,sha256(convert_to(secret,'UTF8')),at_ms,at_ms+43200000);
  update private.devices x set attempts=greatest(x.attempts-1,0) where x.id=d.id and x.window_start=a.device_window;
  update private.staff_pins x set attempts=greatest(x.attempts-1,0) where x.member_id=p.member_id and x.window_start=a.member_window;
  result:=jsonb_build_object('id',session_id,'deviceId',d.id,'memberId',p.member_id,'createdAt',at_ms,'expiresAt',at_ms+43200000);
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,d.business_id,d.outlet_id,'member',p.member_id,'device.session_start','null',result::json,at_ms);
  return result||jsonb_build_object('token',secret);
end $$;
create function private.read_device_session(device_secret text,session_secret text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
  if device_secret is null or device_secret!~'^[A-Za-z0-9_-]{43}$' or session_secret is null or session_secret!~'^[A-Za-z0-9_-]{43}$' then return null;end if;
  select jsonb_build_object('v',1,'sessionId',s.id,'deviceId',d.id,'businessId',d.business_id,'outletId',d.outlet_id,
    'memberId',m.id,'role',m.role,'mode',d.mode,'permissions',private.device_permissions(d.mode,m.role,m.permissions),'expiresAt',s.expires_at)
    into result from private.devices d join private.device_sessions s on s.device_id=d.id and s.business_id=d.business_id and s.outlet_id=d.outlet_id
    join private.staff_pins p on p.business_id=s.business_id and p.member_id=s.member_id and p.revision=s.pin_revision
    join public.members m on m.business_id=s.business_id and m.id=s.member_id
    where d.token_hash=sha256(convert_to(device_secret,'UTF8')) and s.token_hash=sha256(convert_to(session_secret,'UTF8'))
      and d.revoked_at is null and d.expires_at>at_ms and s.revoked_at is null and s.expires_at>at_ms and private.staff_device_allowed(d,p);
  return result;
end $$;

create function private.clear_staff_pin(outlet public.ulid,member public.ulid,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid; actor public.ulid; previous private.staff_pins;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  select o.business_id into business from public.outlets o join public.members m on m.business_id=o.business_id where o.id=outlet and m.id=member;
  if not found then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  actor:=private.public_link_actor(business,outlet);
  if not exists(select 1 from public.members m where m.id=actor and m.role='owner') then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  select * into previous from private.staff_pins p where p.business_id=business and p.member_id=member for update;
  if not found then return jsonb_build_object('memberId',member,'cleared',true);end if;
  delete from private.staff_pins p where p.member_id=member;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,business,outlet,'member',actor,'staff_pin.clear',json_build_object('memberId',member,'revision',previous.revision),
      json_build_object('memberId',member,'cleared',true),at_ms);
  return jsonb_build_object('memberId',member,'cleared',true);
end $$;
create function private.end_device_session(device_secret text,session_secret text,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d private.devices; s private.device_sessions; result jsonb;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if device_secret is null or device_secret!~'^[A-Za-z0-9_-]{43}$' or session_secret is null or session_secret!~'^[A-Za-z0-9_-]{43}$' then return null;end if;
  select * into d from private.devices x where x.token_hash=sha256(convert_to(device_secret,'UTF8')) for update;
  if not found then return null;end if;
  select * into s from private.device_sessions x where x.device_id=d.id and x.token_hash=sha256(convert_to(session_secret,'UTF8')) for update;
  if not found then return null;end if;
  if s.revoked_at is not null then return jsonb_build_object('sessionId',s.id,'signedOut',true);end if;
  update private.device_sessions x set revoked_at=greatest(at_ms,x.created_at) where x.id=s.id;
  result:=jsonb_build_object('sessionId',s.id,'signedOut',true);
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,d.business_id,d.outlet_id,'member',s.member_id,'device.session_end','null',result::json,greatest(at_ms,s.created_at));
  return result;
end $$;

-- No client executes internal helpers; exposed entry points are invokers.
revoke all on function private.device_metadata(private.devices),private.device_permissions(text,text,jsonb),private.staff_device_allowed(private.devices,private.staff_pins),
  private.enrol_device(public.ulid,public.ulid,public.ulid,text,text),private.revoke_device(public.ulid,public.ulid),
  private.set_staff_pin(public.ulid,public.ulid,public.ulid,text,text,text),private.begin_staff_pin(public.ulid,text,public.ulid),
  private.finish_staff_pin(text,public.ulid,text,public.ulid,public.ulid),private.read_device_session(text,text),
  private.clear_staff_pin(public.ulid,public.ulid,public.ulid),private.end_device_session(text,text,public.ulid)
  from public,anon,authenticated,service_role;
grant execute on function private.enrol_device(public.ulid,public.ulid,public.ulid,text,text),private.revoke_device(public.ulid,public.ulid),
  private.set_staff_pin(public.ulid,public.ulid,public.ulid,text,text,text),private.clear_staff_pin(public.ulid,public.ulid,public.ulid) to authenticated;
grant usage on schema private to service_role;
grant execute on function private.begin_staff_pin(public.ulid,text,public.ulid),private.finish_staff_pin(text,public.ulid,text,public.ulid,public.ulid) to service_role;
grant execute on function private.read_device_session(text,text) to anon,authenticated,service_role;
grant execute on function private.end_device_session(text,text,public.ulid) to anon,authenticated,service_role;
create function public.enrol_device(p_id public.ulid,p_event_id public.ulid,p_outlet_id public.ulid,p_name text,p_mode text) returns jsonb
language sql security invoker set search_path='' as $$select private.enrol_device(p_id,p_event_id,p_outlet_id,p_name,p_mode)$$;
create function public.revoke_device(p_id public.ulid,p_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.revoke_device(p_id,p_event_id)$$;
create function public.set_staff_pin(p_outlet_id public.ulid,p_member_id public.ulid,p_event_id public.ulid,p_salt text,p_verifier text,p_pepper_version text) returns jsonb
language sql security invoker set search_path='' as $$select private.set_staff_pin(p_outlet_id,p_member_id,p_event_id,p_salt,p_verifier,p_pepper_version)$$;
create function public.begin_staff_pin(p_attempt_id public.ulid,p_device_token text,p_member_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.begin_staff_pin(p_attempt_id,p_device_token,p_member_id)$$;
create function public.finish_staff_pin(p_device_token text,p_attempt_id public.ulid,p_candidate text,p_session_id public.ulid,p_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_staff_pin(p_device_token,p_attempt_id,p_candidate,p_session_id,p_event_id)$$;
create function public.read_device_session(p_device_token text,p_session_token text) returns jsonb
language sql stable security invoker set search_path='' as $$select private.read_device_session(p_device_token,p_session_token)$$;
create function public.clear_staff_pin(p_outlet_id public.ulid,p_member_id public.ulid,p_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.clear_staff_pin(p_outlet_id,p_member_id,p_event_id)$$;
create function public.end_device_session(p_device_token text,p_session_token text,p_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.end_device_session(p_device_token,p_session_token,p_event_id)$$;
revoke all on function public.enrol_device(public.ulid,public.ulid,public.ulid,text,text),public.revoke_device(public.ulid,public.ulid),
  public.set_staff_pin(public.ulid,public.ulid,public.ulid,text,text,text),public.begin_staff_pin(public.ulid,text,public.ulid),
  public.finish_staff_pin(text,public.ulid,text,public.ulid,public.ulid),public.read_device_session(text,text),
  public.clear_staff_pin(public.ulid,public.ulid,public.ulid),public.end_device_session(text,text,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.enrol_device(public.ulid,public.ulid,public.ulid,text,text),public.revoke_device(public.ulid,public.ulid),
  public.set_staff_pin(public.ulid,public.ulid,public.ulid,text,text,text),public.clear_staff_pin(public.ulid,public.ulid,public.ulid) to authenticated;
grant execute on function public.begin_staff_pin(public.ulid,text,public.ulid),public.finish_staff_pin(text,public.ulid,text,public.ulid,public.ulid) to service_role;
grant execute on function public.read_device_session(text,text) to anon,authenticated,service_role;
grant execute on function public.end_device_session(text,text,public.ulid) to anon,authenticated,service_role;
