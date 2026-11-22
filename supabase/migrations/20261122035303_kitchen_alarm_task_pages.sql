-- Exhaustive, versioned and phone-authorized kitchen alarm task pages.
-- A capped first page is not evidence that another order has no open task.
create table private.inbox_task_versions (
 business_id public.ulid not null,outlet_id public.ulid primary key,
 version bigint not null check(version between 1 and 9007199254740991),
 foreign key(business_id,outlet_id) references public.outlets(business_id,id)
);
alter table private.inbox_task_versions enable row level security;
alter table private.inbox_task_versions force row level security;
revoke all on private.inbox_task_versions from public,anon,authenticated,service_role;
insert into private.inbox_task_versions select business_id,outlet_id,1 from(select business_id,outlet_id from public.tasks union select business_id,outlet_id from public.kitchen_alarm_settings) scopes;
create function private.note_inbox_task_version() returns trigger
language plpgsql security definer set search_path='' as $$
declare business public.ulid;outlet public.ulid;
begin
 if tg_op='DELETE' then business:=old.business_id;outlet:=old.outlet_id;
 else business:=new.business_id;outlet:=new.outlet_id;end if;
 insert into private.inbox_task_versions as v values(business,outlet,1)
 on conflict(outlet_id) do update set version=v.version+1;
 if tg_op='UPDATE' then
  if old.business_id<>new.business_id or old.outlet_id<>new.outlet_id then
   insert into private.inbox_task_versions as v values(old.business_id,old.outlet_id,1)
   on conflict(outlet_id) do update set version=v.version+1;
  end if;
 end if;
 return null;
end $$;
revoke all on function private.note_inbox_task_version() from public,anon,authenticated,service_role;
create trigger inbox_task_version after insert or update or delete on public.tasks for each row execute function private.note_inbox_task_version();
-- A threshold-only change invalidates a multi-page read as well.
create trigger kitchen_alarm_settings_task_version after insert or update or delete on public.kitchen_alarm_settings for each row execute function private.note_inbox_task_version();
create index kitchen_alarm_task_page_idx on public.tasks(business_id,outlet_id,due_at,id) where status='open';

create function private.read_kitchen_alarm_task_page(outlet public.ulid,after_due public.utc_ms,after_id public.ulid,expected_version bigint,page_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare business public.ulid;member public.ulid;member_role text;version bigint;result jsonb;cursor jsonb;more boolean;s public.kitchen_alarm_settings;
begin
 if not exists(select 1 from auth.users u where u.id=(select auth.uid()) and not u.is_anonymous) then raise insufficient_privilege using message='Sign in with your phone account.';end if;
 select a.business_id,a.member_id,a.role into business,member,member_role from private.current_access() a where a.role in('owner','manager') and outlet=any(a.outlet_ids);
 if not found then raise insufficient_privilege using message='Open an assigned outlet.';end if;
 if page_size is null or page_size not between 1 and 100 or(after_due is null)<>(after_id is null) or
  after_id is not null and expected_version is null or expected_version is not null and(expected_version<0 or expected_version>9007199254740991) then
  raise invalid_parameter_value using message='Use the original complete task page.';
 end if;
 select coalesce((select x.version from private.inbox_task_versions x where x.business_id=business and x.outlet_id=outlet),0) into version;
 if expected_version is not null and expected_version<>version then raise sqlstate 'PT409' using message='Tasks changed. Read the current Inbox again.';end if;
 select * into s from public.kitchen_alarm_settings x where x.business_id=business and x.outlet_id=outlet;
 with candidates as materialized(
  select t.*,b.order_id,b.content_hash,b.source_revision,b.generation,b.raised_at from public.tasks t join private.kitchen_alarm_tasks b on b.task_id=t.id
  where t.business_id=business and t.outlet_id=outlet and t.status='open' and(after_due is null or(t.due_at,t.id)>(after_due,after_id))
  order by t.due_at,t.id limit page_size+1
 ),page as(
  select * from candidates order by due_at,id limit page_size
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'orderId',x.order_id,'contentHash',x.content_hash,'sourceRevision',x.source_revision,
  'generation',x.generation,'titleJson',x.title::text,'bodyJson',x.body::text,'actionsJson',x.actions::text,'dueAt',x.due_at,'raisedAt',x.raised_at,'updatedAt',x.updated_at) order by x.due_at,x.id),'[]'::jsonb),
  (select jsonb_build_object('dueAt',p.due_at,'id',p.id) from page p order by p.due_at desc,p.id desc limit 1),
  (select count(*) from candidates)>(select count(*) from page) into result,cursor,more from page x;
 return jsonb_build_object('v',1,'access',jsonb_build_object('v',1,'businessId',business,'outletId',outlet,'memberId',member,'role',member_role),
  'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,'version',version,
  'settings',jsonb_build_object('enabled',coalesce(s.enabled,true),'minutes',coalesce(s.minutes,2),'revision',coalesce(s.revision,0)),
  'tasks',result,'next',case when more then cursor else null end);
end $$;
revoke all on function private.read_kitchen_alarm_task_page(public.ulid,public.utc_ms,public.ulid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_kitchen_alarm_task_page(public.ulid,public.utc_ms,public.ulid,bigint,integer) to authenticated;
create function public.read_kitchen_alarm_task_page(p_outlet_id public.ulid,p_after_due public.utc_ms default null,p_after_id public.ulid default null,p_version bigint default null,p_limit integer default 50) returns jsonb
language sql security invoker set search_path='' as $$select private.read_kitchen_alarm_task_page(p_outlet_id,p_after_due,p_after_id,p_version,p_limit)$$;
revoke all on function public.read_kitchen_alarm_task_page(public.ulid,public.utc_ms,public.ulid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_kitchen_alarm_task_page(public.ulid,public.utc_ms,public.ulid,bigint,integer) to authenticated;
