-- An approved link with no expiry remains active. Preserve the applied original.
create or replace function private.live_store_detail(business public.ulid,outlet public.ulid,at_ms bigint) returns json
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
   (select distinct to_json(s.table_label)::text label from private.public_shops s where s.business_id=business and s.outlet_id=outlet and s.table_label is not null and s.revoked_at is null and (s.expires_at is null or s.expires_at>at_ms)
    union select distinct x.table_label::text from public.orders x where x.business_id=business and x.outlet_id=outlet and x.type='dine_in' and x.status not in('delivered','returned','collected','done','cancelled') and x.created_at<=at_ms and (x.scheduled_for is null or x.scheduled_for<=at_ms)) labels
   left join public.orders x on x.business_id=business and x.outlet_id=outlet and x.type='dine_in' and x.table_label::text=labels.label and x.status not in('delivered','returned','collected','done','cancelled') and x.created_at<=at_ms and (x.scheduled_for is null or x.scheduled_for<=at_ms)
   group by label order by label limit 50) q;
 return json_build_object('laneCounts',result,'orders',active_orders,'tasks',tasks,'people',private.live_store_people(business,outlet,at_ms),'stock',stock,'activity',activity,'tables',tables,
  'orderingLinks',(select count(*) from private.public_shops s where s.business_id=business and s.outlet_id=outlet and s.revoked_at is null and (s.expires_at is null or s.expires_at>at_ms)));
end $$;
revoke all on function private.live_store_detail(public.ulid,public.ulid,bigint) from public,anon,authenticated,service_role;
