-- M34: existing canonical member identities and check_ins, with separate
-- configuration/original-action metadata. No Auth user or provider is created.
create table private.staff_profiles (
 business_id public.ulid not null,outlet_id public.ulid not null,member_id public.ulid not null,
 profile jsonb not null,revision bigint not null check(revision between 1 and 9007199254740991),
 last_action_id public.ulid not null,updated_at public.utc_ms not null,
 primary key(business_id,outlet_id,member_id),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),
 foreign key(business_id,member_id) references public.members(business_id,id)
);
create index staff_profiles_member on private.staff_profiles(business_id,member_id);
create table private.staff_owner_actions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 body_json text not null check(octet_length(body_json)<=1048576),state text not null check(state in('applied','closed')),
 receipt json not null,created_at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),
 foreign key(business_id,actor_id) references public.members(business_id,id)
);
create index staff_owner_actions_outlet on private.staff_owner_actions(business_id,outlet_id,id);
create index staff_owner_actions_actor on private.staff_owner_actions(business_id,actor_id);
alter table private.staff_profiles enable row level security;
alter table private.staff_profiles force row level security;
alter table private.staff_owner_actions enable row level security;
alter table private.staff_owner_actions force row level security;
revoke all on private.staff_profiles,private.staff_owner_actions from public,anon,authenticated,service_role;
create index check_ins_current_member on public.check_ins(business_id,outlet_id,member_id,at desc,id desc);

create function private.staff_exact(input json,keys text[]) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(json_typeof(input)='object' and (select array_agg(f.key order by f.key) from private.confirmation_json_fields(input) f)=keys,false)
$$;
revoke all on function private.staff_exact(json,text[]) from public,anon,authenticated,service_role;

create function private.staff_label_valid(value text,maximum integer) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(length(value)<=maximum and value=btrim(value,U&'\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff')
  and value!~'[\u0001-\u001f\u007f]' and length(to_jsonb(value)::text)+
   (select count(*) from regexp_split_to_table(value,'') c where ascii(c)>65535)<=160,false)
$$;
revoke all on function private.staff_label_valid(text,integer) from public,anon,authenticated,service_role;

create function private.staff_draft_valid(input json) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare d jsonb;p jsonb;s jsonb;part jsonb;previous integer:=-1;n integer;
begin
 if not private.staff_exact(input,array['active','language','methods','name','nameLocal','permissions','phone','role','shift','station','whatsapp']) then return false;end if;
 d:=input::jsonb;
 if jsonb_typeof(d->'name')<>'string' or coalesce(d->>'name','')='' or not private.staff_label_valid(d->>'name',80)
  or jsonb_typeof(d->'nameLocal')<>'string' or not private.staff_label_valid(d->>'nameLocal',80)
  or jsonb_typeof(d->'station')<>'string' or not private.staff_label_valid(d->>'station',60)
  or jsonb_typeof(d->'language')<>'string' or d->>'language' not in('en','bn')
  or jsonb_typeof(d->'role')<>'string' or d->>'role' not in('owner','manager','staff','kitchen','rider','agent')
  or jsonb_typeof(d->'active')<>'boolean' or jsonb_typeof(d->'whatsapp')<>'boolean'
  or jsonb_typeof(d->'phone') not in('null','string') or jsonb_typeof(d->'phone')='string' and (d->>'phone')!~'^\+[1-9][0-9]{6,14}$'
  or (d->>'whatsapp')::boolean and jsonb_typeof(d->'phone')='null'
  or jsonb_typeof(d->'methods')<>'array' then return false;end if;
 if jsonb_array_length(d->'methods')>3 then return false;end if;
 for part in select value from jsonb_array_elements(d->'methods') loop
  if jsonb_typeof(part)<>'string' then return false;end if;
  n:=case part#>>'{}' when 'order_phone' then 0 when 'link' then 1 when 'group' then 2 else -1 end;
  if n<=previous then return false;end if;previous:=n;
 end loop;
 p:=d->'permissions';
 if not private.staff_exact(private.confirmation_json_field(input,'permissions'),array['confirmOrders','updateStock','viewOwnPerformance'])
  or jsonb_typeof(p->'confirmOrders')<>'boolean' or jsonb_typeof(p->'updateStock')<>'boolean' or jsonb_typeof(p->'viewOwnPerformance')<>'boolean' then return false;end if;
 s:=d->'shift';if jsonb_typeof(s)='null' then return true;end if;
 if not private.staff_exact(private.confirmation_json_field(input,'shift'),array['days','end','start']) or jsonb_typeof(s->'days')<>'array'
  or jsonb_typeof(s->'start')<>'number' or jsonb_typeof(s->'end')<>'number' then return false;end if;
 if (s->>'start')::numeric<>trunc((s->>'start')::numeric) or (s->>'end')::numeric<>trunc((s->>'end')::numeric)
  or (s->>'start')::numeric not between 0 and 1439 or (s->>'end')::numeric not between 0 and 1439 or (s->>'start')::numeric=(s->>'end')::numeric
  or jsonb_array_length(s->'days') not between 1 and 7 then return false;end if;
 previous:=-1;
 for part in select value from jsonb_array_elements(s->'days') loop
  if jsonb_typeof(part)<>'number' or (part#>>'{}')::numeric<>trunc((part#>>'{}')::numeric) or (part#>>'{}')::numeric not between 0 and 6 then return false;end if;
  n:=(part#>>'{}')::integer;if n<=previous then return false;end if;previous:=n;
 end loop;
 return true;
end $$;
revoke all on function private.staff_draft_valid(json) from public,anon,authenticated,service_role;

create function private.staff_member_record(business public.ulid,outlet public.ulid,target public.ulid) returns json
language plpgsql stable security invoker set search_path='' as $$
declare m public.members;s private.staff_profiles;assignments json;p jsonb;
begin
 select * into m from public.members where id=target and business_id=business and
  (role='owner' or exists(select 1 from public.member_outlets a where a.business_id=business and a.member_id=target and a.outlet_id=outlet));
 if not found then return null;end if;
 select * into s from private.staff_profiles where business_id=business and outlet_id=outlet and member_id=target;
 select json_agg(a.outlet_id order by a.outlet_id) into assignments from
  (select outlet_id from public.member_outlets where business_id=business and member_id=target union select outlet where m.role='owner') a;
 p:=coalesce(s.profile,'{"nameLocal":"","station":"","language":"en","whatsapp":false,"methods":[],"permissions":{"confirmOrders":false,"updateStock":false,"viewOwnPerformance":false},"shift":null}'::jsonb);
 return json_build_object('member',private.confirmation_strip_nulls(json_build_object('id',m.id,'businessId',m.business_id,'outletIds',coalesce(assignments,'[]'::json),
  'name',m.name::json,'phone',m.phone,'role',m.role,'active',m.active,'createdAt',m.created_at,'updatedAt',m.updated_at)),
  'profile',json_build_object('nameLocal',m.name_local::json,'station',p->'station','language',p->'language','whatsapp',p->'whatsapp',
   'methods',p->'methods','permissions',p->'permissions','shift',p->'shift'),
  'revision',coalesce(s.revision,0),'lastActionId',s.last_action_id);
end $$;
revoke all on function private.staff_member_record(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;

create function private.staff_latest(business public.ulid,outlet public.ulid,target public.ulid) returns json
language sql stable security invoker set search_path='' as $$
 select json_build_object('id',c.id,'outletId',c.outlet_id,'memberId',c.member_id,'at',c.at,'type',c.type,'method',c.method,'recordedBy',c.recorded_by)
 from public.check_ins c where c.business_id=business and c.outlet_id=outlet and c.member_id=target order by c.at desc,c.id desc limit 1
$$;
revoke all on function private.staff_latest(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;

create function private.read_staff_context(outlet public.ulid,target public.ulid) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;role_name text;current_record json;
begin
 actor:=private.public_shop_actor(outlet);
 select business_id,role into business,role_name from public.members where id=actor;
 current_record:=private.staff_member_record(business,outlet,target);
 return json_build_object('v',1,'businessId',business,'outletId',outlet,'actorId',actor,'actorRole',role_name,
  'serverAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,'memberId',target,'current',current_record,
  'latest',case when current_record is null then null else private.staff_latest(business,outlet,target) end);
end $$;
revoke all on function private.read_staff_context(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.read_staff_context(public.ulid,public.ulid) to authenticated;
create function public.read_staff_context(p_outlet_id public.ulid,p_member_id public.ulid) returns json
language sql security invoker set search_path='' as $$ select private.read_staff_context(p_outlet_id,p_member_id) $$;
revoke all on function public.read_staff_context(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.read_staff_context(public.ulid,public.ulid) to authenticated;

create function private.read_staff_board(outlet public.ulid,after_id public.ulid,page_size integer) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;role_name text;entries json;next_id public.ulid;member_ids public.ulid[];
begin
 actor:=private.public_shop_actor(outlet);
 select business_id,role into business,role_name from public.members where id=actor;
 if page_size is null or page_size not between 1 and 100 then raise invalid_parameter_value using message='Choose a complete team page.';end if;
 select array_agg(q.id order by q.id) into member_ids from (select m.id from public.members m where m.business_id=business
  and (after_id is null or m.id>after_id) and (m.role='owner' or exists(select 1 from public.member_outlets a
   where a.business_id=business and a.member_id=m.id and a.outlet_id=outlet)) order by m.id limit page_size+1) q;
 if coalesce(array_length(member_ids,1),0)>page_size then next_id:=member_ids[page_size];member_ids:=member_ids[1:page_size];end if;
 select json_agg(json_build_object('staff',private.staff_member_record(business,outlet,q.id),'latest',private.staff_latest(business,outlet,q.id)) order by q.id)
  into entries from unnest(member_ids) q(id);
 return json_build_object('v',1,'businessId',business,'outletId',outlet,'actorId',actor,'actorRole',role_name,
  'serverAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,'entries',coalesce(entries,'[]'::json),'next',next_id);
end $$;
revoke all on function private.read_staff_board(public.ulid,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_staff_board(public.ulid,public.ulid,integer) to authenticated;
create function public.read_staff_board(p_outlet_id public.ulid,p_after public.ulid default null,p_page_size integer default 40) returns json
language sql security invoker set search_path='' as $$ select private.read_staff_board(p_outlet_id,p_after,p_page_size) $$;
revoke all on function public.read_staff_board(public.ulid,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_staff_board(public.ulid,public.ulid,integer) to authenticated;

-- A complete original is bound to its actual phone actor before inspecting,
-- closing or applying. Closure takes the same action lock as a later submit.
create function private.change_staff_action(outlet public.ulid,body_text text,operation text) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;role_name text;b json;draft_json json;d jsonb;original json;latest json;profile jsonb;
 action_id public.ulid;event_id public.ulid;target_id public.ulid;kind text;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 saved private.staff_owner_actions;target public.members;revision bigint;command_name text;before_image json;after_image json;receipt json;
 check_value json;check_id public.ulid;check_type text;occurred public.utc_ms;expected_last text;state_name text;
begin
 actor:=private.public_shop_actor(outlet);
 select business_id,role into business,role_name from public.members where id=actor;
 if operation is null or operation not in('submit','inspect','close') or body_text is null or octet_length(body_text)>1048576 then
  raise invalid_parameter_value using message='Keep the original team action.';end if;
 b:=body_text::json;
 if not private.staff_exact(b,array['actorId','actorRole','businessId','checkIn','draft','eventId','expected','id','kind','latest','memberId','outletId','v'])
  or json_typeof(private.confirmation_json_field(b,'v'))<>'number' or private.confirmation_json_text(b,'v')<>'1'
  or exists(select 1 from private.confirmation_json_fields(b) f where f.key in('actorId','actorRole','businessId','eventId','id','kind','memberId','outletId') and json_typeof(f.value)<>'string')
  or private.confirmation_json_text(b,'businessId') is distinct from business::text
  or private.confirmation_json_text(b,'outletId') is distinct from outlet::text or private.confirmation_json_text(b,'actorId') is distinct from actor::text
  or private.confirmation_json_text(b,'actorRole') is distinct from role_name then raise insufficient_privilege using message='Check the original account and outlet.';end if;
 action_id:=private.confirmation_json_text(b,'id')::public.ulid;event_id:=private.confirmation_json_text(b,'eventId')::public.ulid;
 target_id:=private.confirmation_json_text(b,'memberId')::public.ulid;kind:=private.confirmation_json_text(b,'kind');
 if action_id is null or event_id is null or target_id is null or kind is null or kind not in('save','check-in')
  or (select count(distinct value) from unnest(array[action_id::text,event_id::text,target_id::text,business::text,outlet::text]) value)<>5
  or actor in(action_id,event_id) then raise invalid_parameter_value using message='Keep distinct original team identities.';end if;
 draft_json:=private.confirmation_json_field(b,'draft');check_value:=private.confirmation_json_field(b,'checkIn');
 if kind='save' then
  if not private.staff_draft_valid(draft_json) or json_typeof(check_value)<>'null' or json_typeof(private.confirmation_json_field(b,'latest'))<>'null' then
   raise invalid_parameter_value using message='Review the original team member.';end if;
 else
  if json_typeof(private.confirmation_json_field(b,'expected'))<>'object' or json_typeof(draft_json)<>'null'
   or not private.staff_exact(check_value,array['eventId','expectedLastId','id','memberId','occurredAt','outletId','type','v'])
   or json_typeof(private.confirmation_json_field(check_value,'v'))<>'number' or private.confirmation_json_text(check_value,'v')<>'1'
   or exists(select 1 from private.confirmation_json_fields(check_value) f where f.key in('eventId','id','memberId','outletId','type') and json_typeof(f.value)<>'string')
   or private.confirmation_json_text(check_value,'memberId') is distinct from target_id::text
   or private.confirmation_json_text(check_value,'outletId') is distinct from outlet::text or private.confirmation_json_text(check_value,'eventId') is distinct from event_id::text then
   raise invalid_parameter_value using message='Keep the original check-in.';end if;
  check_id:=private.confirmation_json_text(check_value,'id')::public.ulid;check_type:=private.confirmation_json_text(check_value,'type');
  if check_id is null or check_id in(action_id,event_id,target_id,outlet) or check_type is null or check_type not in('in','out','break')
   or json_typeof(private.confirmation_json_field(check_value,'occurredAt'))<>'number'
   or private.confirmation_json_text(check_value,'occurredAt')!~'^(0|[1-9][0-9]*)$' then
   raise invalid_parameter_value using message='Keep the original check-in time and identities.';end if;
  occurred:=private.confirmation_json_text(check_value,'occurredAt')::public.utc_ms;
  expected_last:=private.confirmation_json_text(check_value,'expectedLastId');
  if json_typeof(private.confirmation_json_field(check_value,'expectedLastId')) not in('null','string')
   or expected_last is not null and (expected_last!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or expected_last in(check_id,event_id,target_id,outlet)) then
   raise invalid_parameter_value using message='Keep the original preceding check-in.';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-action:'||action_id,0));
 select * into saved from private.staff_owner_actions where id=action_id for update;
 if found then
  if saved.business_id<>business or saved.outlet_id<>outlet or saved.actor_id<>actor or not private.confirmation_json_equal(saved.body_json::json,b) then
   raise insufficient_privilege using message='Keep the original team action.';end if;
  return saved.receipt;
 end if;
 receipt:=json_build_object('v',1,'actionId',action_id,'state',case when operation='close' then 'closed' else 'pending' end,'member',null,'checkIn',null,'serverAt',at_ms);
 if operation='inspect' then return receipt;end if;
 if operation='close' then
  insert into private.staff_owner_actions(id,business_id,outlet_id,actor_id,body_json,state,receipt,created_at)
   values(action_id,business,outlet,actor,body_text,'closed',receipt,at_ms);return receipt;
 end if;
 -- One member lock coordinates global name/role changes from different outlets.
 perform pg_advisory_xact_lock(hashtextextended('staff-member:'||business||':'||target_id,0));
 select * into target from public.members where id=target_id for update;
 if found and (target.business_id<>business or target.role<>'owner' and not exists(select 1 from public.member_outlets a
  where a.business_id=business and a.member_id=target_id and a.outlet_id=outlet)) then raise insufficient_privilege using message='Review the member in this outlet.';end if;
 perform 1 from public.member_outlets a where a.business_id=business and a.member_id=target_id for share;
 original:=private.staff_member_record(business,outlet,target_id);latest:=private.staff_latest(business,outlet,target_id);
 if not private.confirmation_json_equal(private.confirmation_json_field(b,'expected'),coalesce(original,'null'::json))
  or kind='check-in' and not private.confirmation_json_equal(private.confirmation_json_field(b,'latest'),coalesce(latest,'null'::json)) then
  raise serialization_failure using message='This member changed. Keep the original and review the current record.';end if;
 if kind='save' then
  d:=draft_json::jsonb;
  if d->>'role'='agent' or target.role='agent' or d->>'role'='owner' and (original is null or target.role<>'owner')
   or target.role='owner' and (d->>'role'<>'owner' or not (d->>'active')::boolean)
   or target_id=actor and (d->>'role' is distinct from target.role or not (d->>'active')::boolean)
   or original is null and (not (d->>'active')::boolean or target_id in(actor,business,outlet)) then
   raise insufficient_privilege using message='Keep the current owner and sign-in access.';end if;
  if role_name='manager' and (d->>'role' in('owner','manager') or target.role in('owner','manager') or exists(select 1 from public.member_outlets a
   where a.business_id=business and a.member_id=target_id and a.outlet_id<>outlet)) then
   raise insufficient_privilege using message='Only the owner can change this member''s wider access.';end if;
  if original is not null and target.updated_at>at_ms then raise serialization_failure using message='Review the current member time.';end if;
  revision:=coalesce((private.confirmation_json_text(original,'revision'))::bigint,0)+1;
  if revision>9007199254740991 then raise program_limit_exceeded using message='Keep the current staff revision.';end if;
  profile:=d-array['name','phone','role','active'];
  if original is null then
   insert into public.members(id,business_id,name,name_local,phone,role,active,created_at,updated_at)
    values(target_id,business,to_json(d->>'name')::public.literal_text,to_json(d->>'nameLocal')::public.literal_text,d->>'phone',d->>'role',(d->>'active')::boolean,at_ms,at_ms);
   insert into public.member_outlets(business_id,member_id,outlet_id) values(business,target_id,outlet);
   command_name:='staff.create';
  else
   update public.members set name=to_json(d->>'name')::public.literal_text,name_local=to_json(d->>'nameLocal')::public.literal_text,
    phone=d->>'phone',role=d->>'role',active=(d->>'active')::boolean,updated_at=at_ms where id=target_id;
   command_name:=case when target.active and not (d->>'active')::boolean then 'staff.remove' else 'staff.update' end;
  end if;
  insert into private.staff_profiles(business_id,outlet_id,member_id,profile,revision,last_action_id,updated_at)
   values(business,outlet,target_id,profile,revision,event_id,at_ms) on conflict(business_id,outlet_id,member_id)
   do update set profile=excluded.profile,revision=excluded.revision,last_action_id=excluded.last_action_id,updated_at=excluded.updated_at;
  before_image:=coalesce(original,'null'::json);after_image:=private.staff_member_record(business,outlet,target_id);
  receipt:=json_build_object('v',1,'actionId',action_id,'state','applied','member',after_image,'checkIn',null,'serverAt',at_ms);
 else
  if original is null or not target.active or target.role='agent' or expected_last is distinct from private.confirmation_json_text(latest,'id')
   or occurred<target.created_at or occurred>at_ms+300000 or latest is not null and (occurred<(private.confirmation_json_text(latest,'at'))::bigint
    or occurred=(private.confirmation_json_text(latest,'at'))::bigint and check_id::text<=private.confirmation_json_text(latest,'id')) then
   raise serialization_failure using message='Review the current check-in. Keep the original choice.';end if;
  state_name:=coalesce(private.confirmation_json_text(latest,'type'),'out');
  if check_type=state_name or check_type='break' and state_name<>'in' then raise serialization_failure using message='This member''s presence already changed.';end if;
  insert into public.check_ins(id,business_id,outlet_id,member_id,at,type,method,recorded_by,created_at,updated_at)
   values(check_id,business,outlet,target_id,occurred,check_type,'manual',actor,at_ms,at_ms);
  command_name:='staff.check-in';before_image:=coalesce(latest,'null'::json);
  after_image:=json_build_object('id',check_id,'outletId',outlet,'memberId',target_id,'at',occurred,'type',check_type,'method','manual','recordedBy',actor);
  receipt:=json_build_object('v',1,'actionId',action_id,'state','applied','member',original,'checkIn',after_image,'serverAt',at_ms);
 end if;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(event_id,business,outlet,'member',actor,command_name,before_image,after_image,at_ms);
 insert into private.staff_owner_actions(id,business_id,outlet_id,actor_id,body_json,state,receipt,created_at)
  values(action_id,business,outlet,actor,body_text,'applied',receipt,at_ms);
 return receipt;
end $$;
revoke all on function private.change_staff_action(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.change_staff_action(public.ulid,text,text) to authenticated;
create function public.change_staff_action(p_outlet_id public.ulid,p_action_json text,p_operation text) returns json
language sql security invoker set search_path='' as $$ select private.change_staff_action(p_outlet_id,p_action_json,p_operation) $$;
revoke all on function public.change_staff_action(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.change_staff_action(public.ulid,text,text) to authenticated;
