-- An explicit personal withdrawal fences earlier in-flight registration,
-- including one whose SQL request has not arrived yet. No scope is invented.
create table private.desk_push_closures (
 auth_user_id uuid not null references auth.users(id) on delete cascade,
 subscription_id public.ulid not null,event_id public.ulid not null,
 closed_at public.utc_ms not null,had_subscription boolean not null,
 primary key(auth_user_id,subscription_id),unique(auth_user_id,event_id)
);
create index desk_push_closure_rate_idx on private.desk_push_closures(auth_user_id,closed_at) where not had_subscription;
alter table private.desk_push_closures enable row level security;
alter table private.desk_push_closures force row level security;
revoke all on private.desk_push_closures from public,anon,authenticated,service_role;

create or replace function private.register_desk_push(p_id public.ulid,p_outlet public.ulid,p_endpoint text,p_p256dh text,p_auth text,p_application_key text,p_expires public.utc_ms,p_event public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb;s private.desk_push_subscriptions;fingerprint text;at_ms public.utc_ms;result jsonb;
begin
 perform 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>''
  and u.deleted_at is null and(u.banned_until is null or u.banned_until<=now()) for share;
 if not found then raise insufficient_privilege using message='Sign in with the original phone account.';end if;
 if p_id is null then raise invalid_parameter_value using message='Keep the original notification device.';end if;
 -- Auth/account capability lock precedes all membership/outlet/endpoint locks.
 perform pg_advisory_xact_lock(hashtextextended('mise:desk-push-capability:'||(select auth.uid())::text||':'||p_id::text,0));
 if exists(select 1 from private.desk_push_closures x where x.auth_user_id=(select auth.uid()) and x.subscription_id=p_id) then
  raise sqlstate 'PT409' using message='This original desk setup was withdrawn. Enable again with a new setup.';
 end if;
 scope:=private.device_access_actor(p_outlet);
 perform 1 from public.outlets o where o.business_id=scope->>'businessId' and o.id=p_outlet for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if p_id is null or p_event is null or p_id=p_event or p_endpoint is null or length(p_endpoint)>4096 or
  p_endpoint!~'^https://(fcm[.]googleapis[.]com|[A-Za-z0-9.-]+[.]push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|[A-Za-z0-9.-]+[.]notify[.]windows[.]com)/[^[:space:]#]+$' or
  p_p256dh is null or p_p256dh!~'^B[A-Za-z0-9_-]{86}$' or p_auth is null or p_auth!~'^[A-Za-z0-9_-]{22}$' or
  p_application_key is null or p_application_key!~'^B[A-Za-z0-9_-]{86}$' or p_expires is not null and p_expires<=at_ms then
  raise invalid_parameter_value using message='Enable notifications again on this desk device.';
 end if;
 fingerprint:=encode(sha256(convert_to(p_endpoint,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('mise:desk-push:'||fingerprint,0));
 select * into s from private.desk_push_subscriptions x where x.id=p_id for update;
 if found then
  if s.auth_user_id<>(select auth.uid()) or s.business_id::text<>scope->>'businessId' or s.outlet_id<>p_outlet or s.member_id::text<>scope->>'actorId' or
   s.endpoint<>p_endpoint or s.p256dh<>p_p256dh or s.auth_secret<>p_auth or s.application_key<>p_application_key or
   s.expires_at is distinct from p_expires or s.created_event_id<>p_event or s.revoked_at is not null then
   raise sqlstate 'PT409' using message='Keep the original desk notification setup.';
  end if;
  return private.desk_push_metadata(s);
 end if;
 if exists(select 1 from private.desk_push_subscriptions x where x.endpoint_hash=fingerprint and x.revoked_at is null) then
  raise sqlstate 'PT409' using message='Disable the earlier desk subscription before enabling another.';
 end if;
 if (select count(*) from private.desk_push_subscriptions x where x.auth_user_id=(select auth.uid()) and x.outlet_id=p_outlet and x.revoked_at is null
   and(x.expires_at is null or x.expires_at>at_ms))>=20 then raise sqlstate 'PT429' using message='Remove an earlier desk notification device first.';end if;
 insert into private.desk_push_subscriptions(id,business_id,outlet_id,member_id,auth_user_id,endpoint,endpoint_hash,p256dh,auth_secret,application_key,created_at,expires_at,created_event_id)
 values(p_id,(scope->>'businessId')::public.ulid,p_outlet,(scope->>'actorId')::public.ulid,(select auth.uid()),p_endpoint,fingerprint,p_p256dh,p_auth,p_application_key,at_ms,p_expires,p_event) returning * into s;
 result:=private.desk_push_metadata(s);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(p_event,s.business_id,s.outlet_id,'member',s.member_id,'desk.push.subscribed','null',result::json,at_ms);
 return result;
end $$;

create or replace function private.revoke_desk_push(p_id public.ulid,p_event public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.desk_push_subscriptions;at_ms public.utc_ms;member_actor public.ulid;before_image jsonb;closed private.desk_push_closures;known boolean;
begin
 -- Removing one's own private browser capability remains possible after an
 -- outlet assignment is removed. This does not grant access to that outlet.
 perform 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>''
  and u.deleted_at is null and(u.banned_until is null or u.banned_until<=now()) for share;
 if not found then raise insufficient_privilege using message='Sign in with the original phone account.';end if;
 if p_id is null or p_event is null or p_id=p_event then raise invalid_parameter_value using message='Keep the original notification device.';end if;
 perform pg_advisory_xact_lock(hashtextextended('mise:desk-push-capability:'||(select auth.uid())::text||':'||p_id::text,0));
 select * into closed from private.desk_push_closures x where x.auth_user_id=(select auth.uid()) and x.subscription_id=p_id;
 if found and closed.event_id<>p_event then raise sqlstate 'PT409' using message='Keep the original notification withdrawal.';end if;
 select * into s from private.desk_push_subscriptions x where x.id=p_id and x.auth_user_id=(select auth.uid());
 known:=found;
 if closed.subscription_id is null then
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if not known then
   -- Limit new unknown-capability state per actual phone account. Retried
   -- original withdrawals never consume another slot and closures never expire.
   perform pg_advisory_xact_lock(hashtextextended('mise:desk-push-withdrawal-rate:'||(select auth.uid())::text,0));
   if (select count(*) from private.desk_push_closures x where x.auth_user_id=(select auth.uid()) and not x.had_subscription and x.closed_at>=greatest(0,at_ms-86400000))>=1000 then
    raise sqlstate 'PT429' using message='Keep this original withdrawal and retry later.';
   end if;
  end if;
  if exists(select 1 from private.desk_push_closures x where x.auth_user_id=(select auth.uid()) and x.event_id=p_event) then
   raise sqlstate 'PT409' using message='Keep the withdrawal event with its original notification device.';
  end if;
  insert into private.desk_push_closures(auth_user_id,subscription_id,event_id,closed_at,had_subscription) values((select auth.uid()),p_id,p_event,at_ms,known);
 end if;
 -- No invented member/outlet event for a setup which never existed. Its
 -- explicit personal withdrawal is durably audited by this private closure.
 if not known then return null;end if;
 -- Registration holds outlet before subscription. Keep removal in the same
 -- order; its event FK must not wait for an outlet held by a registration
 -- which is itself waiting for this subscription row.
 perform 1 from public.outlets o where o.business_id=s.business_id and o.id=s.outlet_id for update;
 select * into s from private.desk_push_subscriptions x where x.id=p_id and x.auth_user_id=(select auth.uid()) for update;
 if not found then return null;end if;
 if s.revoked_at is not null then
  if s.revoked_event_id is null then return private.desk_push_metadata(s);end if;
  if s.revoked_event_id is distinct from p_event then raise sqlstate 'PT409' using message='Keep the original notification removal.';end if;
  return private.desk_push_metadata(s);
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;before_image:=private.desk_push_metadata(s);
 update private.desk_push_subscriptions x set revoked_at=at_ms,revoked_event_id=p_event where x.id=p_id returning * into s;
 update private.kitchen_push_deliveries x set state='cancelled',finished_at=at_ms where x.subscription_id=p_id and x.state='pending';
 select m.id into member_actor from public.members m where m.id=s.member_id and m.business_id=s.business_id and m.auth_user_id=(select auth.uid()) for share;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(p_event,s.business_id,s.outlet_id,case when member_actor is null then 'system' else 'member' end,
  coalesce(member_actor::text,'desk-push-cleanup'),'desk.push.unsubscribed',before_image::json,private.desk_push_metadata(s)::json,at_ms);
 return private.desk_push_metadata(s);
end $$;

revoke all on function private.register_desk_push(public.ulid,public.ulid,text,text,text,text,public.utc_ms,public.ulid),private.revoke_desk_push(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.register_desk_push(public.ulid,public.ulid,text,text,text,text,public.utc_ms,public.ulid),private.revoke_desk_push(public.ulid,public.ulid) to authenticated;
