-- General urgent Inbox notifications require their own explicit consent. Old
-- kitchen subscriptions, function bodies, and consent retain their purpose.
create table private.urgent_inbox_consents (
 id public.ulid primary key,subscription_id public.ulid not null,
 -- Original identity remains in immutable history after base removal. Only
 -- this live pointer follows the capability's lifetime; it never reattaches.
 active_subscription_id public.ulid references private.desk_push_subscriptions(id) on delete set null,
 auth_user_id uuid not null references auth.users(id) on delete cascade,
 business_id public.ulid not null,outlet_id public.ulid not null,member_id public.ulid not null,
 role text not null check(role in('owner','manager')),created_at public.utc_ms not null,revoked_at public.utc_ms,
 created_event_id public.ulid not null,revoked_event_id public.ulid,position bigint generated always as identity unique,
 unique(business_id,outlet_id,id),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),
 foreign key(business_id,member_id) references public.members(business_id,id),
 foreign key(business_id,outlet_id,created_event_id) references public.events(business_id,outlet_id,id) deferrable initially deferred,
 foreign key(business_id,outlet_id,revoked_event_id) references public.events(business_id,outlet_id,id) deferrable initially deferred,
 check(revoked_at is null or revoked_at>=created_at)
);
create unique index urgent_inbox_one_consent on private.urgent_inbox_consents(subscription_id) where revoked_at is null;
create index urgent_inbox_consent_subscription on private.urgent_inbox_consents(subscription_id);
create index urgent_inbox_consent_active_subscription on private.urgent_inbox_consents(active_subscription_id);
create index urgent_inbox_consent_personal on private.urgent_inbox_consents(auth_user_id,id);
create index urgent_inbox_consent_member on private.urgent_inbox_consents(business_id,member_id);
create index urgent_inbox_consent_created_event on private.urgent_inbox_consents(business_id,outlet_id,created_event_id);
create index urgent_inbox_consent_revoked_event on private.urgent_inbox_consents(business_id,outlet_id,revoked_event_id);
create index urgent_inbox_consent_scope on private.urgent_inbox_consents(business_id,outlet_id,position) where revoked_at is null;
create table private.urgent_inbox_closures (
 auth_user_id uuid not null references auth.users(id) on delete cascade,id public.ulid not null,event_id public.ulid not null,
 closed_at public.utc_ms not null,had_consent boolean not null,primary key(auth_user_id,id),unique(auth_user_id,event_id)
);
create index urgent_inbox_closure_rate on private.urgent_inbox_closures(auth_user_id,closed_at) where not had_consent;
create table private.urgent_inbox_tasks (
 task_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 generation bigint not null check(generation between 0 and 9007199254740991),active boolean not null,
 foreign key(business_id,outlet_id,task_id) references public.tasks(business_id,outlet_id,id) on delete cascade
);
create index urgent_inbox_task_scope on private.urgent_inbox_tasks(business_id,outlet_id,task_id);
create table private.urgent_inbox_generations (
 task_id public.ulid not null,generation bigint not null check(generation between 1 and 9007199254740991),
 business_id public.ulid not null,outlet_id public.ulid not null,created_at public.utc_ms not null,prepared_at public.utc_ms,
 state text not null check(state in('pending','complete','cancelled')),recipient_through bigint,recipient_after bigint not null default 0,
 primary key(task_id,generation),
 foreign key(business_id,outlet_id,task_id) references public.tasks(business_id,outlet_id,id) on delete cascade
);
create index urgent_inbox_generation_scope on private.urgent_inbox_generations(business_id,outlet_id,task_id);
create index urgent_inbox_unprepared on private.urgent_inbox_generations(created_at,task_id,generation) where state='pending' and prepared_at is null;
create index urgent_inbox_awaiting_delivery on private.urgent_inbox_generations(created_at,task_id,generation) where state='pending' and prepared_at is not null;
create table private.urgent_inbox_deliveries (
 task_id public.ulid not null,generation bigint not null,consent_id public.ulid not null,
 subscription_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 state text not null check(state in('pending','sending','sent','expired','cancelled','failed')),
 attempts integer not null default 0 check(attempts between 0 and 8),next_at public.utc_ms not null,
 lease_id public.ulid,lease_expires_at public.utc_ms,created_at public.utc_ms not null,finished_at public.utc_ms,
 last_outcome text check(last_outcome in('sent','expired','retry')),primary key(task_id,generation,consent_id),
 foreign key(task_id,generation) references private.urgent_inbox_generations(task_id,generation) on delete cascade,
 foreign key(business_id,outlet_id,consent_id) references private.urgent_inbox_consents(business_id,outlet_id,id) on delete cascade
);
create index urgent_inbox_delivery_consent on private.urgent_inbox_deliveries(business_id,outlet_id,consent_id);
create index urgent_inbox_delivery_subscription on private.urgent_inbox_deliveries(subscription_id);
create index urgent_inbox_ready on private.urgent_inbox_deliveries(next_at,task_id,generation,consent_id) where state='pending';
create index urgent_inbox_expired_lease on private.urgent_inbox_deliveries(lease_expires_at,task_id,generation,consent_id) where state='sending';
create unique index urgent_inbox_lease on private.urgent_inbox_deliveries(lease_id) where lease_id is not null;
do $$declare t text;begin foreach t in array array['urgent_inbox_consents','urgent_inbox_closures','urgent_inbox_tasks','urgent_inbox_generations','urgent_inbox_deliveries'] loop
 execute format('alter table private.%I enable row level security',t);
 execute format('alter table private.%I force row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
end loop;end $$;

create function private.urgent_inbox_metadata(c private.urgent_inbox_consents) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('v',1,'id',c.id,'subscriptionId',c.subscription_id,'businessId',c.business_id,'outletId',c.outlet_id,
 'memberId',c.member_id,'role',c.role,'createdAt',c.created_at,'revokedAt',c.revoked_at)
$$;
revoke all on function private.urgent_inbox_metadata(private.urgent_inbox_consents) from public,anon,authenticated,service_role;

create function private.register_urgent_inbox(id public.ulid,subscription public.ulid,event public.ulid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare account uuid;scope jsonb;s private.desk_push_subscriptions;c private.urgent_inbox_consents;stamp public.utc_ms;answer jsonb;
begin
 account:=private.owner_task_account();
 if id is null or subscription is null or event is null or id in(subscription,event) or subscription=event then raise invalid_parameter_value using message='Keep the original urgent notification choice.';end if;
 perform pg_advisory_xact_lock(hashtextextended('mise:urgent-inbox-consent:'||account::text||':'||id::text,0));
 if exists(select 1 from private.urgent_inbox_closures x where x.auth_user_id=account and x.id=register_urgent_inbox.id) then raise sqlstate 'PT409' using message='This original consent was withdrawn. Choose a new consent.';end if;
 select * into s from private.desk_push_subscriptions x where x.id=subscription and x.auth_user_id=account;
 if not found then raise insufficient_privilege using message='Use your own original desk subscription.';end if;
 perform 1 from public.businesses b where b.id=s.business_id for key share;
 perform 1 from public.outlets o where o.business_id=s.business_id and o.id=s.outlet_id for update;
 select * into s from private.desk_push_subscriptions x where x.id=subscription and x.auth_user_id=account for update;
 scope:=private.owner_task_access(s.outlet_id);
 if not private.desk_push_allowed(s) or scope->>'businessId'<>s.business_id::text or scope->>'memberId'<>s.member_id::text then raise insufficient_privilege using message='Enable this desk with your current assigned phone account.';end if;
 select * into c from private.urgent_inbox_consents x where x.id=register_urgent_inbox.id for update;
 if found then
  if c.auth_user_id<>account or c.subscription_id<>subscription or c.active_subscription_id is distinct from subscription or c.created_event_id<>event or c.role<>scope->>'role' or c.revoked_at is not null then raise sqlstate 'PT409' using message='Keep the complete original urgent notification choice.';end if;
  return private.urgent_inbox_metadata(c);
 end if;
 if exists(select 1 from private.urgent_inbox_consents x where x.subscription_id=subscription and x.revoked_at is null) then raise sqlstate 'PT409' using message='Withdraw the earlier urgent consent before enabling again.';end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 insert into private.urgent_inbox_consents(id,subscription_id,active_subscription_id,auth_user_id,business_id,outlet_id,member_id,role,created_at,created_event_id)
 values(id,subscription,subscription,account,s.business_id,s.outlet_id,s.member_id,scope->>'role',stamp,event) returning * into c;
 answer:=private.urgent_inbox_metadata(c);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(event,c.business_id,c.outlet_id,'member',c.member_id,'inbox.push.enabled','null',answer::json,stamp);
 return answer;
end $$;

create function private.read_urgent_inbox(id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.urgent_inbox_consents;account uuid;
begin
 account:=private.owner_task_account();if id is null then raise invalid_parameter_value;end if;
 select * into c from private.urgent_inbox_consents x where x.id=read_urgent_inbox.id and x.auth_user_id=account;
 if not found then return null;end if;return private.urgent_inbox_metadata(c);
end $$;
create function private.withdraw_urgent_inbox(id public.ulid,event public.ulid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare account uuid;c private.urgent_inbox_consents;closed private.urgent_inbox_closures;known boolean;stamp public.utc_ms;before_image jsonb;member_actor public.ulid;
begin
 account:=private.owner_task_account();if id is null or event is null or id=event then raise invalid_parameter_value using message='Keep the original urgent notification withdrawal.';end if;
 perform pg_advisory_xact_lock(hashtextextended('mise:urgent-inbox-consent:'||account::text||':'||id::text,0));
 select * into closed from private.urgent_inbox_closures x where x.auth_user_id=account and x.id=withdraw_urgent_inbox.id;
 if found and closed.event_id<>event then raise sqlstate 'PT409' using message='Keep the original withdrawal event.';end if;
 select * into c from private.urgent_inbox_consents x where x.id=withdraw_urgent_inbox.id and x.auth_user_id=account;
 known:=found;
 if closed.id is null then
  stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if not known then
   perform pg_advisory_xact_lock(hashtextextended('mise:urgent-inbox-closure-rate:'||account::text,0));
   if(select count(*) from private.urgent_inbox_closures x where x.auth_user_id=account and not x.had_consent and x.closed_at>=stamp-stamp%86400000)>=1000 then raise sqlstate 'PT429' using message='Keep this withdrawal and retry later.';end if;
  end if;
  if exists(select 1 from private.urgent_inbox_closures x where x.auth_user_id=account and x.event_id=event) then raise sqlstate 'PT409' using message='Keep the event with its original consent.';end if;
  insert into private.urgent_inbox_closures values(account,id,event,stamp,known) returning * into closed;
 end if;
 if known then
  perform 1 from public.businesses b where b.id=c.business_id for key share;
  perform 1 from public.outlets o where o.business_id=c.business_id and o.id=c.outlet_id for update;
  select * into c from private.urgent_inbox_consents x where x.id=withdraw_urgent_inbox.id and x.auth_user_id=account for update;
  if c.revoked_at is null then
   stamp:=greatest(closed.closed_at,c.created_at);before_image:=private.urgent_inbox_metadata(c);
   update private.urgent_inbox_consents x set revoked_at=stamp,revoked_event_id=event where x.id=c.id returning * into c;
   update private.urgent_inbox_deliveries x set state='cancelled',finished_at=stamp where x.consent_id=c.id and x.state='pending';
   select m.id into member_actor from public.members m where m.id=c.member_id and m.business_id=c.business_id and m.auth_user_id=account for share;
   insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
   values(event,c.business_id,c.outlet_id,case when member_actor is null then 'system' else 'member' end,coalesce(member_actor::text,'urgent-inbox-cleanup'),'inbox.push.disabled',before_image::json,private.urgent_inbox_metadata(c)::json,stamp);
  elsif c.revoked_event_id is distinct from event then raise sqlstate 'PT409' using message='Keep the original urgent notification withdrawal.';end if;
 end if;
 return jsonb_build_object('v',1,'id',id,'eventId',event,'closedAt',closed.closed_at,'consent',case when known then private.urgent_inbox_metadata(c) else null end);
end $$;
revoke all on function private.register_urgent_inbox(public.ulid,public.ulid,public.ulid),private.read_urgent_inbox(public.ulid),private.withdraw_urgent_inbox(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.register_urgent_inbox(public.ulid,public.ulid,public.ulid),private.read_urgent_inbox(public.ulid),private.withdraw_urgent_inbox(public.ulid,public.ulid) to authenticated;
create function public.register_urgent_inbox(p_id public.ulid,p_subscription_id public.ulid,p_event_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.register_urgent_inbox(p_id,p_subscription_id,p_event_id)$$;
create function public.read_urgent_inbox(p_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.read_urgent_inbox(p_id)$$;
create function public.withdraw_urgent_inbox(p_id public.ulid,p_event_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.withdraw_urgent_inbox(p_id,p_event_id)$$;
revoke all on function public.register_urgent_inbox(public.ulid,public.ulid,public.ulid),public.read_urgent_inbox(public.ulid),public.withdraw_urgent_inbox(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.register_urgent_inbox(public.ulid,public.ulid,public.ulid),public.read_urgent_inbox(public.ulid),public.withdraw_urgent_inbox(public.ulid,public.ulid) to authenticated;

create function private.urgent_inbox_eligible(t public.tasks) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce(t.status in('open','waiting') and not exists(select 1 from private.kitchen_alarm_tasks k where k.task_id=t.id)
 and(exists(select 1 from private.owner_task_definitions d where d.task_id=t.id and d.business_id=t.business_id and d.outlet_id=t.outlet_id and d.urgent)
 or exists(select 1 from private.payment_sources p where p.task_id=t.id and p.business_id=t.business_id and p.outlet_id=t.outlet_id)),false)
$$;
revoke all on function private.urgent_inbox_eligible(public.tasks) from public,anon,authenticated,service_role;
create function private.note_urgent_inbox(task public.ulid) returns void
language plpgsql security invoker set search_path='' as $$
declare t public.tasks;s private.urgent_inbox_tasks;eligible boolean;stamp public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 select * into t from public.tasks x where x.id=task;if not found then return;end if;
 eligible:=private.urgent_inbox_eligible(t);
 insert into private.urgent_inbox_tasks values(task,t.business_id,t.outlet_id,0,false) on conflict(task_id) do nothing;
 select * into s from private.urgent_inbox_tasks x where x.task_id=task for update;
 if eligible=s.active then return;end if;
 if eligible then
  if s.generation>=9007199254740991 then raise sqlstate 'PT409' using message='Keep this task for manual review.';end if;
  update private.urgent_inbox_tasks x set generation=x.generation+1,active=true where x.task_id=task returning * into s;
  insert into private.urgent_inbox_generations(task_id,generation,business_id,outlet_id,created_at,prepared_at,state) values(task,s.generation,t.business_id,t.outlet_id,stamp,null,'pending');
 else
  update private.urgent_inbox_tasks x set active=false where x.task_id=task;
  update private.urgent_inbox_generations x set state='cancelled' where x.task_id=task and x.generation=s.generation and x.state='pending';
  update private.urgent_inbox_deliveries x set state='cancelled',finished_at=stamp where x.task_id=task and x.generation=s.generation and x.state='pending';
 end if;
end $$;
revoke all on function private.note_urgent_inbox(public.ulid) from public,anon,authenticated,service_role;
create function private.urgent_inbox_task_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare task public.ulid;
begin
 if tg_table_name='tasks' then if tg_op='DELETE' then task:=old.id;else task:=new.id;end if;
 else if tg_op='DELETE' then task:=old.task_id;else task:=new.task_id;end if;end if;
 perform private.note_urgent_inbox(task);return null;
end $$;
revoke all on function private.urgent_inbox_task_changed() from public,anon,authenticated,service_role;
create trigger urgent_inbox_task_changed after insert or update on public.tasks for each row execute function private.urgent_inbox_task_changed();
create trigger urgent_inbox_definition_changed after insert or update or delete on private.owner_task_definitions for each row execute function private.urgent_inbox_task_changed();
create trigger urgent_inbox_source_changed after insert or update or delete on private.payment_sources for each row execute function private.urgent_inbox_task_changed();
do $$declare t record;begin for t in select id from public.tasks order by business_id,outlet_id,id loop perform private.note_urgent_inbox(t.id);end loop;end $$;

create function private.prepare_urgent_inbox_push(application_key text,batch_size integer) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare candidate record;n private.urgent_inbox_generations;t public.tasks;s private.urgent_inbox_tasks;stamp public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;jobs jsonb;page_after bigint;more boolean;inserted_count integer;
begin
 if application_key is null or application_key!~'^B[A-Za-z0-9_-]{86}$' or batch_size is null or batch_size not between 1 and 25 then raise invalid_parameter_value;end if;
 for candidate in select q.* from(select x.* from private.urgent_inbox_generations x where x.state='pending' and x.prepared_at is null order by x.created_at,x.task_id,x.generation limit batch_size)q order by q.business_id,q.outlet_id,q.task_id,q.generation loop
  perform 1 from public.businesses b where b.id=candidate.business_id for share;
  perform 1 from public.outlets o where o.business_id=candidate.business_id and o.id=candidate.outlet_id for share;
  select * into t from public.tasks x where x.id=candidate.task_id for share;
  select * into s from private.urgent_inbox_tasks x where x.task_id=candidate.task_id for share;
  select * into n from private.urgent_inbox_generations x where x.task_id=candidate.task_id and x.generation=candidate.generation and x.state='pending' and x.prepared_at is null for update skip locked;
  if not found then continue;end if;
  if t.id is null or not private.urgent_inbox_eligible(t) or not s.active or s.generation<>n.generation then
   update private.urgent_inbox_generations x set state='cancelled',prepared_at=stamp where x.task_id=n.task_id and x.generation=n.generation;continue;
  end if;
  if n.recipient_through is null then
   select coalesce(max(c.position),0) into n.recipient_through from private.urgent_inbox_consents c where c.business_id=n.business_id and c.outlet_id=n.outlet_id and c.revoked_at is null;
   update private.urgent_inbox_generations x set recipient_through=n.recipient_through where x.task_id=n.task_id and x.generation=n.generation;
  end if;
  with recipients as materialized(
   select c.id,c.subscription_id,c.position from private.urgent_inbox_consents c join private.desk_push_subscriptions d on d.id=c.active_subscription_id and c.active_subscription_id=c.subscription_id
   join public.members m on m.id=c.member_id and m.business_id=c.business_id
   where c.business_id=n.business_id and c.outlet_id=n.outlet_id and c.revoked_at is null and c.role=m.role and d.auth_user_id=c.auth_user_id and d.member_id=c.member_id and d.business_id=c.business_id and d.outlet_id=c.outlet_id
   and c.position>n.recipient_after and c.position<=n.recipient_through
   and d.application_key=prepare_urgent_inbox_push.application_key and private.desk_push_allowed(d) order by c.position limit 51
  ),inserted as(
   insert into private.urgent_inbox_deliveries(task_id,generation,consent_id,subscription_id,business_id,outlet_id,state,next_at,created_at)
   select n.task_id,n.generation,c.id,c.subscription_id,n.business_id,n.outlet_id,'pending',stamp,stamp from recipients c order by c.position limit 50
   on conflict(task_id,generation,consent_id) do nothing returning consent_id
  )select coalesce((select max(p.position) from(select c.position from recipients c order by c.position limit 50)p),n.recipient_after),
   (select count(*)>50 from recipients),(select count(*) from inserted) into page_after,more,inserted_count;
  update private.urgent_inbox_generations x set recipient_after=page_after,prepared_at=case when more then null else stamp end,
   state=case when more or exists(select 1 from private.urgent_inbox_deliveries d where d.task_id=n.task_id and d.generation=n.generation and d.state in('pending','sending')) then 'pending' else 'complete' end
   where x.task_id=n.task_id and x.generation=n.generation;
 end loop;
 for candidate in select x.task_id,x.generation from private.urgent_inbox_generations x where x.state='pending' and x.prepared_at is not null
  and not exists(select 1 from private.urgent_inbox_deliveries d where d.task_id=x.task_id and d.generation=x.generation and d.state in('pending','sending'))
  order by x.created_at,x.task_id,x.generation limit batch_size loop
  update private.urgent_inbox_generations x set state='complete' where x.task_id=candidate.task_id and x.generation=candidate.generation and x.state='pending';
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('taskId',q.task_id,'generation',q.generation,'consentId',q.consent_id,'subscriptionId',q.subscription_id) order by q.due,q.task_id,q.generation,q.consent_id),'[]'::jsonb) into jobs from(
  select bounded.* from(
   (select d.task_id,d.generation,d.consent_id,d.subscription_id,d.next_at due from private.urgent_inbox_deliveries d where d.state='pending' and d.next_at<=stamp order by d.next_at,d.task_id,d.generation,d.consent_id limit batch_size)
   union all
   (select d.task_id,d.generation,d.consent_id,d.subscription_id,d.lease_expires_at due from private.urgent_inbox_deliveries d where d.state='sending' and d.lease_expires_at<=stamp order by d.lease_expires_at,d.task_id,d.generation,d.consent_id limit batch_size)
  )bounded order by due,task_id,generation,consent_id limit batch_size
 )q;
 return jsonb_build_object('v',1,'at',stamp,'jobs',jobs);
end $$;

create function private.claim_urgent_inbox_push(task public.ulid,generation bigint,consent public.ulid,subscription public.ulid,lease public.ulid,application_key text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare d private.urgent_inbox_deliveries;c private.urgent_inbox_consents;s private.desk_push_subscriptions;t public.tasks;g private.urgent_inbox_generations;current_task private.urgent_inbox_tasks;stamp public.utc_ms;
begin
 if task is null or generation is null or generation not between 1 and 9007199254740991 or consent is null or subscription is null or lease is null or application_key is null or application_key!~'^B[A-Za-z0-9_-]{86}$' then raise invalid_parameter_value;end if;
 select * into d from private.urgent_inbox_deliveries x where x.task_id=task and x.generation=claim_urgent_inbox_push.generation and x.consent_id=consent and x.subscription_id=subscription;if not found then return null;end if;
 perform 1 from public.businesses b where b.id=d.business_id for share;
 perform 1 from public.outlets o where o.business_id=d.business_id and o.id=d.outlet_id for share;
 select * into t from public.tasks x where x.id=task for share;
 select * into current_task from private.urgent_inbox_tasks x where x.task_id=task for share;
 select * into c from private.urgent_inbox_consents x where x.id=consent for share;
 select * into s from private.desk_push_subscriptions x where x.id=subscription for share;
 select * into g from private.urgent_inbox_generations x where x.task_id=task and x.generation=claim_urgent_inbox_push.generation for update;
 select * into d from private.urgent_inbox_deliveries x where x.task_id=task and x.generation=claim_urgent_inbox_push.generation and x.consent_id=consent for update;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or d.subscription_id<>subscription or d.state not in('pending','sending') or d.state='pending' and d.next_at>stamp or d.state='sending' and d.lease_expires_at>stamp then return null;end if;
 if t.id is null or not private.urgent_inbox_eligible(t) or not coalesce(current_task.active,false) or current_task.generation<>generation or g.state<>'pending'
  or c.id is null or c.revoked_at is not null or c.subscription_id<>subscription or c.active_subscription_id is distinct from subscription or c.business_id<>d.business_id or c.outlet_id<>d.outlet_id
  or s.id is null or s.application_key<>claim_urgent_inbox_push.application_key or s.auth_user_id<>c.auth_user_id or s.member_id<>c.member_id or not private.desk_push_allowed(s)
  or not exists(select 1 from public.members m where m.id=c.member_id and m.business_id=c.business_id and m.role=c.role) then
  update private.urgent_inbox_deliveries x set state='cancelled',finished_at=stamp where x.task_id=task and x.generation=claim_urgent_inbox_push.generation and x.consent_id=consent;return null;
 end if;
 if d.attempts>=8 then update private.urgent_inbox_deliveries x set state='failed',finished_at=stamp where x.task_id=task and x.generation=claim_urgent_inbox_push.generation and x.consent_id=consent;return null;end if;
 update private.urgent_inbox_deliveries x set state='sending',attempts=x.attempts+1,lease_id=lease,lease_expires_at=stamp+10000,last_outcome=null where x.task_id=task and x.generation=claim_urgent_inbox_push.generation and x.consent_id=consent;
 return jsonb_build_object('v',1,'leaseId',lease,'subscription',jsonb_build_object('endpoint',s.endpoint,'expirationTime',s.expires_at,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth_secret)),
  'notice',jsonb_build_object('v',1,'type','urgent-inbox','consentId',consent,'subscriptionId',subscription,'businessId',d.business_id,'outletId',d.outlet_id,'taskId',task,'generation',generation));
end $$;

create function private.finish_urgent_inbox_push(task public.ulid,generation bigint,consent public.ulid,subscription public.ulid,lease public.ulid,outcome text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare d private.urgent_inbox_deliveries;c private.urgent_inbox_consents;s private.desk_push_subscriptions;t public.tasks;g private.urgent_inbox_generations;current_task private.urgent_inbox_tasks;stamp public.utc_ms;next_state text;retry_at public.utc_ms;
begin
 if task is null or generation is null or generation not between 1 and 9007199254740991 or consent is null or subscription is null or lease is null or outcome is null or outcome not in('sent','expired','retry') then raise invalid_parameter_value;end if;
 select * into d from private.urgent_inbox_deliveries x where x.task_id=task and x.generation=finish_urgent_inbox_push.generation and x.consent_id=consent and x.subscription_id=subscription;if not found then return jsonb_build_object('state','stale');end if;
 perform 1 from public.businesses b where b.id=d.business_id for share;
 perform 1 from public.outlets o where o.business_id=d.business_id and o.id=d.outlet_id for share;
 select * into t from public.tasks x where x.id=task for share;
 select * into current_task from private.urgent_inbox_tasks x where x.task_id=task for share;
 select * into c from private.urgent_inbox_consents x where x.id=consent for share;
 select * into s from private.desk_push_subscriptions x where x.id=subscription for update;
 select * into g from private.urgent_inbox_generations x where x.task_id=task and x.generation=finish_urgent_inbox_push.generation for update;
 select * into d from private.urgent_inbox_deliveries x where x.task_id=task and x.generation=finish_urgent_inbox_push.generation and x.consent_id=consent for update;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if d.lease_id is distinct from lease then return jsonb_build_object('state','stale');end if;
 if d.state in('sent','expired','failed','cancelled') and d.last_outcome=outcome then return jsonb_build_object('state',d.state);end if;
 if d.state<>'sending' then return jsonb_build_object('state','stale');end if;
 if outcome in('sent','expired') then
  next_state:=outcome;
  if outcome='expired' then update private.desk_push_subscriptions x set revoked_at=greatest(stamp,x.created_at) where x.id=subscription and x.revoked_at is null;end if;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  values(lease,d.business_id,d.outlet_id,'system','urgent-inbox-push','inbox.push.'||outcome,
   json_build_object('taskId',task,'generation',generation,'consentId',consent,'state','sending'),
   json_build_object('taskId',task,'generation',generation,'consentId',consent,'subscriptionId',subscription,'state',outcome),stamp);
 elsif t.id is null or not private.urgent_inbox_eligible(t) or not coalesce(current_task.active,false) or current_task.generation<>generation or g.state<>'pending' or c.id is null or c.revoked_at is not null or c.active_subscription_id is distinct from subscription or s.id is null or not private.desk_push_allowed(s) then next_state:='cancelled';
 elsif d.attempts>=8 then next_state:='failed';
 else next_state:='pending';retry_at:=stamp+least(30000::bigint,1000::bigint<<least(greatest(d.attempts-1,0),5));end if;
 update private.urgent_inbox_deliveries x set state=next_state,next_at=coalesce(retry_at,x.next_at),lease_expires_at=null,last_outcome=outcome,finished_at=case when next_state='pending' then null else stamp end where x.task_id=task and x.generation=finish_urgent_inbox_push.generation and x.consent_id=consent;
 if g.state='pending' and not exists(select 1 from private.urgent_inbox_deliveries x where x.task_id=task and x.generation=finish_urgent_inbox_push.generation and x.state in('pending','sending')) then update private.urgent_inbox_generations x set state='complete' where x.task_id=task and x.generation=finish_urgent_inbox_push.generation;end if;
 return jsonb_build_object('state',next_state);
end $$;
revoke all on function private.prepare_urgent_inbox_push(text,integer),private.claim_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text),private.finish_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function private.prepare_urgent_inbox_push(text,integer),private.claim_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text),private.finish_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text) to service_role;
create function public.prepare_urgent_inbox_push(p_application_key text,p_limit integer default 25) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_urgent_inbox_push(p_application_key,p_limit)$$;
create function public.claim_urgent_inbox_push(p_task_id public.ulid,p_generation bigint,p_consent_id public.ulid,p_subscription_id public.ulid,p_lease_id public.ulid,p_application_key text) returns jsonb language sql security invoker set search_path='' as $$select private.claim_urgent_inbox_push(p_task_id,p_generation,p_consent_id,p_subscription_id,p_lease_id,p_application_key)$$;
create function public.finish_urgent_inbox_push(p_task_id public.ulid,p_generation bigint,p_consent_id public.ulid,p_subscription_id public.ulid,p_lease_id public.ulid,p_outcome text) returns jsonb language sql security invoker set search_path='' as $$select private.finish_urgent_inbox_push(p_task_id,p_generation,p_consent_id,p_subscription_id,p_lease_id,p_outcome)$$;
revoke all on function public.prepare_urgent_inbox_push(text,integer),public.claim_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text),public.finish_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_urgent_inbox_push(text,integer),public.claim_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text),public.finish_urgent_inbox_push(public.ulid,bigint,public.ulid,public.ulid,public.ulid,text) to service_role;

-- A notification is a hint, not authority. The original confirmed phone account,
-- active consent and current outlet assignment precede every private target read.
create function private.read_urgent_inbox_target(consent public.ulid,subscription public.ulid,task public.ulid,generation bigint) returns json
language plpgsql security definer set search_path='' as $$
declare account uuid;c private.urgent_inbox_consents;s private.desk_push_subscriptions;t public.tasks;current_task private.urgent_inbox_tasks;scope jsonb;notice json;
begin
 account:=private.owner_task_account();
 if consent is null or subscription is null or task is null or generation is null or generation not between 1 and 9007199254740991 then raise invalid_parameter_value;end if;
 select * into c from private.urgent_inbox_consents x where x.id=consent and x.auth_user_id=account and x.subscription_id=subscription and x.active_subscription_id=subscription and x.revoked_at is null;
 if not found then raise insufficient_privilege using message='Open this alert with its original phone account and current consent.';end if;
 scope:=private.owner_task_access(c.outlet_id);
 select * into s from private.desk_push_subscriptions x where x.id=subscription;
 if s.id is null or not private.desk_push_allowed(s) or s.auth_user_id<>account or s.member_id<>c.member_id or scope->>'memberId'<>c.member_id::text or scope->>'role'<>c.role then raise insufficient_privilege using message='Open the original assigned desk to review this alert.';end if;
 if not exists(select 1 from private.urgent_inbox_deliveries d where d.task_id=task and d.generation=read_urgent_inbox_target.generation and d.consent_id=consent and d.subscription_id=subscription and d.attempts>0 and d.business_id=c.business_id and d.outlet_id=c.outlet_id) then raise insufficient_privilege using message='This original alert is unavailable.';end if;
 select * into t from public.tasks x where x.id=task and x.business_id=c.business_id and x.outlet_id=c.outlet_id;
 select * into current_task from private.urgent_inbox_tasks x where x.task_id=task;
 if t.id is null or current_task.task_id is null or current_task.generation<generation then raise insufficient_privilege using message='This original task is unavailable.';end if;
 notice:=json_build_object('v',1,'type','urgent-inbox','consentId',consent,'subscriptionId',subscription,'businessId',c.business_id,'outletId',c.outlet_id,'taskId',task,'generation',generation);
 return json_build_object('v',1,'at',floor(extract(epoch from clock_timestamp())*1000)::bigint,'scope',scope,'notice',notice,'currentGeneration',current_task.generation,
  'active',current_task.active and current_task.generation=generation and private.urgent_inbox_eligible(t),'task',private.owner_task_projection(t));
end $$;
revoke all on function private.read_urgent_inbox_target(public.ulid,public.ulid,public.ulid,bigint) from public,anon,authenticated,service_role;
grant execute on function private.read_urgent_inbox_target(public.ulid,public.ulid,public.ulid,bigint) to authenticated;
create function public.read_urgent_inbox_target(p_consent_id public.ulid,p_subscription_id public.ulid,p_task_id public.ulid,p_generation bigint) returns json language sql security invoker set search_path='' as $$select private.read_urgent_inbox_target(p_consent_id,p_subscription_id,p_task_id,p_generation)$$;
revoke all on function public.read_urgent_inbox_target(public.ulid,public.ulid,public.ulid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.read_urgent_inbox_target(public.ulid,public.ulid,public.ulid,bigint) to authenticated;

-- Current metadata is not proof of the original registration event. This exact
-- personal receipt remains inspectable after a later withdrawal or role loss;
-- inspecting it never creates/re-enables a consent or reads a fresh task.
create function private.inspect_urgent_inbox(id public.ulid,subscription public.ulid,event public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare account uuid;c private.urgent_inbox_consents;
begin
 account:=private.owner_task_account();if id is null or subscription is null or event is null or id in(subscription,event) or subscription=event then raise invalid_parameter_value;end if;
 select * into c from private.urgent_inbox_consents x where x.id=inspect_urgent_inbox.id and x.auth_user_id=account;
 if not found then return null;end if;
 if c.subscription_id<>subscription or c.created_event_id<>event then raise sqlstate 'PT409' using message='Keep the exact original consent and event.';end if;
 return jsonb_build_object('v',1,'id',id,'eventId',event,'at',c.created_at,'consent',jsonb_set(private.urgent_inbox_metadata(c),'{revokedAt}','null'::jsonb));
end $$;
revoke all on function private.inspect_urgent_inbox(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.inspect_urgent_inbox(public.ulid,public.ulid,public.ulid) to authenticated;
create function public.inspect_urgent_inbox(p_id public.ulid,p_subscription_id public.ulid,p_event_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.inspect_urgent_inbox(p_id,p_subscription_id,p_event_id)$$;
revoke all on function public.inspect_urgent_inbox(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.inspect_urgent_inbox(public.ulid,public.ulid,public.ulid) to authenticated;
