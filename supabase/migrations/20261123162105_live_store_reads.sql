-- Read-only owner/assigned-manager projections. No provider, credential or job.
create function private.live_store_start(at_ms bigint,zone text,period text) returns bigint
language sql stable security invoker set search_path='' as $$
 select floor(extract(epoch from (date_trunc(case period when 'today' then 'day' when 'week' then 'week' else 'month' end,to_timestamp(at_ms/1000.0) at time zone zone) at time zone zone))*1000)::bigint
$$;
revoke all on function private.live_store_start(bigint,text,text) from public,anon,authenticated,service_role;

create function private.live_store_money(business public.ulid,outlet public.ulid,start_ms bigint,at_ms bigint) returns json
language sql stable security invoker set search_path='' as $$
 with receipts as materialized(select s.* from public.sales s where s.business_id=business and s.outlet_id=outlet and s.created_at between start_ms and at_ms),
 collections as materialized(select e.* from public.credit_entries e join public.credit_accounts a on a.business_id=e.business_id and a.outlet_id=e.outlet_id and a.id=e.account_id and a.customer_id=e.customer_id and a.currency=e.currency
  where e.business_id=business and e.outlet_id=outlet and e.created_at between start_ms and at_ms and e.reversal_of is null
   and not exists(select 1 from public.credit_entries r where r.business_id=e.business_id and r.outlet_id=e.outlet_id and r.account_id=e.account_id and r.reversal_of=e.id)),
 refunds as materialized(select r.* from public.order_refunds r where r.business_id=business and r.outlet_id=outlet and r.created_at between start_ms and at_ms and r.voided_at is null),
 currencies as(select currency from public.outlets where business_id=business and id=outlet union select currency from receipts union select currency from collections union select currency from refunds),
 amounts as(select c.currency,
  coalesce((select sum(s.amount) from receipts s where s.currency=c.currency and s.voided_at is null),0) sales,
  (select count(*) from receipts s where s.currency=c.currency and s.voided_at is null) sale_count,
  coalesce((select sum(s.amount) from receipts s where s.currency=c.currency and s.method='cash' and (s.voided_at is null or s.void_reason='order-cancel')),0)
   +coalesce((select sum(e.amount) from collections e where e.currency=c.currency and e.type='payment' and e.method_name::text='"Cash"'),0)
   -coalesce((select sum(r.amount) from refunds r where r.currency=c.currency and r.method='cash'),0) cash_net,
  coalesce((select sum(s.amount) from receipts s where s.currency=c.currency and s.method='wallet' and s.voided_at is null),0) wallet_sales,
  coalesce((select sum(s.amount) from receipts s where s.currency=c.currency and s.method='card' and s.voided_at is null),0) card_sales,
  coalesce((select sum(s.amount) from receipts s where s.currency=c.currency and s.method='credit' and s.voided_at is null),0) credit_sales,
  coalesce((select sum(case when e.type='payment' then e.amount when e.type='refund' then -e.amount else 0 end) from collections e where e.currency=c.currency),0) credit_collected,
  coalesce((select sum(r.amount) from refunds r where r.currency=c.currency),0) refunds,
  coalesce((select sum(s.discount) from receipts s where s.currency=c.currency and s.voided_at is null),0) discounts
 from currencies c)
 select coalesce(json_agg(json_build_object('currency',currency,'sales',sales,'saleCount',sale_count,'cashNet',cash_net,'walletSales',wallet_sales,'cardSales',card_sales,'creditSales',credit_sales,'creditCollected',credit_collected,'refunds',refunds,'discounts',discounts) order by currency),'[]'::json) from amounts
$$;
revoke all on function private.live_store_money(public.ulid,public.ulid,bigint,bigint) from public,anon,authenticated,service_role;

create function private.live_store_people(business public.ulid,outlet public.ulid,at_ms bigint) returns json
language sql stable security invoker set search_path='' as $$
 with people as(select m.id,m.name,m.role,p.profile->>'station' station,p.profile->'shift' shift,
  (select json_build_object('id',c.id,'at',c.at,'type',c.type,'method',c.method) from public.check_ins c where c.business_id=business and c.outlet_id=outlet and c.member_id=m.id and c.at<=at_ms order by c.at desc,c.id desc limit 1) latest
 from public.members m left join private.staff_profiles p on p.business_id=m.business_id and p.outlet_id=outlet and p.member_id=m.id
 where m.business_id=business and m.active and m.role<>'agent' and (exists(select 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=m.id)
  or m.role='owner' and (p.member_id is not null or exists(select 1 from public.check_ins c where c.business_id=business and c.outlet_id=outlet and c.member_id=m.id and c.at<=at_ms)))),
 page as(select * from people order by id limit 50)
 select json_build_object('total',(select count(*) from people),'in',(select count(*) from people where latest->>'type'='in'),'break',(select count(*) from people where latest->>'type'='break'),
  'entries',coalesce((select json_agg(json_build_object('id',id,'nameJson',name::text,'role',role,'station',coalesce(station,''),'shift',coalesce(shift,'null'::jsonb),'latest',latest) order by id) from page),'[]'::json))
$$;
revoke all on function private.live_store_people(public.ulid,public.ulid,bigint) from public,anon,authenticated,service_role;

create function private.live_store_summary(business public.ulid,outlet public.ulid,period text,at_ms bigint) returns json
language plpgsql stable security invoker set search_path='' as $$
declare o public.outlets;b public.businesses;start_ms bigint;people json;orders json;hourly json;
begin
 select * into o from public.outlets where business_id=business and id=outlet;select * into b from public.businesses where id=business;
 start_ms:=private.live_store_start(at_ms,o.timezone,period);people:=private.live_store_people(business,outlet,at_ms);
 select json_build_object('count',count(*) filter(where x.created_at>=start_ms and x.status<>'cancelled'),
  'waiting',count(*) filter(where x.status not in('delivered','returned','collected','done','cancelled') and (x.scheduled_for is null or x.scheduled_for<=at_ms)),
  'completed',count(*) filter(where x.status in('delivered','collected','done') and x.status_changed_at between start_ms and at_ms and x.status_changed_at>=x.created_at),
  'durationTotal',coalesce(sum(x.status_changed_at-x.created_at) filter(where x.status in('delivered','collected','done') and x.status_changed_at between start_ms and at_ms and x.status_changed_at>=x.created_at),0))
 into orders from public.orders x where x.business_id=business and x.outlet_id=outlet and x.created_at<=at_ms;
 select coalesce(json_agg(json_build_object('at',stamp,'currency',currency,'amount',amount) order by stamp,currency),'[]'::json) into hourly from
  (select (floor(s.created_at/3600000.0)*3600000)::bigint stamp,s.currency,sum(s.amount) amount from public.sales s
   where s.business_id=business and s.outlet_id=outlet and s.created_at between greatest(start_ms,at_ms-86400000) and at_ms and s.voided_at is null group by stamp,s.currency) h;
 return json_build_object('id',o.id,'businessId',business,'nameJson',o.name::text,'businessNameJson',b.name::text,'businessType',b.business_type,'marketCode',b.market_code,'currency',o.currency,'timeZone',o.timezone,
  'startAt',start_ms,'money',private.live_store_money(business,outlet,start_ms,at_ms),'orders',orders,'people',json_build_object('total',people->'total','in',people->'in','break',people->'break'),
  'lowStock',(select count(*) from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.archived_at is null and s.target>0 and s.on_hand<=s.low_at),
  'attention',(select count(*) from public.tasks t where t.business_id=business and t.outlet_id=outlet and t.status in('open','waiting') and t.created_at<=at_ms),
  'hourly',hourly);
end $$;
revoke all on function private.live_store_summary(public.ulid,public.ulid,text,bigint) from public,anon,authenticated,service_role;

create function private.live_store_detail(business public.ulid,outlet public.ulid,at_ms bigint) returns json
language plpgsql stable security invoker set search_path='' as $$
declare result json;active_orders json;tasks json;stock json;activity json;tables json;
begin
 select coalesce(json_agg(projection order by business_type,status,created_at,id),'[]'::json) into active_orders from
  (select x.id,x.business_type,x.status,x.created_at,json_build_object('id',x.id,'number',x.number,'businessType',x.business_type,'status',x.status,'source',x.source,'type',x.type,'createdAt',x.created_at,'statusChangedAt',x.status_changed_at,
    'tableJson',x.table_label::text,'scheduledFor',x.scheduled_for,'alarm',exists(select 1 from private.kitchen_alarm_tasks k join public.tasks t on t.business_id=k.business_id and t.outlet_id=k.outlet_id and t.id=k.task_id where k.business_id=business and k.outlet_id=outlet and k.order_id=x.id and t.status='open'),
    'lateAt',(select e.first_end from private.order_estimates e where e.business_id=business and e.outlet_id=outlet and e.order_id=x.id)) projection,
   row_number() over(partition by x.business_type,x.status order by x.created_at,x.id) ordinal from public.orders x where x.business_id=business and x.outlet_id=outlet and x.created_at<=at_ms
   and x.status not in('delivered','returned','collected','done','cancelled') and (x.scheduled_for is null or x.scheduled_for<=at_ms)) q where ordinal<=3;
 select coalesce(json_agg(json_build_object('businessType',business_type,'status',status,'count',n) order by business_type,status),'[]'::json) into result from
  (select x.business_type,x.status,count(*) n from public.orders x where x.business_id=business and x.outlet_id=outlet and x.created_at<=at_ms
   and x.status not in('delivered','returned','collected','done','cancelled') and (x.scheduled_for is null or x.scheduled_for<=at_ms) group by x.business_type,x.status) q;
 select coalesce(json_agg(json_build_object('id',id,'kind',kind,'titleJson',title::text,'bodyJson',body::text,'dueAt',due_at,'createdAt',created_at) order by due_at nulls last,id),'[]'::json) into tasks
  from(select t.* from public.tasks t where t.business_id=business and t.outlet_id=outlet and t.status in('open','waiting') and t.created_at<=at_ms order by t.due_at nulls last,t.id limit 50) q;
 select coalesce(json_agg(json_build_object('id',id,'nameJson',name::text,'unitJson',unit::text,'onHand',on_hand,'target',target,'lowAt',low_at) order by id),'[]'::json) into stock
  from(select s.* from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.archived_at is null and s.target>0 and s.on_hand<=s.low_at order by s.id limit 50) q;
 select coalesce(json_agg(json_build_object('id',e.id,'at',e.at,'actorType',e.actor_type,'actorNameJson',m.name::text,'command',e.command,'orderId',e.order_id) order by e.at desc,e.id desc),'[]'::json) into activity
  from(select a.* from public.events a where a.business_id=business and a.outlet_id=outlet and a.at between greatest(0,at_ms-3600000) and at_ms order by a.at desc,a.id desc limit 50) e
  left join public.members m on m.business_id=e.business_id and m.id::text=e.actor_id and e.actor_type='member';
 -- Table labels are literal display data. Never invent a floor plan or seats.
 select coalesce(json_agg(json_build_object('labelJson',label,'active',n,'since',since) order by label),'[]'::json) into tables from
  (select label,count(x.id) n,min(x.created_at) since from
   (select distinct to_json(s.table_label)::text label from private.public_shops s where s.business_id=business and s.outlet_id=outlet and s.table_label is not null and s.revoked_at is null and s.expires_at>at_ms
    union select distinct x.table_label::text from public.orders x where x.business_id=business and x.outlet_id=outlet and x.type='dine_in' and x.status not in('delivered','returned','collected','done','cancelled') and x.created_at<=at_ms and (x.scheduled_for is null or x.scheduled_for<=at_ms)) labels
   left join public.orders x on x.business_id=business and x.outlet_id=outlet and x.type='dine_in' and x.table_label::text=labels.label and x.status not in('delivered','returned','collected','done','cancelled') and x.created_at<=at_ms and (x.scheduled_for is null or x.scheduled_for<=at_ms)
   group by label order by label limit 50) q;
 return json_build_object('laneCounts',result,'orders',active_orders,'tasks',tasks,'people',private.live_store_people(business,outlet,at_ms),'stock',stock,'activity',activity,'tables',tables,
  'orderingLinks',(select count(*) from private.public_shops s where s.business_id=business and s.outlet_id=outlet and s.revoked_at is null and s.expires_at>at_ms));
end $$;
revoke all on function private.live_store_detail(public.ulid,public.ulid,bigint) from public,anon,authenticated,service_role;

create function private.read_live_store(anchor public.ulid,all_outlets boolean,period text,after_outlet public.ulid,view_outlet public.ulid) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;role_name text;at_ms bigint;next_id public.ulid;result json;cards json;totals json;detail_value json;outlet_count bigint;target public.ulid;target_actor public.ulid;target_business public.ulid;target_role text;
begin
 if anchor is null or all_outlets is null or period is null or period not in('today','week','month') or not all_outlets and after_outlet is not null or all_outlets and view_outlet is not null and view_outlet<>anchor then raise invalid_parameter_value using message='Choose the current live view.';end if;
 actor:=private.public_shop_actor(anchor);select business_id,role into business,role_name from public.members where id=actor;
 if all_outlets and role_name<>'owner' then raise insufficient_privilege using message='Only the owner can open All outlets.';end if;
 target:=coalesce(view_outlet,anchor);target_actor:=private.public_shop_actor(target);select business_id,role into target_business,target_role from public.members where id=target_actor;
 -- All outlets follows the verified phone identity's real owner memberships,
 -- including separate businesses. A manager membership is never widened.
 if all_outlets then perform 1 from public.members m where m.auth_user_id=(select auth.uid()) and m.active and m.role='owner' order by m.business_id,m.id for share;end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 with summaries as materialized(select o.id,o.business_id,private.live_store_summary(o.business_id,o.id,period,at_ms) value from public.outlets o where
  all_outlets and exists(select 1 from public.members m where m.business_id=o.business_id and m.auth_user_id=(select auth.uid()) and m.active and m.role='owner') or not all_outlets and o.id=target),
 page as materialized(select s.id from summaries s where after_outlet is null or s.id>after_outlet order by s.id limit 51),
 visible as(select p.id from page p order by p.id limit 50),
 money as(select m from summaries s cross join lateral json_array_elements(s.value->'money') m),
 grouped as(select m->>'currency' currency,sum((m->>'sales')::numeric) sales,sum((m->>'saleCount')::numeric) sales_count from money group by m->>'currency')
 select (select count(*) from summaries),(select coalesce(json_agg(s.value order by s.id),'[]'::json) from summaries s where s.id in(select id from visible)),
  json_build_object('money',coalesce((select json_agg(json_build_object('currency',currency,'sales',sales,'saleCount',sales_count) order by currency) from grouped),'[]'::json),
   'orders',(select coalesce(sum((value->'orders'->>'count')::numeric),0) from summaries),'waiting',(select coalesce(sum((value->'orders'->>'waiting')::numeric),0) from summaries),
   'people',(select count(distinct c.member_id) from public.check_ins c join public.members m on m.business_id=c.business_id and m.id=c.member_id where exists(select 1 from summaries s where s.business_id=c.business_id and s.id=c.outlet_id) and c.at<=at_ms and c.type='in' and m.active and m.role<>'agent'
    and (m.role='owner' or exists(select 1 from public.member_outlets a where a.business_id=c.business_id and a.outlet_id=c.outlet_id and a.member_id=m.id))
    and not exists(select 1 from public.check_ins n where n.business_id=c.business_id and n.outlet_id=c.outlet_id and n.member_id=c.member_id and n.at<=at_ms and (n.at>c.at or n.at=c.at and n.id>c.id))),
   'attention',(select coalesce(sum((value->>'attention')::numeric),0) from summaries)),
  (select case when count(*)>50 then (select max(id) from visible) else null end from page),
  case when all_outlets then null else private.live_store_detail(target_business,target,at_ms) end
 into outlet_count,cards,totals,next_id,detail_value;
 result:=json_build_object('v',1,'businessId',business,'anchorId',anchor,'actorId',actor,'actorRole',role_name,'viewOutletId',target,'viewActorId',target_actor,'viewActorRole',target_role,'allOutlets',all_outlets,'period',period,'serverAt',at_ms,
  'outletCount',outlet_count,'totals',totals,'outlets',cards,'next',next_id,'detail',detail_value);
 -- The existing actor lookup holds the actual Auth/member/assignment locks;
 -- repeat it so a changed live identity cannot authorize a stale projection.
 if private.public_shop_actor(anchor)<>actor or (select role from public.members where id=actor)<>role_name or private.public_shop_actor(target)<>target_actor or (select role from public.members where id=target_actor)<>target_role then raise insufficient_privilege using message='Refresh current outlet access.';end if;
 return result;
end $$;
revoke all on function private.read_live_store(public.ulid,boolean,text,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.read_live_store(public.ulid,boolean,text,public.ulid,public.ulid) to authenticated;
create function public.read_live_store(p_outlet_id public.ulid,p_all_outlets boolean default false,p_period text default 'today',p_after_outlet public.ulid default null,p_view_outlet_id public.ulid default null) returns json
language sql security invoker set search_path='' as $$ select private.read_live_store(p_outlet_id,p_all_outlets,p_period,p_after_outlet,p_view_outlet_id) $$;
revoke all on function public.read_live_store(public.ulid,boolean,text,public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.read_live_store(public.ulid,boolean,text,public.ulid,public.ulid) to authenticated;
