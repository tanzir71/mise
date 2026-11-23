-- Attendance is an explicit outlet permission. Legacy work rights are unchanged.
-- A rider, or a kitchen member on a counter, receives only own check-in rights.
create function private.device_staff_permissions(d private.devices,m public.members) returns text[]
language sql stable security invoker set search_path='' as $$
 select coalesce(array_agg(distinct permission order by permission),'{}'::text[]) from unnest(
  case when m.active and m.business_id=d.business_id and (m.role='staff' or m.role='kitchen' and d.mode='kitchen')
   then private.device_permissions(d.mode,m.role,m.permissions) else '{}'::text[] end
  ||case when m.active and m.business_id=d.business_id and m.role in('staff','kitchen','rider') and exists(select 1 from private.staff_profiles profile where profile.business_id=m.business_id and profile.outlet_id=d.outlet_id and profile.member_id=m.id and profile.profile->'methods' ? 'order_phone')
   then array['staff.check-in'] else '{}'::text[] end
 ) permission
$$;
revoke all on function private.device_staff_permissions(private.devices,public.members) from public,anon,authenticated,service_role;

create or replace function private.staff_device_allowed(d private.devices,p private.staff_pins) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.members m join public.member_outlets a on a.business_id=m.business_id and a.member_id=m.id
    where m.business_id=d.business_id and m.id=p.member_id and a.outlet_id=d.outlet_id and m.active
      and (m.role='staff' or (m.role='kitchen' and d.mode='kitchen') or (m.role in('kitchen','rider') and exists(select 1 from private.staff_profiles profile where profile.business_id=m.business_id and profile.outlet_id=d.outlet_id and profile.member_id=m.id and profile.profile->'methods' ? 'order_phone')))
      and m.auth_user_id is not distinct from p.auth_user_id
      and (p.auth_user_id is null or exists(select 1 from auth.users u where u.id=p.auth_user_id and u.deleted_at is null and not u.is_anonymous
        and (u.banned_until is null or u.banned_until<=statement_timestamp()))))
$$;

create or replace function private.read_device_session(device_secret text,session_secret text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
  if device_secret is null or device_secret!~'^[A-Za-z0-9_-]{43}$' or session_secret is null or session_secret!~'^[A-Za-z0-9_-]{43}$' then return null;end if;
  select jsonb_build_object('v',1,'sessionId',s.id,'deviceId',d.id,'businessId',d.business_id,'outletId',d.outlet_id,
    'memberId',m.id,'role',m.role,'mode',d.mode,'permissions',private.device_staff_permissions(d,m),'expiresAt',s.expires_at)
    into result from private.devices d join private.device_sessions s on s.device_id=d.id and s.business_id=d.business_id and s.outlet_id=d.outlet_id
    join private.staff_pins p on p.business_id=s.business_id and p.member_id=s.member_id and p.revision=s.pin_revision
    join public.members m on m.business_id=s.business_id and m.id=s.member_id
    where d.token_hash=sha256(convert_to(device_secret,'UTF8')) and s.token_hash=sha256(convert_to(session_secret,'UTF8'))
      and d.revoked_at is null and d.expires_at>at_ms and s.revoked_at is null and s.expires_at>at_ms and private.staff_device_allowed(d,p);
  return result;
end $$;

create or replace function private.read_device_signin(p_device_secret text,p_after_id public.ulid,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare device private.devices;outlet_name text;members jsonb;next_id public.ulid;at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
 if p_device_secret is null or p_device_secret!~'^[A-Za-z0-9_-]{43}$' then return null;end if;
 if p_limit is null or p_limit not between 1 and 100 then raise invalid_parameter_value using message='Use a bounded staff page.';end if;
 select * into device from private.devices d where d.token_hash=sha256(convert_to(p_device_secret,'UTF8')) and d.revoked_at is null and d.expires_at>at_ms;
 if not found then return null;end if;
 select o.name into outlet_name from public.outlets o where o.business_id=device.business_id and o.id=device.outlet_id;
 with eligible as(select m.id,m.name from public.members m join private.staff_pins pin on pin.business_id=m.business_id and pin.member_id=m.id where m.business_id=device.business_id and (p_after_id is null or m.id>p_after_id) and private.staff_device_allowed(device,pin) and cardinality(private.device_staff_permissions(device,m))>0 order by m.id limit p_limit+1),
 page as(select * from eligible order by id limit p_limit)
 select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'nameJson',p.name::text) order by p.id) from page p),'[]'),case when (select count(*) from eligible)>p_limit then(select p.id from page p order by p.id desc limit 1)end into members,next_id;
 return jsonb_build_object('v',1,'device',private.device_metadata(device),'outletNameJson',outlet_name,'members',members,'next',next_id);
end $$;

create or replace function private.staff_pin_context(outlet public.ulid,member public.ulid,action text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid; actor public.ulid; target public.members; configured boolean;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  if action is null or action not in ('set','clear') then raise invalid_parameter_value using message='Choose set or clear.';end if;
  select m.* into target from public.members m join public.outlets o on o.business_id=m.business_id where m.id=member and o.id=outlet;
  if not found then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  business:=target.business_id;
  actor:=private.public_shop_actor(outlet);
  if not exists(select 1 from public.members m where m.id=actor and m.role='owner') then
    raise insufficient_privilege using message='This PIN cannot be changed.';
  end if;
  if action='set' and (not target.active or (target.role not in ('staff','kitchen') and not(target.role='rider' and exists(select 1 from private.staff_profiles profile where profile.business_id=business and profile.outlet_id=outlet and profile.member_id=member and profile.profile->'methods' ? 'order_phone'))) or not exists(
    select 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=member)) then
    raise insufficient_privilege using message='This PIN cannot be changed.';
  end if;
  select exists(select 1 from private.staff_pins p where p.business_id=business and p.member_id=member) into configured;
  return jsonb_build_object('businessId',business,'outletId',outlet,'memberId',member,'configured',configured);
end $$;

create or replace function private.set_staff_pin(outlet public.ulid,member public.ulid,event_id public.ulid,salt_hex text,verifier_hex text,pepper text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid; actor public.ulid; linked_auth uuid;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint; result jsonb;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This PIN cannot be changed.'; end if;
  select m.business_id,m.auth_user_id into business,linked_auth from public.members m join public.member_outlets a on a.business_id=m.business_id and a.member_id=m.id
    where m.id=member and a.outlet_id=outlet and m.active and (m.role in ('staff','kitchen') or (m.role='rider' and exists(select 1 from private.staff_profiles profile where profile.business_id=m.business_id and profile.outlet_id=outlet and profile.member_id=m.id and profile.profile->'methods' ? 'order_phone')));
  if not found then raise insufficient_privilege using message='This PIN cannot be changed.'; end if;
  actor:=private.public_shop_actor(outlet);
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

create or replace function private.clear_staff_pin(outlet public.ulid,member public.ulid,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid; actor public.ulid; previous private.staff_pins;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  select o.business_id into business from public.outlets o join public.members m on m.business_id=o.business_id where o.id=outlet and m.id=member;
  if not found then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  actor:=private.public_shop_actor(outlet);
  if not exists(select 1 from public.members m where m.id=actor and m.role='owner') then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  select * into previous from private.staff_pins p where p.business_id=business and p.member_id=member for update;
  if not found then return jsonb_build_object('memberId',member,'cleared',true);end if;
  delete from private.staff_pins p where p.member_id=member;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,business,outlet,'member',actor,'staff_pin.clear',json_build_object('memberId',member,'revision',previous.revision),
      json_build_object('memberId',member,'cleared',true),at_ms);
  return jsonb_build_object('memberId',member,'cleared',true);
end $$;

-- Own attendance transaction follows below.
create table private.staff_device_actions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,device_id public.ulid not null,
 member_id public.ulid not null,session_id public.ulid not null references private.device_sessions(id),
 intent jsonb not null,state text not null check(state in('applied','closed')),receipt jsonb not null,created_at public.utc_ms not null,
 foreign key(business_id,outlet_id,device_id) references private.devices(business_id,outlet_id,id),
 foreign key(business_id,member_id) references public.members(business_id,id)
);
create index staff_device_actions_scope on private.staff_device_actions(business_id,outlet_id,device_id,member_id,state,id);
create index staff_device_actions_member on private.staff_device_actions(business_id,member_id);
create index staff_device_actions_session on private.staff_device_actions(session_id);
create index staff_device_actions_closures on private.staff_device_actions(device_id,member_id,state);
create table private.staff_device_budget (
 device_id public.ulid primary key references private.devices(id),window_at bigint not null,requests integer not null check(requests between 1 and 60001)
);
alter table private.staff_device_actions enable row level security;alter table private.staff_device_actions force row level security;
alter table private.staff_device_budget enable row level security;alter table private.staff_device_budget force row level security;
revoke all on private.staff_device_actions,private.staff_device_budget from public,anon,authenticated,service_role;

create function private.staff_attendance_intent_valid(source jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 return source is not null and private.staff_exact(source::json,array['eventId','expectedLastId','id','memberId','occurredAt','outletId','type','v'])
  and source->'v'='1'::jsonb and not exists(select 1 from jsonb_each(source) e where e.key in('id','eventId','memberId','outletId','type') and jsonb_typeof(e.value)<>'string')
  and (source->>'id')~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' and (source->>'eventId')~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
  and (source->>'memberId')~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' and (source->>'outletId')~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
  and (select count(distinct v) from unnest(array[source->>'id',source->>'eventId',source->>'memberId',source->>'outletId']) v)=4
  and source->>'type' in('in','out','break') and jsonb_typeof(source->'occurredAt')='number' and (source->>'occurredAt')~'^(0|[1-9][0-9]*)$'
  and (source->>'occurredAt')::numeric<=8640000000000000 and jsonb_typeof(source->'expectedLastId') in('null','string')
  and (jsonb_typeof(source->'expectedLastId')='null' or (source->>'expectedLastId')~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    and source->>'expectedLastId' not in(source->>'id',source->>'eventId',source->>'memberId',source->>'outletId'));
exception when others then return false;
end $$;
revoke all on function private.staff_attendance_intent_valid(jsonb) from public,anon,authenticated,service_role;

create function private.visit_staff_device(device_secret text,session_secret text,operation text,source jsonb,after_cursor jsonb,request_limit integer) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor jsonb;fresh jsonb;business public.ulid;outlet public.ulid;device public.ulid;member public.ulid;session_id public.ulid;
 at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;window_at bigint;request_count integer;retry_after integer;
 saved private.staff_device_actions;action_id public.ulid;event_id public.ulid;occurred public.utc_ms;check_type text;expected_last text;
 latest json;target public.members;check_in jsonb;receipt jsonb;view_scope private.staff_links;
begin
 if operation is null or operation not in('read','submit','inspect','close') or request_limit is null or request_limit not between 1 and 60000 then raise invalid_parameter_value;end if;
 if operation='read' then
  if source is not null or after_cursor is not null and (not private.staff_exact(after_cursor::json,array['at','id'])
   or jsonb_typeof(after_cursor->'at')<>'number' or (after_cursor->>'at')!~'^(0|[1-9][0-9]*)$' or (after_cursor->>'at')::numeric>8640000000000000
   or jsonb_typeof(after_cursor->'id')<>'string' or (after_cursor->>'id')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$') then return jsonb_build_object('v',1,'state','changed');end if;
 elsif after_cursor is not null or not coalesce(private.staff_attendance_intent_valid(source),false) then return jsonb_build_object('v',1,'state','changed');end if;
 actor:=private.read_device_session(device_secret,session_secret);
 if actor is null then return jsonb_build_object('v',1,'state','missing');end if;
 business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;device:=(actor->>'deviceId')::public.ulid;
 member:=(actor->>'memberId')::public.ulid;session_id:=(actor->>'sessionId')::public.ulid;
 if operation<>'read' then
  if source->>'memberId' is distinct from member::text or source->>'outletId' is distinct from outlet::text then return jsonb_build_object('v',1,'state','changed');end if;
  action_id:=(source->>'id')::public.ulid;event_id:=(source->>'eventId')::public.ulid;occurred:=(source->>'occurredAt')::public.utc_ms;
  check_type:=source->>'type';expected_last:=source->>'expectedLastId';
 end if;
 window_at:=at_ms/60000*60000;retry_after:=greatest(1,ceil((window_at+60000-at_ms)::numeric/1000)::integer);
 insert into private.staff_device_budget(device_id,window_at,requests) values(device,window_at,1) on conflict(device_id) do update
  set window_at=excluded.window_at,requests=case when staff_device_budget.window_at=excluded.window_at then least(staff_device_budget.requests+1,60001) else 1 end returning requests into request_count;
 if request_count>request_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',retry_after);end if;
 if operation<>'read' then
  perform pg_advisory_xact_lock(hashtextextended('staff-device-action:'||action_id,0));
  select * into saved from private.staff_device_actions where id=action_id for update;
  if found then
   if saved.business_id<>business or saved.outlet_id<>outlet or saved.device_id<>device or saved.member_id<>member or saved.intent<>source then return jsonb_build_object('v',1,'state','changed');end if;
   -- A fresh PIN for the same actual member/device may confirm an earlier
   -- original receipt. It does not replay that record or grant current access.
   return saved.receipt;
  end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-member:'||business||':'||member,0));
 perform 1 from private.devices d where d.id=device for share;
 perform 1 from private.device_sessions s where s.id=session_id for share;
 perform 1 from public.members m where m.business_id=business and m.id=member for share;
 perform 1 from private.staff_pins p where p.business_id=business and p.member_id=member for share;
 perform 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=member for share;
 perform 1 from private.staff_profiles p where p.business_id=business and p.outlet_id=outlet and p.member_id=member for share;
 perform 1 from auth.users u join public.members m on m.auth_user_id=u.id where m.business_id=business and m.id=member for share of u;
 fresh:=private.read_device_session(device_secret,session_secret);
 if fresh is null or fresh->>'memberId' is distinct from member::text or fresh->>'deviceId' is distinct from device::text or fresh->>'sessionId' is distinct from session_id::text then return jsonb_build_object('v',1,'state','missing');end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if operation='read' then
  if not(fresh->'permissions' ? 'staff.check-in') then return jsonb_build_object('v',1,'state','missing');end if;
  -- Reuse the existing pure own-member projection, not link authorization.
  -- That projector reads only business/outlet/member from this transient row.
  view_scope.business_id:=business;view_scope.outlet_id:=outlet;view_scope.member_id:=member;
  return jsonb_build_object('v',1,'state','view','access',fresh,'view',private.staff_link_view(view_scope,after_cursor,at_ms));
 end if;
 receipt:=jsonb_build_object('v',1,'id',action_id,'state',case when operation='close' then 'closed' else 'pending' end,'intentJson',source::text,'checkIn',null,'at',case when operation='close' then at_ms else null end);
 if operation='inspect' then return receipt;end if;
 if operation='close' then
  if (select count(*) from private.staff_device_actions a where a.device_id=device and a.member_id=member and a.state='closed')>=200 then return jsonb_build_object('v',1,'state','limited','retryAfter',60);end if;
 else
  if not(fresh->'permissions' ? 'staff.check-in') then return jsonb_build_object('v',1,'state','missing');end if;
  select * into target from public.members m where m.business_id=business and m.id=member;
  latest:=private.staff_latest(business,outlet,member);
  if expected_last is distinct from private.confirmation_json_text(latest,'id') or occurred<target.created_at or occurred>at_ms+300000
   or latest is not null and (occurred<(private.confirmation_json_text(latest,'at'))::bigint or occurred=(private.confirmation_json_text(latest,'at'))::bigint and action_id::text<=private.confirmation_json_text(latest,'id'))
   or check_type=coalesce(private.confirmation_json_text(latest,'type'),'out') or check_type='break' and coalesce(private.confirmation_json_text(latest,'type'),'out')<>'in' then return jsonb_build_object('v',1,'state','changed');end if;
  insert into public.check_ins(id,business_id,outlet_id,member_id,at,type,method,recorded_by,created_at,updated_at)
   values(action_id,business,outlet,member,occurred,check_type,'order_phone',member,at_ms,at_ms);
  check_in:=jsonb_build_object('id',action_id,'outletId',outlet,'memberId',member,'at',occurred,'type',check_type,'method','order_phone','recordedBy',member);
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
   values(event_id,business,outlet,'member',member,'staff.check-in',coalesce(latest,'null'::json),check_in::json,at_ms);
  receipt:=jsonb_build_object('v',1,'id',action_id,'state','applied','intentJson',source::text,'checkIn',check_in,'at',at_ms);
 end if;
 insert into private.staff_device_actions(id,business_id,outlet_id,device_id,member_id,session_id,intent,state,receipt,created_at)
  values(action_id,business,outlet,device,member,session_id,source,receipt->>'state',receipt,at_ms);
 return receipt;
end $$;
revoke all on function private.visit_staff_device(text,text,text,jsonb,jsonb,integer) from public,anon,authenticated,service_role;
grant execute on function private.visit_staff_device(text,text,text,jsonb,jsonb,integer) to service_role;
create function public.visit_staff_device(p_device_token text,p_session_token text,p_operation text,p_intent jsonb,p_after jsonb,p_request_limit integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.visit_staff_device(p_device_token,p_session_token,p_operation,p_intent,p_after,p_request_limit) $$;
revoke all on function public.visit_staff_device(text,text,text,jsonb,jsonb,integer) from public,anon,authenticated,service_role;
grant execute on function public.visit_staff_device(text,text,text,jsonb,jsonb,integer) to service_role;
