-- Invitation capabilities are distinct from customer order/ledger tokens.
-- Only their hashes are stored; owners retain their original generated secret.
create table private.staff_links (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,member_id public.ulid not null,
 token_hash bytea not null unique check(octet_length(token_hash)=32),issued_by public.ulid not null,
 created_at public.utc_ms not null,expires_at public.utc_ms not null check(expires_at>created_at and expires_at<=created_at+7776000000),
 revoked_at public.utc_ms check(revoked_at>=created_at),window_at bigint not null default 0,requests integer not null default 0 check(requests>=0),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),
 foreign key(business_id,member_id) references public.members(business_id,id),foreign key(business_id,issued_by) references public.members(business_id,id)
);
create index staff_links_member on private.staff_links(business_id,outlet_id,member_id,id);
create index staff_links_issuer on private.staff_links(business_id,issued_by);
create table private.staff_link_owner_actions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 body_json text not null check(octet_length(body_json)<=1048576),receipt jsonb not null,created_at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),foreign key(business_id,actor_id) references public.members(business_id,id)
);
create index staff_link_owner_actions_outlet on private.staff_link_owner_actions(business_id,outlet_id,id);
create index staff_link_owner_actions_actor on private.staff_link_owner_actions(business_id,actor_id);
create table private.staff_link_actions (
 id public.ulid primary key,link_id public.ulid not null references private.staff_links(id),intent jsonb not null,
 state text not null check(state in('applied','closed')),receipt jsonb not null,created_at public.utc_ms not null
);
create index staff_link_actions_link on private.staff_link_actions(link_id,id);
create table private.staff_link_budget (id integer primary key check(id=1),window_at bigint not null,requests integer not null check(requests>=0));
alter table private.staff_links enable row level security;alter table private.staff_links force row level security;
alter table private.staff_link_owner_actions enable row level security;alter table private.staff_link_owner_actions force row level security;
alter table private.staff_link_actions enable row level security;alter table private.staff_link_actions force row level security;
alter table private.staff_link_budget enable row level security;alter table private.staff_link_budget force row level security;
revoke all on private.staff_links,private.staff_link_owner_actions,private.staff_link_actions,private.staff_link_budget from public,anon,authenticated,service_role;

create function private.staff_link_metadata(cap private.staff_links) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('id',cap.id,'memberId',cap.member_id,'createdAt',cap.created_at,'expiresAt',cap.expires_at,'revokedAt',cap.revoked_at)
$$;
revoke all on function private.staff_link_metadata(private.staff_links) from public,anon,authenticated,service_role;

-- Locks are held through the read/write so a live revocation cannot race it.
create function private.staff_link_live(cap private.staff_links) returns boolean
language plpgsql security invoker set search_path='' as $$
declare role_name text;target_role text;
begin
 if cap.id is null or cap.revoked_at is not null or cap.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then return false;end if;
 select m.role into role_name from public.members m join auth.users u on u.id=m.auth_user_id
  where m.id=cap.issued_by and m.business_id=cap.business_id and m.active and m.role in('owner','manager')
   and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>'' and u.deleted_at is null and not u.is_anonymous
   and (u.banned_until is null or u.banned_until<=now()) for share of m,u;
 if not found then return false;end if;
 if role_name='manager' then
  perform 1 from public.member_outlets where business_id=cap.business_id and member_id=cap.issued_by and outlet_id=cap.outlet_id for share;
  if not found then return false;end if;
 end if;
 select role into target_role from public.members where business_id=cap.business_id and id=cap.member_id and active and role<>'agent' for share;
 if not found then return false;end if;
 if target_role<>'owner' then
  perform 1 from public.member_outlets where business_id=cap.business_id and member_id=cap.member_id and outlet_id=cap.outlet_id for share;
  if not found then return false;end if;
 end if;
 perform 1 from private.staff_profiles where business_id=cap.business_id and outlet_id=cap.outlet_id and member_id=cap.member_id
  and profile->'methods' ? 'link' for share;
 return found;
end $$;
revoke all on function private.staff_link_live(private.staff_links) from public,anon,authenticated,service_role;

create function private.read_staff_links(outlet public.ulid,target public.ulid,after_id public.ulid) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;role_name text;links jsonb;ids public.ulid[];next_id public.ulid;
begin
 actor:=private.public_shop_actor(outlet);select business_id,role into business,role_name from public.members where id=actor;
 select array_agg(q.id order by q.id) into ids from (select id from private.staff_links where business_id=business and outlet_id=outlet
  and member_id=target and (after_id is null or id>after_id) order by id limit 41) q;
 if coalesce(array_length(ids,1),0)>40 then next_id:=ids[40];ids:=ids[1:40];end if;
 select jsonb_agg(private.staff_link_metadata(c) order by c.id) into links from private.staff_links c where c.id=any(ids);
 return json_build_object('v',1,'businessId',business,'outletId',outlet,'actorId',actor,'actorRole',role_name,
  'serverAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,'memberId',target,'current',private.staff_member_record(business,outlet,target),
  'links',coalesce(links,'[]'::jsonb),'next',next_id);
end $$;
revoke all on function private.read_staff_links(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.read_staff_links(public.ulid,public.ulid,public.ulid) to authenticated;
create function public.read_staff_links(p_outlet_id public.ulid,p_member_id public.ulid,p_after public.ulid default null) returns json
language sql security invoker set search_path='' as $$ select private.read_staff_links(p_outlet_id,p_member_id,p_after) $$;
revoke all on function public.read_staff_links(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.read_staff_links(public.ulid,public.ulid,public.ulid) to authenticated;

create function private.change_staff_link(outlet public.ulid,body_text text,operation text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;role_name text;b json;action_id public.ulid;event_id public.ulid;target public.ulid;link_id public.ulid;
 kind text;token_hash text;expiry public.utc_ms;saved private.staff_link_owner_actions;cap private.staff_links;original jsonb;current_record json;result jsonb;
 at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 actor:=private.public_shop_actor(outlet);select business_id,role into business,role_name from public.members where id=actor;
 if operation is null or operation not in('submit','inspect','close') or body_text is null or octet_length(body_text)>1048576 then raise invalid_parameter_value;end if;
 b:=body_text::json;
 if not private.staff_exact(b,array['actorId','actorRole','businessId','eventId','expected','expiresAt','id','kind','linkId','memberId','outletId','tokenHash','v'])
  or json_typeof(private.confirmation_json_field(b,'v'))<>'number' or private.confirmation_json_text(b,'v')<>'1'
  or exists(select 1 from private.confirmation_json_fields(b) f where f.key in('actorId','actorRole','businessId','eventId','id','kind','linkId','memberId','outletId') and json_typeof(f.value)<>'string')
  or private.confirmation_json_text(b,'actorId') is distinct from actor::text or private.confirmation_json_text(b,'businessId') is distinct from business::text
  or private.confirmation_json_text(b,'outletId') is distinct from outlet::text or private.confirmation_json_text(b,'actorRole') is distinct from role_name then raise insufficient_privilege;end if;
 action_id:=private.confirmation_json_text(b,'id')::public.ulid;event_id:=private.confirmation_json_text(b,'eventId')::public.ulid;
 target:=private.confirmation_json_text(b,'memberId')::public.ulid;link_id:=private.confirmation_json_text(b,'linkId')::public.ulid;kind:=private.confirmation_json_text(b,'kind');
 if action_id is null or event_id is null or target is null or link_id is null or kind is null or kind not in('issue','revoke')
  or (select count(distinct v) from unnest(array[action_id,event_id,target,link_id]) v)<>4
  or action_id in(business,outlet,actor) or event_id in(business,outlet,actor) or link_id in(business,outlet,actor) then raise invalid_parameter_value;end if;
 if kind='issue' then
  token_hash:=private.confirmation_json_text(b,'tokenHash');
  if json_typeof(private.confirmation_json_field(b,'tokenHash'))<>'string' or token_hash!~'^[a-f0-9]{64}$'
   or json_typeof(private.confirmation_json_field(b,'expiresAt'))<>'number' or private.confirmation_json_text(b,'expiresAt')!~'^(0|[1-9][0-9]*)$'
   or json_typeof(private.confirmation_json_field(b,'expected'))<>'object' then raise invalid_parameter_value;end if;
  expiry:=private.confirmation_json_text(b,'expiresAt')::public.utc_ms;
 elsif json_typeof(private.confirmation_json_field(b,'tokenHash'))<>'null' or json_typeof(private.confirmation_json_field(b,'expiresAt'))<>'null' then raise invalid_parameter_value;end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-link-owner:'||action_id,0));
 select * into saved from private.staff_link_owner_actions where id=action_id for update;
 if found then
  if saved.business_id<>business or saved.outlet_id<>outlet or saved.actor_id<>actor or not private.confirmation_json_equal(saved.body_json::json,b) then raise insufficient_privilege;end if;
  return saved.receipt;
 end if;
 result:=jsonb_build_object('v',1,'actionId',action_id,'state',case when operation='close' then 'closed' else 'pending' end,'link',null,'serverAt',at_ms);
 if operation='inspect' then return result;end if;
 if operation='submit' then
  if kind='issue' then
   perform pg_advisory_xact_lock(hashtextextended('staff-member:'||business||':'||target,0));
   current_record:=private.staff_member_record(business,outlet,target);
   if not private.confirmation_json_equal(private.confirmation_json_field(b,'expected'),coalesce(current_record,'null'::json)) then raise serialization_failure;end if;
   if expiry<=at_ms or expiry>at_ms+7776000000 then raise invalid_parameter_value;end if;
   cap.id:=link_id;cap.business_id:=business;cap.outlet_id:=outlet;cap.member_id:=target;cap.issued_by:=actor;cap.created_at:=at_ms;cap.expires_at:=expiry;
   if not private.staff_link_live(cap) then raise insufficient_privilege;end if;
   if not private.confirmation_json_equal(private.confirmation_json_field(b,'expected'),private.staff_member_record(business,outlet,target)) then raise serialization_failure;end if;
   insert into private.staff_links(id,business_id,outlet_id,member_id,token_hash,issued_by,created_at,expires_at)
    values(link_id,business,outlet,target,decode(token_hash,'hex'),actor,at_ms,expiry) returning * into cap;
   original:='null'::jsonb;
  else
   select * into cap from private.staff_links where id=link_id and business_id=business and outlet_id=outlet and member_id=target for update;
   if not found then raise insufficient_privilege;end if;original:=private.staff_link_metadata(cap);
   update private.staff_links set revoked_at=coalesce(revoked_at,at_ms) where id=cap.id returning * into cap;
  end if;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
   values(event_id,business,outlet,'member',actor,'staff.link.'||kind,original::json,private.staff_link_metadata(cap)::json,at_ms);
  result:=jsonb_build_object('v',1,'actionId',action_id,'state','applied','link',private.staff_link_metadata(cap),'serverAt',at_ms);
 end if;
 insert into private.staff_link_owner_actions(id,business_id,outlet_id,actor_id,body_json,receipt,created_at) values(action_id,business,outlet,actor,body_text,result,at_ms);
 return result;
end $$;
revoke all on function private.change_staff_link(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.change_staff_link(public.ulid,text,text) to authenticated;
create function public.change_staff_link(p_outlet_id public.ulid,p_action_json text,p_operation text) returns jsonb
language sql security invoker set search_path='' as $$ select private.change_staff_link(p_outlet_id,p_action_json,p_operation) $$;
revoke all on function public.change_staff_link(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.change_staff_link(public.ulid,text,text) to authenticated;

create function private.staff_link_view(cap private.staff_links,after_cursor jsonb,at_ms public.utc_ms) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m public.members;s public.outlets;b public.businesses;p jsonb;entries jsonb;next_cursor jsonb;ids public.ulid[];
begin
 select * into m from public.members where id=cap.member_id and business_id=cap.business_id;
 select * into s from public.outlets where id=cap.outlet_id and business_id=cap.business_id;
 select * into b from public.businesses where id=cap.business_id;
 select profile into p from private.staff_profiles where business_id=cap.business_id and outlet_id=cap.outlet_id and member_id=cap.member_id;
 select array_agg(q.id order by q.at desc,q.id desc) into ids from (select c.id,c.at from public.check_ins c
  where c.business_id=cap.business_id and c.outlet_id=cap.outlet_id and c.member_id=cap.member_id and
   (after_cursor is null or c.at<(after_cursor->>'at')::bigint or c.at=(after_cursor->>'at')::bigint and c.id<(after_cursor->>'id')::public.ulid)
  order by c.at desc,c.id desc limit 41) q;
 if coalesce(array_length(ids,1),0)>40 then
  select jsonb_build_object('at',c.at,'id',c.id) into next_cursor from public.check_ins c where id=ids[40];ids:=ids[1:40];
 end if;
 select jsonb_agg(jsonb_build_object('checkIn',jsonb_build_object('id',c.id,'outletId',c.outlet_id,'memberId',c.member_id,'at',c.at,
  'type',c.type,'method',c.method,'recordedBy',c.recorded_by),'recordedByNameJson',a.name::text) order by c.at desc,c.id desc)
  into entries from public.check_ins c join public.members a on a.business_id=c.business_id and a.id=c.recorded_by where c.id=any(ids);
 return jsonb_build_object('v',1,'memberId',m.id,'outletId',s.id,'shopNameJson',b.name::text,'outletNameJson',s.name::text,'timeZone',s.timezone,
  'nameJson',m.name::text,'nameLocalJson',m.name_local::text,'role',m.role,'language',p->>'language','shift',p->'shift',
  'latest',private.staff_latest(cap.business_id,cap.outlet_id,cap.member_id)::jsonb,'entries',coalesce(entries,'[]'::jsonb),'next',next_cursor,'serverAt',at_ms);
end $$;
revoke all on function private.staff_link_view(private.staff_links,jsonb,public.utc_ms) from public,anon,authenticated,service_role;

-- Fixed service-only boundary. No caller-selected tenant, role or recorder.
-- Nonfinancial attendance and its audit/receipt commit in one transaction.
create function private.visit_staff_link(secret text,operation text,source jsonb,after_cursor jsonb,global_limit integer,link_limit integer) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare cap private.staff_links;saved private.staff_link_actions;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 minute_at bigint;global_requests integer;retry_after integer;action_id public.ulid;event_id public.ulid;latest json;occurred public.utc_ms;check_type text;expected_last text;
 target public.members;check_in jsonb;receipt jsonb;before_image json;
begin
 if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' or operation is null or operation not in('read','submit','inspect','close') then return jsonb_build_object('v',1,'state','missing');end if;
 if global_limit is null or link_limit is null or global_limit not between 1 and 60000 or link_limit not between 1 and 60000 then raise invalid_parameter_value;end if;
 if operation='read' then
  if source is not null or after_cursor is not null and (not private.staff_exact(after_cursor::json,array['at','id'])
   or jsonb_typeof(after_cursor->'at')<>'number' or (after_cursor->>'at')!~'^(0|[1-9][0-9]*)$'
   or (after_cursor->>'at')::numeric>8640000000000000 or jsonb_typeof(after_cursor->'id')<>'string' or (after_cursor->>'id')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$') then
   return jsonb_build_object('v',1,'state','changed');end if;
 else
  if after_cursor is not null or source is null or not private.staff_exact(source::json,array['eventId','expectedLastId','id','memberId','occurredAt','outletId','type','v'])
   or source->'v'<>'1'::jsonb or exists(select 1 from jsonb_each(source) e where e.key in('id','eventId','memberId','outletId','type') and jsonb_typeof(e.value)<>'string')
   or (source->>'id')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or (source->>'eventId')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
   or (source->>'memberId')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or (source->>'outletId')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
   or (select count(distinct v) from unnest(array[source->>'id',source->>'eventId',source->>'memberId',source->>'outletId']) v)<>4
   or source->>'type' not in('in','out','break') or jsonb_typeof(source->'occurredAt')<>'number' or (source->>'occurredAt')!~'^(0|[1-9][0-9]*)$'
   or (source->>'occurredAt')::numeric>8640000000000000 or jsonb_typeof(source->'expectedLastId') not in('null','string')
   or jsonb_typeof(source->'expectedLastId')='string' and ((source->>'expectedLastId')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    or source->>'expectedLastId' in(source->>'id',source->>'eventId',source->>'memberId',source->>'outletId')) then return jsonb_build_object('v',1,'state','changed');end if;
  action_id:=(source->>'id')::public.ulid;event_id:=(source->>'eventId')::public.ulid;occurred:=(source->>'occurredAt')::public.utc_ms;
  check_type:=source->>'type';expected_last:=source->>'expectedLastId';
 end if;
 minute_at:=at_ms/60000*60000;retry_after:=greatest(1,ceil((minute_at+60000-at_ms)::numeric/1000)::integer);
 insert into private.staff_link_budget(id,window_at,requests) values(1,minute_at,1) on conflict(id) do update
  set window_at=excluded.window_at,requests=case when staff_link_budget.window_at=excluded.window_at then staff_link_budget.requests+1 else 1 end returning requests into global_requests;
 if global_requests>global_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',retry_after);end if;
 select * into cap from private.staff_links where token_hash=sha256(convert_to(secret,'UTF8')) for update;
 if not found then return jsonb_build_object('v',1,'state','missing');end if;
 update private.staff_links set window_at=minute_at,requests=case when window_at=minute_at then requests+1 else 1 end where id=cap.id returning * into cap;
 if cap.requests>link_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',retry_after);end if;
 if operation='read' then
  perform pg_advisory_xact_lock(hashtextextended('staff-member:'||cap.business_id||':'||cap.member_id,0));
  if not private.staff_link_live(cap) then return jsonb_build_object('v',1,'state','missing');end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  return jsonb_build_object('v',1,'state','view','view',private.staff_link_view(cap,after_cursor,at_ms));
 end if;
 if source->>'memberId' is distinct from cap.member_id::text or source->>'outletId' is distinct from cap.outlet_id::text then return jsonb_build_object('v',1,'state','changed');end if;
 perform pg_advisory_xact_lock(hashtextextended('staff-link-action:'||action_id,0));
 select * into saved from private.staff_link_actions where id=action_id for update;
 if found then
  if saved.link_id<>cap.id or saved.intent<>source then return jsonb_build_object('v',1,'state','changed');end if;
  -- Historical acknowledgement reveals only this exact supplied original,
  -- even after revocation. It never authorizes a fresh view or another tap.
  return saved.receipt;
 end if;
 receipt:=jsonb_build_object('v',1,'id',action_id,'state',case when operation='close' then 'closed' else 'pending' end,
  'intentJson',source::text,'checkIn',null,'at',case when operation='close' then at_ms else null end);
 if operation='close' then
  insert into private.staff_link_actions(id,link_id,intent,state,receipt,created_at) values(action_id,cap.id,source,'closed',receipt,at_ms);return receipt;
 end if;
 if operation='submit' then perform pg_advisory_xact_lock(hashtextextended('staff-member:'||cap.business_id||':'||cap.member_id,0));end if;
 if not private.staff_link_live(cap) then return jsonb_build_object('v',1,'state','missing');end if;
 if operation='inspect' then return receipt;end if;
 select * into target from public.members where business_id=cap.business_id and id=cap.member_id for share;
 latest:=private.staff_latest(cap.business_id,cap.outlet_id,cap.member_id);
 if expected_last is distinct from private.confirmation_json_text(latest,'id') or occurred<target.created_at or occurred>at_ms+300000
  or latest is not null and (occurred<(private.confirmation_json_text(latest,'at'))::bigint or occurred=(private.confirmation_json_text(latest,'at'))::bigint and action_id::text<=private.confirmation_json_text(latest,'id'))
  or check_type=coalesce(private.confirmation_json_text(latest,'type'),'out') or check_type='break' and coalesce(private.confirmation_json_text(latest,'type'),'out')<>'in' then return jsonb_build_object('v',1,'state','changed');end if;
 insert into public.check_ins(id,business_id,outlet_id,member_id,at,type,method,recorded_by,created_at,updated_at)
  values(action_id,cap.business_id,cap.outlet_id,cap.member_id,occurred,check_type,'link',cap.member_id,at_ms,at_ms);
 check_in:=jsonb_build_object('id',action_id,'outletId',cap.outlet_id,'memberId',cap.member_id,'at',occurred,'type',check_type,'method','link','recordedBy',cap.member_id);
 before_image:=coalesce(latest,'null'::json);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(event_id,cap.business_id,cap.outlet_id,'system','staff-link:'||cap.id,'staff.check-in',before_image,check_in::json,at_ms);
 receipt:=jsonb_build_object('v',1,'id',action_id,'state','applied','intentJson',source::text,'checkIn',check_in,'at',at_ms);
 insert into private.staff_link_actions(id,link_id,intent,state,receipt,created_at) values(action_id,cap.id,source,'applied',receipt,at_ms);
 return receipt;
end $$;
revoke all on function private.visit_staff_link(text,text,jsonb,jsonb,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.visit_staff_link(text,text,jsonb,jsonb,integer,integer) to service_role;
create function public.visit_staff_link(p_token text,p_operation text,p_intent jsonb,p_after jsonb,p_global_limit integer,p_link_limit integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.visit_staff_link(p_token,p_operation,p_intent,p_after,p_global_limit,p_link_limit) $$;
revoke all on function public.visit_staff_link(text,text,jsonb,jsonb,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.visit_staff_link(text,text,jsonb,jsonb,integer,integer) to service_role;
