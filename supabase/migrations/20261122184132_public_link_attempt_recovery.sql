-- A lost one-time secret cannot be recovered. Close its original issuance attempt
-- before making a replacement; the closure also fences a delayed first request.
alter table private.public_links add column created_event_id public.ulid;
update private.public_links c set created_event_id=(select e.id
  from public.events e where e.command='public_link.create'
    and e.business_id=c.business_id and e.outlet_id=c.outlet_id
    and e.after_data->>'id'=c.id::text and e.actor_type='member'
    and e.actor_id=c.issued_by::text and e.at=c.created_at);

create table private.public_link_attempt_closures (
  id public.ulid primary key,
  business_id public.ulid not null, outlet_id public.ulid not null,
  kind text not null check (kind in ('order','khata')),
  resource_id public.ulid not null, create_event_id public.ulid not null,
  event_id public.ulid not null unique, closed_by public.ulid not null,
  closed_at public.utc_ms not null,
  check (id<>create_event_id and id<>event_id and create_event_id<>event_id),
  foreign key (business_id,outlet_id) references public.outlets(business_id,id),
  foreign key (business_id,closed_by) references public.members(business_id,id)
);
alter table private.public_link_attempt_closures enable row level security;
alter table private.public_link_attempt_closures force row level security;
revoke all on private.public_link_attempt_closures from public,anon,authenticated,service_role;
create index public_link_attempt_closures_actor_idx
  on private.public_link_attempt_closures(business_id,closed_by,closed_at desc);
create index public_link_attempt_closures_outlet_idx
  on private.public_link_attempt_closures(business_id,outlet_id);

-- Derive authority from the actual resource and lock live membership, Auth and
-- assignment before resource/attempt locks. Callers never select their tenant.
create function private.public_link_scope(link_kind text,resource_id public.ulid)
returns table(business_id public.ulid,outlet_id public.ulid,actor_id public.ulid)
language plpgsql security invoker set search_path='' as $$

begin
  if link_kind='order' then
    select o.business_id,o.outlet_id into business_id,outlet_id from public.orders o where o.id=resource_id;
  elsif link_kind='khata' then
    select a.business_id,a.outlet_id into business_id,outlet_id from public.credit_accounts a where a.id=resource_id;
  else raise invalid_parameter_value using message='Choose an order or khata link.'; end if;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  actor_id:=private.public_link_actor(business_id,outlet_id);
  perform 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous for share;
  if not found then raise insufficient_privilege using message='Sign in with your phone account.'; end if;
  if link_kind='order' then
    perform 1 from public.orders o where o.id=resource_id and o.business_id=public_link_scope.business_id and o.outlet_id=public_link_scope.outlet_id for key share;
  else
    perform 1 from public.credit_accounts a where a.id=resource_id and a.business_id=public_link_scope.business_id and a.outlet_id=public_link_scope.outlet_id for key share;
  end if;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  return next;
end $$;
revoke all on function private.public_link_scope(text,public.ulid) from public,anon,authenticated,service_role;

create or replace function private.create_public_link(link_id public.ulid,event_id public.ulid,link_kind text,resource_id public.ulid,expiry public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare scope record; secret text; at_ms public.utc_ms; expires public.utc_ms; saved private.public_links;
begin
  if link_id is null or event_id is null or link_id=event_id then
    raise invalid_parameter_value using message='Choose distinct link and event identifiers.';
  end if;
  select * into strict scope from private.public_link_scope(link_kind,resource_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mise.public-link:'||link_id::text,0));
  if exists(select 1 from private.public_link_attempt_closures c where c.id=link_id) then
    raise object_not_in_prerequisite_state using message='This link attempt is closed. Create a replacement.';
  end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  expires:=coalesce(expiry,at_ms+case when link_kind='order' then 604800000 else 2592000000 end);
  if expires<=at_ms or expires>at_ms+7776000000 then raise invalid_parameter_value using message='Choose an expiry within 90 days.'; end if;
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  insert into private.public_links(id,business_id,outlet_id,kind,order_id,account_id,token_hash,issued_by,created_at,expires_at,created_event_id)
    values(link_id,scope.business_id,scope.outlet_id,link_kind,case when link_kind='order' then resource_id end,
      case when link_kind='khata' then resource_id end,sha256(convert_to(secret,'UTF8')),scope.actor_id,at_ms,expires,event_id) returning * into saved;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,order_id,customer_id)
    values(event_id,scope.business_id,scope.outlet_id,'member',scope.actor_id,'public_link.create','null',private.public_link_metadata(saved)::json,at_ms,
      saved.order_id,case when link_kind='khata' then (select a.customer_id from public.credit_accounts a where a.id=saved.account_id) end);
  return private.public_link_metadata(saved)||jsonb_build_object('token',secret);
end $$;

create or replace function private.revoke_public_link(link_id public.ulid,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare saved private.public_links; previous jsonb; scope record; at_ms public.utc_ms;
begin
  select * into saved from private.public_links c where c.id=link_id;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  select * into strict scope from private.public_link_scope(saved.kind,coalesce(saved.order_id,saved.account_id));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mise.public-link:'||link_id::text,0));
  select * into saved from private.public_links c where c.id=link_id for update;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  if saved.revoked_at is not null then return private.public_link_metadata(saved); end if;
  previous:=private.public_link_metadata(saved);
  at_ms:=greatest(floor(extract(epoch from clock_timestamp())*1000)::bigint,saved.created_at);
  update private.public_links c set revoked_at=at_ms where c.id=saved.id returning * into saved;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,order_id,customer_id)
    values(event_id,saved.business_id,saved.outlet_id,'member',scope.actor_id,'public_link.revoke',previous::json,
      private.public_link_metadata(saved)::json,at_ms,saved.order_id,
      case when saved.kind='khata' then (select a.customer_id from public.credit_accounts a where a.id=saved.account_id) end);
  return private.public_link_metadata(saved);
end $$;

-- Metadata is tied to the exact original attempt, not just a reusable resource.
-- Neither a hash nor the one-time secret is returned, even on a successful retry.
create function private.read_public_link_attempt(link_id public.ulid,create_event_id public.ulid,link_kind text,resource_id public.ulid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare scope record; saved private.public_links; closed private.public_link_attempt_closures; state text;
begin
  if link_id is null or create_event_id is null or link_id=create_event_id then
    raise invalid_parameter_value using message='Choose the original link attempt.';
  end if;
  select * into strict scope from private.public_link_scope(link_kind,resource_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mise.public-link:'||link_id::text,0));
  select * into saved from private.public_links c where c.id=link_id;
  select * into closed from private.public_link_attempt_closures c where c.id=link_id;
  if (saved.id is not null and (saved.business_id<>scope.business_id or saved.outlet_id<>scope.outlet_id
      or saved.kind<>link_kind or coalesce(saved.order_id,saved.account_id)<>resource_id or saved.created_event_id is distinct from create_event_id))
    or (closed.id is not null and (closed.business_id<>scope.business_id or closed.outlet_id<>scope.outlet_id
      or closed.kind<>link_kind or closed.resource_id<>resource_id or closed.create_event_id<>create_event_id)) then
    raise insufficient_privilege using message='This link cannot be changed.';
  end if;
  state:=case when closed.id is not null then 'closed' when saved.id is null then 'missing'
    when saved.revoked_at is not null then 'revoked' when saved.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then 'expired' else 'issued' end;
  return jsonb_build_object('id',link_id,'kind',link_kind,'resourceId',resource_id,'createEventId',create_event_id,'state',state,
    'link',case when saved.id is not null then private.public_link_metadata(saved) end,
    'closure',case when closed.id is not null then jsonb_build_object('eventId',closed.event_id,'actorId',closed.closed_by,'at',closed.closed_at) end);
end $$;
revoke all on function private.read_public_link_attempt(public.ulid,public.ulid,text,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.read_public_link_attempt(public.ulid,public.ulid,text,public.ulid) to authenticated;

create function private.close_public_link_attempt(link_id public.ulid,create_event_id public.ulid,event_id public.ulid,link_kind text,resource_id public.ulid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare scope record; saved private.public_links; closed private.public_link_attempt_closures;
  at_ms public.utc_ms; previous jsonb; result jsonb;
begin
  if event_id is null or event_id=link_id or event_id=create_event_id then
    raise invalid_parameter_value using message='Choose a separate closure event.';
  end if;
  select * into strict scope from private.public_link_scope(link_kind,resource_id);
  -- Serialize each actor's unknown-attempt budget before taking the attempt lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mise.public-link-closure:'||scope.actor_id::text,0));
  result:=private.read_public_link_attempt(link_id,create_event_id,link_kind,resource_id);
  if result->>'state'='closed' then return result; end if;
  select * into saved from private.public_links c where c.id=link_id for update;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if saved.id is null and (select count(*) from private.public_link_attempt_closures c
      where c.business_id=scope.business_id and c.closed_by=scope.actor_id and c.closed_at>at_ms-900000)>=100 then
    raise configuration_limit_exceeded using message='Too many unknown link attempts. Try again later.';
  end if;
  previous:=case when saved.id is not null then private.public_link_metadata(saved) end;
  if saved.id is not null and saved.revoked_at is null then
    at_ms:=greatest(at_ms,saved.created_at);
    update private.public_links c set revoked_at=at_ms where c.id=link_id returning * into saved;
  end if;
  insert into private.public_link_attempt_closures(id,business_id,outlet_id,kind,resource_id,create_event_id,event_id,closed_by,closed_at)
    values(link_id,scope.business_id,scope.outlet_id,link_kind,resource_id,create_event_id,event_id,scope.actor_id,at_ms) returning * into closed;
  result:=private.read_public_link_attempt(link_id,create_event_id,link_kind,resource_id);
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,order_id,customer_id)
    values(event_id,scope.business_id,scope.outlet_id,'member',scope.actor_id,'public_link.close_attempt',coalesce(previous,'null'::jsonb)::json,result::json,at_ms,
      case when link_kind='order' then resource_id end,case when link_kind='khata' then (select a.customer_id from public.credit_accounts a where a.id=resource_id) end);
  return result;
end $$;
revoke all on function private.close_public_link_attempt(public.ulid,public.ulid,public.ulid,text,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.close_public_link_attempt(public.ulid,public.ulid,public.ulid,text,public.ulid) to authenticated;

create function public.read_public_link_attempt(p_id public.ulid,p_create_event_id public.ulid,p_kind text,p_resource_id public.ulid)
returns jsonb language sql security invoker set search_path='' as $$
  select private.read_public_link_attempt(p_id,p_create_event_id,p_kind,p_resource_id)
$$;
create function public.close_public_link_attempt(p_id public.ulid,p_create_event_id public.ulid,p_event_id public.ulid,p_kind text,p_resource_id public.ulid)
returns jsonb language sql security invoker set search_path='' as $$
  select private.close_public_link_attempt(p_id,p_create_event_id,p_event_id,p_kind,p_resource_id)
$$;
revoke all on function public.read_public_link_attempt(public.ulid,public.ulid,text,public.ulid),
  public.close_public_link_attempt(public.ulid,public.ulid,public.ulid,text,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.read_public_link_attempt(public.ulid,public.ulid,text,public.ulid),
  public.close_public_link_attempt(public.ulid,public.ulid,public.ulid,text,public.ulid) to authenticated;
