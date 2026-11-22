-- Private desk subscriptions and durable per-recipient alarm delivery.
-- Provider acceptance is transport evidence; it does not acknowledge an order.

-- Browser endpoints/keys are private capabilities, never canonical records.
create table private.desk_push_subscriptions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 member_id public.ulid not null,auth_user_id uuid not null references auth.users(id) on delete cascade,
 endpoint text not null check(length(endpoint) between 20 and 4096),
 endpoint_hash text not null check(endpoint_hash~'^[0-9a-f]{64}$'),
 p256dh text not null check(p256dh~'^B[A-Za-z0-9_-]{86}$'),
 auth_secret text not null check(auth_secret~'^[A-Za-z0-9_-]{22}$'),
 application_key text not null check(application_key~'^B[A-Za-z0-9_-]{86}$'),
 created_at public.utc_ms not null,expires_at public.utc_ms,revoked_at public.utc_ms,
 created_event_id public.ulid not null,revoked_event_id public.ulid,
 unique(business_id,outlet_id,id),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),
 foreign key(business_id,member_id) references public.members(business_id,id),
 foreign key(business_id,outlet_id,created_event_id) references public.events(business_id,outlet_id,id) deferrable initially deferred,
 foreign key(business_id,outlet_id,revoked_event_id) references public.events(business_id,outlet_id,id) deferrable initially deferred
);
create unique index desk_push_active_endpoint_idx on private.desk_push_subscriptions(endpoint_hash) where revoked_at is null;
create index desk_push_account_idx on private.desk_push_subscriptions(auth_user_id,outlet_id) where revoked_at is null;
create index desk_push_outlet_idx on private.desk_push_subscriptions(business_id,outlet_id) where revoked_at is null;

create table private.kitchen_push_deliveries (
 task_id public.ulid not null,generation bigint not null,subscription_id public.ulid not null,
 business_id public.ulid not null,outlet_id public.ulid not null,
 state text not null check(state in('pending','sending','sent','expired','cancelled','failed')),
 attempts integer not null default 0 check(attempts between 0 and 8),
 next_at public.utc_ms not null,lease_id public.ulid,lease_expires_at public.utc_ms,
 created_at public.utc_ms not null,finished_at public.utc_ms,last_outcome text check(last_outcome in('sent','expired','retry')),
 primary key(task_id,generation,subscription_id),
 foreign key(task_id,generation) references private.kitchen_alarm_notifications(task_id,generation),
 foreign key(business_id,outlet_id,task_id) references public.tasks(business_id,outlet_id,id),
 foreign key(business_id,outlet_id,subscription_id) references private.desk_push_subscriptions(business_id,outlet_id,id) on delete cascade
);
create index kitchen_push_ready_idx on private.kitchen_push_deliveries(next_at,task_id,generation,subscription_id) where state='pending';
create index kitchen_push_lease_idx on private.kitchen_push_deliveries(lease_expires_at,task_id,generation,subscription_id) where state='sending';
create index kitchen_push_subscription_idx on private.kitchen_push_deliveries(subscription_id);
create unique index kitchen_push_lease_id_idx on private.kitchen_push_deliveries(lease_id) where lease_id is not null;
alter table private.kitchen_alarm_notifications add prepared_at public.utc_ms;
alter table private.kitchen_alarm_notifications drop constraint kitchen_alarm_notifications_status_check;
alter table private.kitchen_alarm_notifications add constraint kitchen_alarm_notifications_status_check check(status in('pending','sent','complete','cancelled'));
do $$declare t text;begin foreach t in array array['desk_push_subscriptions','kitchen_push_deliveries'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('alter table private.%I force row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
end loop;end $$;

create function private.desk_push_allowed(s private.desk_push_subscriptions) returns boolean
language sql stable security invoker set search_path='' as $$
 select s.revoked_at is null and(s.expires_at is null or s.expires_at>floor(extract(epoch from statement_timestamp())*1000)::bigint)
  and exists(select 1 from public.members m join auth.users u on u.id=m.auth_user_id
   where m.id=s.member_id and m.business_id=s.business_id and m.auth_user_id=s.auth_user_id and m.active
    and m.role in('owner','manager') and not u.is_anonymous and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>''
    and u.deleted_at is null and(u.banned_until is null or u.banned_until<=now())
    and(m.role='owner' or exists(select 1 from public.member_outlets a where a.business_id=m.business_id and a.member_id=m.id and a.outlet_id=s.outlet_id)))
$$;
revoke all on function private.desk_push_allowed(private.desk_push_subscriptions) from public,anon,authenticated,service_role;

create function private.desk_push_metadata(s private.desk_push_subscriptions) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('v',1,'id',s.id,'businessId',s.business_id,'outletId',s.outlet_id,'memberId',s.member_id,
  'createdAt',s.created_at,'expiresAt',s.expires_at,'revokedAt',s.revoked_at)
$$;
revoke all on function private.desk_push_metadata(private.desk_push_subscriptions) from public,anon,authenticated,service_role;

create function private.register_desk_push(p_id public.ulid,p_outlet public.ulid,p_endpoint text,p_p256dh text,p_auth text,p_application_key text,p_expires public.utc_ms,p_event public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb;s private.desk_push_subscriptions;fingerprint text;at_ms public.utc_ms;result jsonb;
begin
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

create function private.revoke_desk_push(p_id public.ulid,p_event public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.desk_push_subscriptions;at_ms public.utc_ms;member_actor public.ulid;before_image jsonb;
begin
 -- Removing one's own private browser capability remains possible after an
 -- outlet assignment is removed. This does not grant access to that outlet.
 perform 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>''
  and u.deleted_at is null and(u.banned_until is null or u.banned_until<=now()) for share;
 if not found then raise insufficient_privilege using message='Sign in with the original phone account.';end if;
 if p_id is null or p_event is null or p_id=p_event then raise invalid_parameter_value using message='Keep the original notification device.';end if;
 select * into s from private.desk_push_subscriptions x where x.id=p_id and x.auth_user_id=(select auth.uid());
 if not found then return null;end if;
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

create function private.read_desk_push(p_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s private.desk_push_subscriptions;
begin
 select * into s from private.desk_push_subscriptions x where x.id=p_id and x.auth_user_id=(select auth.uid());
 if not found or not private.desk_push_allowed(s) then return null;end if;
 return private.desk_push_metadata(s);
end $$;

revoke all on function private.register_desk_push(public.ulid,public.ulid,text,text,text,text,public.utc_ms,public.ulid),private.revoke_desk_push(public.ulid,public.ulid),private.read_desk_push(public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.register_desk_push(public.ulid,public.ulid,text,text,text,text,public.utc_ms,public.ulid),private.revoke_desk_push(public.ulid,public.ulid),private.read_desk_push(public.ulid) to authenticated;
create function public.register_desk_push(p_id public.ulid,p_outlet_id public.ulid,p_endpoint text,p_p256dh text,p_auth text,p_application_key text,p_expires_at public.utc_ms,p_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.register_desk_push(p_id,p_outlet_id,p_endpoint,p_p256dh,p_auth,p_application_key,p_expires_at,p_event_id)$$;
create function public.revoke_desk_push(p_id public.ulid,p_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.revoke_desk_push(p_id,p_event_id)$$;
create function public.read_desk_push(p_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.read_desk_push(p_id)$$;
revoke all on function public.register_desk_push(public.ulid,public.ulid,text,text,text,text,public.utc_ms,public.ulid),public.revoke_desk_push(public.ulid,public.ulid),public.read_desk_push(public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.register_desk_push(public.ulid,public.ulid,text,text,text,text,public.utc_ms,public.ulid),public.revoke_desk_push(public.ulid,public.ulid),public.read_desk_push(public.ulid) to authenticated;

-- Materialize recipient identities once, separately from provider acceptance.
create index kitchen_alarm_notification_pending_idx on private.kitchen_alarm_notifications(created_at,task_id,generation) where status='pending';
create function private.cancel_pending_kitchen_push() returns trigger
language plpgsql security definer set search_path='' as $$
declare at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if new.status<>'open' then
  update private.kitchen_push_deliveries x set state='cancelled',finished_at=at_ms where x.task_id=new.id and x.state='pending';
 end if;
 return null;
end $$;
revoke all on function private.cancel_pending_kitchen_push() from public,anon,authenticated,service_role;
create trigger kitchen_push_task_closed after update of status on public.tasks for each row execute function private.cancel_pending_kitchen_push();

create function private.prepare_kitchen_push(application_key text,batch_size integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate record;n private.kitchen_alarm_notifications;b private.kitchen_alarm_tasks;t public.tasks;
 at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;result jsonb;
begin
 if application_key is null or application_key!~'^B[A-Za-z0-9_-]{86}$' or batch_size is null or batch_size not between 1 and 25 then
  raise invalid_parameter_value using message='Use a bounded desk notification batch.';end if;
 for candidate in select chosen.* from(
  select x.task_id,x.generation,x.created_at,alarm_binding.business_id,alarm_binding.outlet_id from private.kitchen_alarm_notifications x
  join private.kitchen_alarm_tasks alarm_binding on alarm_binding.task_id=x.task_id where x.status='pending' and x.prepared_at is null
  order by x.created_at,x.task_id,x.generation limit batch_size
 ) chosen order by chosen.business_id,chosen.outlet_id,chosen.created_at,chosen.task_id,chosen.generation loop
  -- Choose by age, then acquire scope locks in one order within the batch.
  perform 1 from public.outlets o where o.business_id=candidate.business_id and o.id=candidate.outlet_id for share;
  -- Task before notification, like Got it/close. Otherwise the new delivery FK
  -- can wait for a task held by a closer waiting on this notification row.
  select * into t from public.tasks x where x.id=candidate.task_id for share;
  select * into n from private.kitchen_alarm_notifications x where x.task_id=candidate.task_id and x.generation=candidate.generation
   and x.status='pending' and x.prepared_at is null for update skip locked;
  if not found then continue;end if;
  select * into b from private.kitchen_alarm_tasks x where x.task_id=n.task_id;
  if t.id is null or t.status<>'open' or b.task_id is null or b.generation<>n.generation then
   update private.kitchen_alarm_notifications x set status='cancelled',prepared_at=at_ms where x.task_id=n.task_id and x.generation=n.generation;
   continue;
  end if;
  insert into private.kitchen_push_deliveries(task_id,generation,subscription_id,business_id,outlet_id,state,next_at,created_at)
   select n.task_id,n.generation,s.id,b.business_id,b.outlet_id,'pending',at_ms,at_ms from private.desk_push_subscriptions s
   where s.business_id=b.business_id and s.outlet_id=b.outlet_id and s.application_key=prepare_kitchen_push.application_key and private.desk_push_allowed(s)
   on conflict(task_id,generation,subscription_id) do nothing;
  update private.kitchen_alarm_notifications x set prepared_at=at_ms,
   status=case when exists(select 1 from private.kitchen_push_deliveries d where d.task_id=n.task_id and d.generation=n.generation) then 'pending' else 'complete' end
   where x.task_id=n.task_id and x.generation=n.generation;
 end loop;
 -- Two independent delivery finishes can each observe the other's uncommitted
 -- pending row. Settle that harmless aggregate lag on the next bounded tick.
 for candidate in select x.task_id,x.generation from private.kitchen_alarm_notifications x where x.status='pending' and x.prepared_at is not null
  and not exists(select 1 from private.kitchen_push_deliveries d where d.task_id=x.task_id and d.generation=x.generation and d.state in('pending','sending'))
  order by x.created_at,x.task_id,x.generation limit batch_size loop
  update private.kitchen_alarm_notifications x set status='complete' where x.task_id=candidate.task_id and x.generation=candidate.generation and x.status='pending';
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('taskId',x.task_id,'generation',x.generation,'subscriptionId',x.subscription_id) order by x.due,x.task_id,x.generation,x.subscription_id),'[]'::jsonb)
 into result from(
  select d.*,case when d.state='sending' then d.lease_expires_at else d.next_at end as due from private.kitchen_push_deliveries d
  join private.kitchen_alarm_notifications q on q.task_id=d.task_id and q.generation=d.generation
  where q.status='pending' and(d.state='pending' and d.next_at<=at_ms or d.state='sending' and d.lease_expires_at<=at_ms)
  order by due,d.task_id,d.generation,d.subscription_id limit batch_size
 ) x;
 return jsonb_build_object('v',1,'at',at_ms,'jobs',result);
end $$;

create function private.claim_kitchen_push(task public.ulid,generation bigint,subscription public.ulid,lease public.ulid,application_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d private.kitchen_push_deliveries;s private.desk_push_subscriptions;n private.kitchen_alarm_notifications;t public.tasks;b private.kitchen_alarm_tasks;
 at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if task is null or generation is null or generation<1 or subscription is null or lease is null or application_key is null or application_key!~'^B[A-Za-z0-9_-]{86}$' then
  raise invalid_parameter_value using message='Use the original desk notification.';end if;
 select * into d from private.kitchen_push_deliveries x where x.task_id=task and x.generation=claim_kitchen_push.generation and x.subscription_id=subscription;
 if not found then return null;end if;
 perform 1 from public.outlets o where o.business_id=d.business_id and o.id=d.outlet_id for share;
 select * into t from public.tasks x where x.id=task for share;
 select * into s from private.desk_push_subscriptions x where x.id=subscription for share;
 select * into n from private.kitchen_alarm_notifications x where x.task_id=task and x.generation=claim_kitchen_push.generation for update;
 select * into d from private.kitchen_push_deliveries x where x.task_id=task and x.generation=claim_kitchen_push.generation and x.subscription_id=subscription for update;
 if not found or d.state not in('pending','sending') or d.state='pending' and d.next_at>at_ms or d.state='sending' and d.lease_expires_at>at_ms then return null;end if;
 select * into b from private.kitchen_alarm_tasks x where x.task_id=task;
 if t.id is null or t.status<>'open' or b.task_id is null or b.generation<>generation or n.task_id is null or n.status<>'pending' or s.id is null or not private.desk_push_allowed(s)
  or s.business_id<>d.business_id or s.outlet_id<>d.outlet_id or s.application_key<>claim_kitchen_push.application_key then
  update private.kitchen_push_deliveries x set state='cancelled',finished_at=at_ms where x.task_id=task and x.generation=claim_kitchen_push.generation and x.subscription_id=subscription;
  return null;
 end if;
 -- Defer transport until the alarm worker has inspected the latest order,
 -- settings and actual ACK. A queued content change must not send an older
 -- task while its current acknowledgement awaits that worker transaction.
 if not exists(select 1 from private.kitchen_alarm_work w where w.business_id=d.business_id and w.outlet_id=d.outlet_id
  and w.order_id=b.order_id and w.next_at is null) then return null;end if;
 if d.attempts>=8 then
  update private.kitchen_push_deliveries x set state='failed',finished_at=at_ms where x.task_id=task and x.generation=claim_kitchen_push.generation and x.subscription_id=subscription;
  return null;
 end if;
 update private.kitchen_push_deliveries x set state='sending',attempts=x.attempts+1,lease_id=lease,lease_expires_at=at_ms+20000,last_outcome=null
  where x.task_id=task and x.generation=claim_kitchen_push.generation and x.subscription_id=subscription;
 return jsonb_build_object('v',1,'leaseId',lease,
  'subscription',jsonb_build_object('endpoint',s.endpoint,'expirationTime',s.expires_at,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth_secret)),
  'notice',jsonb_build_object('v',1,'type','kitchen-alarm','subscriptionId',subscription,'businessId',d.business_id,'outletId',d.outlet_id,'taskId',task,'generation',generation));
end $$;

create function private.finish_kitchen_push(task public.ulid,generation bigint,subscription public.ulid,lease public.ulid,outcome text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d private.kitchen_push_deliveries;s private.desk_push_subscriptions;n private.kitchen_alarm_notifications;t public.tasks;b private.kitchen_alarm_tasks;
 at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;result_state text;retry_at public.utc_ms;
begin
 if task is null or generation is null or generation<1 or subscription is null or lease is null or outcome is null or outcome not in('sent','expired','retry') then
  raise invalid_parameter_value using message='Keep the actual desk notification result.';end if;
 -- Scope first, like normal orders/Got it/removal. The result event's outlet
 -- FK must not wait on a closer which is waiting for our task share lock.
 select * into d from private.kitchen_push_deliveries x where x.task_id=task and x.generation=finish_kitchen_push.generation and x.subscription_id=subscription;
 if not found then return jsonb_build_object('state','stale');end if;
 perform 1 from public.outlets o where o.business_id=d.business_id and o.id=d.outlet_id for share;
 select * into t from public.tasks x where x.id=task for share;
 select * into s from private.desk_push_subscriptions x where x.id=subscription for update;
 select * into n from private.kitchen_alarm_notifications x where x.task_id=task and x.generation=finish_kitchen_push.generation for update;
 select * into d from private.kitchen_push_deliveries x where x.task_id=task and x.generation=finish_kitchen_push.generation and x.subscription_id=subscription for update;
 if not found or d.lease_id is distinct from lease then return jsonb_build_object('state','stale');end if;
 if d.state<>'sending' then
  if d.last_outcome=outcome then return jsonb_build_object('state',d.state);end if;
  raise sqlstate 'PT409' using message='Keep the original provider result.';
 end if;
 select * into b from private.kitchen_alarm_tasks x where x.task_id=task;
 if outcome in('sent','expired') then
  result_state:=outcome;
  -- An already-in-flight accepted request remains real transport history if
  -- Got it closed the task while HTTP was running. It never reopens a task.
  if outcome='expired' and s.revoked_at is null then
   update private.desk_push_subscriptions x set revoked_at=at_ms where x.id=subscription returning * into s;
   update private.kitchen_push_deliveries x set state='cancelled',finished_at=at_ms where x.subscription_id=subscription and x.state='pending';
  end if;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
   values(lease,d.business_id,d.outlet_id,'system','desk-push','desk.push.'||outcome,
    json_build_object('taskId',task,'generation',generation,'subscriptionId',subscription,'state','sending'),
    json_build_object('taskId',task,'generation',generation,'subscriptionId',subscription,'state',outcome,
      'result',case when outcome='sent' then 'provider-accepted' else 'provider-expired' end),at_ms);
 elsif t.id is null or t.status<>'open' or n.status<>'pending' or b.generation<>generation or s.id is null or not private.desk_push_allowed(s) then
  result_state:='cancelled';
 elsif d.attempts>=8 then result_state:='failed';
 else result_state:='pending';retry_at:=at_ms+least(30000::bigint,1000::bigint<<least(greatest(d.attempts-1,0),5));end if;
 update private.kitchen_push_deliveries x set state=result_state,next_at=coalesce(retry_at,x.next_at),lease_expires_at=null,last_outcome=outcome,
  finished_at=case when result_state='pending' then null else at_ms end
  where x.task_id=task and x.generation=finish_kitchen_push.generation and x.subscription_id=subscription;
 if n.status='pending' and not exists(select 1 from private.kitchen_push_deliveries x where x.task_id=task and x.generation=finish_kitchen_push.generation and x.state in('pending','sending')) then
  update private.kitchen_alarm_notifications x set status='complete' where x.task_id=task and x.generation=finish_kitchen_push.generation and x.status='pending';
 end if;
 return jsonb_build_object('state',result_state);
end $$;

revoke all on function private.prepare_kitchen_push(text,integer),private.claim_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text),
 private.finish_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function private.prepare_kitchen_push(text,integer),private.claim_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text),
 private.finish_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text) to service_role;
create function public.prepare_kitchen_push(p_application_key text,p_limit integer default 25) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_kitchen_push(p_application_key,p_limit)$$;
create function public.claim_kitchen_push(p_task_id public.ulid,p_generation bigint,p_subscription_id public.ulid,p_lease_id public.ulid,p_application_key text) returns jsonb
language sql security invoker set search_path='' as $$select private.claim_kitchen_push(p_task_id,p_generation,p_subscription_id,p_lease_id,p_application_key)$$;
create function public.finish_kitchen_push(p_task_id public.ulid,p_generation bigint,p_subscription_id public.ulid,p_lease_id public.ulid,p_outcome text) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_kitchen_push(p_task_id,p_generation,p_subscription_id,p_lease_id,p_outcome)$$;
revoke all on function public.prepare_kitchen_push(text,integer),public.claim_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text),
 public.finish_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_kitchen_push(text,integer),public.claim_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text),
 public.finish_kitchen_push(public.ulid,bigint,public.ulid,public.ulid,text) to service_role;

-- Configuration discloses only an actually assigned phone operator's scope.
create function private.desk_push_context(outlet public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope jsonb;
begin
 scope:=private.device_access_actor(outlet);
 return jsonb_build_object('v',1,'businessId',scope->>'businessId','outletId',scope->>'outletId','memberId',scope->>'actorId','role',scope->>'actorRole');
end $$;
revoke all on function private.desk_push_context(public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.desk_push_context(public.ulid) to authenticated;
create function public.desk_push_context(p_outlet_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.desk_push_context(p_outlet_id)$$;
revoke all on function public.desk_push_context(public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.desk_push_context(public.ulid) to authenticated;
