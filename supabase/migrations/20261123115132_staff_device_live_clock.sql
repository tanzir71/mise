-- A calling statement keeps one statement_timestamp even while it waits.
-- Own attendance checks the current clock at admission and after its row locks.
-- Existing applied migrations remain unchanged; execution grants are retained.
create or replace function private.visit_staff_device(device_secret text,session_secret text,operation text,source jsonb,after_cursor jsonb,request_limit integer) returns jsonb
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
 if not exists(select 1 from private.devices d join private.device_sessions s on s.device_id=d.id
  where d.id=device and s.id=session_id and d.revoked_at is null and s.revoked_at is null and d.expires_at>at_ms and s.expires_at>at_ms)
  then return jsonb_build_object('v',1,'state','missing');end if;
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
 if not exists(select 1 from private.devices d join private.device_sessions s on s.device_id=d.id
  where d.id=device and s.id=session_id and d.revoked_at is null and s.revoked_at is null and d.expires_at>at_ms and s.expires_at>at_ms)
  then return jsonb_build_object('v',1,'state','missing');end if;
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
