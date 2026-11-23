-- The shared phone shows only its outlet's attendance roster. Its current
-- member must have explicit order-phone attendance; no operator role is added.
create function private.read_staff_device_board(device_secret text,session_secret text,after_member public.ulid,request_limit integer) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare own jsonb;actor jsonb;business public.ulid;outlet public.ulid;device public.ulid;session_id public.ulid;
 at_ms public.utc_ms;rows jsonb;next_id public.ulid;
begin
 own:=private.visit_staff_device(device_secret,session_secret,'read',null,null,request_limit);
 if own->>'state'<>'view' then return own;end if;
 actor:=own->'access';business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;
 device:=(actor->>'deviceId')::public.ulid;session_id:=(actor->>'sessionId')::public.ulid;
 with candidates as materialized(
  select m.* from public.members m where m.business_id=business and m.active and m.role<>'agent' and (after_member is null or m.id>after_member)
   and (exists(select 1 from public.member_outlets a where a.business_id=m.business_id and a.member_id=m.id and a.outlet_id=outlet)
    or m.role='owner' and (exists(select 1 from private.staff_profiles profile where profile.business_id=business and profile.outlet_id=outlet and profile.member_id=m.id)
     or exists(select 1 from public.check_ins c where c.business_id=business and c.outlet_id=outlet and c.member_id=m.id)))
  order by m.id limit 51
 ),page as(select * from candidates order by id limit 50)
 select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'nameJson',m.name::text,
  'nameLocalJson',coalesce(profile.profile->'nameLocal','""'::jsonb)::text,'role',m.role,'stationJson',coalesce(profile.profile->'station','""'::jsonb)::text,
  'shift',coalesce(profile.profile->'shift','null'::jsonb),'canSignIn',coalesce(private.staff_device_allowed(d,pin) and 'staff.check-in'=any(private.device_staff_permissions(d,m)),false),
  'latest',case when latest.id is null then null else jsonb_build_object('at',latest.at,'type',latest.type,'method',latest.method,'recordedByNameJson',coalesce(recorder.name::text,'""')) end
 ) order by m.id),'[]'::jsonb),case when(select count(*) from candidates)>50 then(select p.id from page p order by p.id desc limit 1)end
 into rows,next_id from page m
 join private.devices d on d.id=device
 left join private.staff_profiles profile on profile.business_id=business and profile.outlet_id=outlet and profile.member_id=m.id
 left join private.staff_pins pin on pin.business_id=business and pin.member_id=m.id
 left join lateral(select c.* from public.check_ins c where c.business_id=business and c.outlet_id=outlet and c.member_id=m.id order by c.at desc,c.id desc limit 1) latest on true
 left join public.members recorder on recorder.business_id=business and recorder.id=latest.recorded_by;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not exists(select 1 from private.devices d join private.device_sessions s on s.device_id=d.id
  where d.id=device and s.id=session_id and d.revoked_at is null and s.revoked_at is null and d.expires_at>at_ms and s.expires_at>at_ms)
  then return jsonb_build_object('v',1,'state','missing');end if;
 return jsonb_build_object('v',1,'state','board','access',actor,'outletNameJson',own->'view'->>'outletNameJson',
  'timeZone',own->'view'->>'timeZone','serverAt',at_ms,'members',rows,'next',next_id);
end $$;
revoke all on function private.read_staff_device_board(text,text,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_staff_device_board(text,text,public.ulid,integer) to service_role;
create function public.read_staff_device_board(p_device_token text,p_session_token text,p_after_member_id public.ulid,p_request_limit integer) returns jsonb
language sql security invoker set search_path='' as $$select private.read_staff_device_board(p_device_token,p_session_token,p_after_member_id,p_request_limit)$$;
revoke all on function public.read_staff_device_board(text,text,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_staff_device_board(text,text,public.ulid,integer) to service_role;

-- Owners can configure a rider PIN only after explicit outlet opt-in.
create or replace function private.read_device_admin(p_outlet_id public.ulid,p_kind text,p_after_id public.ulid,p_limit integer) returns jsonb
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
   (m.role in ('staff','kitchen') or (m.role='rider' and exists(select 1 from private.staff_profiles profile where profile.business_id=m.business_id and profile.outlet_id=p_outlet_id and profile.member_id=m.id and profile.profile->'methods' ? 'order_phone')) or exists(select 1 from private.staff_pins p where p.business_id=m.business_id and p.member_id=m.id))
 ),bounded as(select * from selected where p_after_id is null or id>p_after_id order by id limit p_limit+1),page as(select * from bounded order by id limit p_limit)
 select coalesce((select jsonb_agg(p.value order by p.id) from page p),'[]'),case when(select count(*) from bounded)>p_limit then(select p.id from page p order by p.id desc limit 1)end into entries,next_id;
 return scope||jsonb_build_object('v',1,'kind',p_kind,'entries',entries,'next',next_id);
end $$;
