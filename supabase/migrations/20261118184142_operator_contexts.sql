-- Metadata discovery never grants write authority. Every read/command rechecks live access.
create function private.operator_account_hash() returns text language plpgsql security invoker set search_path='' as $$
declare subject uuid;
begin
 select u.id into subject from auth.users u where u.id=(select auth.uid()) and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>''
  and not coalesce(u.is_anonymous,false) and u.deleted_at is null and (u.banned_until is null or u.banned_until<=statement_timestamp()) for share;
 if subject is null then raise insufficient_privilege using message='Use a currently verified phone account.';end if;
 return encode(sha256(uuid_send(subject)),'hex');
end $$;

create function private.operator_contexts(after_position jsonb,page_limit integer) returns json language plpgsql security definer set search_path='' as $$
declare account_hash text;item record;rows json[]:=array[]::json[];last_business public.ulid;last_outlet public.ulid;has_more boolean:=false;
begin
 account_hash:=private.operator_account_hash();
 if page_limit is null or page_limit<1 or page_limit>50 then raise invalid_parameter_value using message='Read between one and fifty outlet choices.';end if;
 if after_position is not null then
  if jsonb_typeof(after_position) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(after_position) k) is distinct from array['businessId','outletId']
   or jsonb_typeof(after_position->'businessId') is distinct from 'string' or jsonb_typeof(after_position->'outletId') is distinct from 'string' then raise invalid_parameter_value using message='Keep the original outlet list position.';end if;
  last_business:=(after_position->>'businessId')::public.ulid;last_outlet:=(after_position->>'outletId')::public.ulid;
 end if;
 for item in
  select 1 as version,b.id as "businessId",o.id as "outletId",m.id as "actorId",account_hash as "accountHash",m.role,e.id as epoch,v.version as "scopeVersion",
   case when octet_length(b.name::text)<=4096 then b.name else null::json end as "businessName",
   case when octet_length(o.name::text)<=4096 then o.name else null::json end as "outletName",
   case when octet_length(m.name::text)<=4096 then m.name else null::json end as "actorName"
  from public.members m join public.businesses b on b.id=m.business_id join public.outlets o on o.business_id=b.id
   join private.sync_scope_versions v on v.business_id=b.id and v.outlet_id=o.id cross join private.sync_epoch e
  where m.auth_user_id=(select auth.uid()) and m.active and m.role in ('owner','manager')
   and (m.role='owner' or exists(select 1 from public.member_outlets a where a.business_id=b.id and a.member_id=m.id and a.outlet_id=o.id))
   and (after_position is null or (b.id,o.id)>(last_business,last_outlet))
  order by b.id,o.id limit page_limit+1
 loop
  if cardinality(rows)=page_limit then has_more:=true;exit;end if;
  rows:=array_append(rows,row_to_json(item));last_business:=item."businessId";last_outlet:=item."outletId";
 end loop;
 return json_build_object('version',1,'accountHash',account_hash,'contexts',array_to_json(rows),'next',case when has_more then jsonb_build_object('businessId',last_business,'outletId',last_outlet) else null::jsonb end);
end $$;

create function private.operator_context(business public.ulid,outlet public.ulid,actor public.ulid) returns json language plpgsql security definer set search_path='' as $$
declare scope jsonb;account_hash text;result json;
begin
 account_hash:=private.operator_account_hash();scope:=private.sync_read_actor(outlet);
 if business is null or actor is null or scope->>'businessId'<>business::text or scope->>'actorId'<>actor::text or scope->>'accountHash'<>account_hash then raise insufficient_privilege using message='This account cannot select that outlet and member.';end if;
 select row_to_json(r) into result from (
  select 1 as version,b.id as "businessId",o.id as "outletId",m.id as "actorId",account_hash as "accountHash",m.role,e.id as epoch,v.version as "scopeVersion",
   case when octet_length(b.name::text)<=4096 then b.name else null::json end as "businessName",
   case when octet_length(o.name::text)<=4096 then o.name else null::json end as "outletName",
   case when octet_length(m.name::text)<=4096 then m.name else null::json end as "actorName"
  from public.businesses b join public.outlets o on o.business_id=b.id join public.members m on m.business_id=b.id
   join private.sync_scope_versions v on v.business_id=b.id and v.outlet_id=o.id cross join private.sync_epoch e
  where b.id=business and o.id=outlet and m.id=actor
 ) r;
 if result is null then raise insufficient_privilege using message='Review current outlet access again.';end if;return result;
end $$;

revoke all on function private.operator_account_hash(),private.operator_contexts(jsonb,integer),private.operator_context(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.operator_contexts(jsonb,integer),private.operator_context(public.ulid,public.ulid,public.ulid) to authenticated;
create function public.operator_contexts(p_after jsonb default null,p_limit integer default 50) returns json language sql security invoker set search_path='' as $$select private.operator_contexts(p_after,p_limit)$$;
create function public.operator_context(p_business_id public.ulid,p_outlet_id public.ulid,p_actor_id public.ulid) returns json language sql security invoker set search_path='' as $$select private.operator_context(p_business_id,p_outlet_id,p_actor_id)$$;
revoke all on function public.operator_contexts(jsonb,integer),public.operator_context(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.operator_contexts(jsonb,integer),public.operator_context(public.ulid,public.ulid,public.ulid) to authenticated;
