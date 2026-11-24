-- Stock reads use the actual outlet Team choice. No legacy stock grant is
-- inferred and no catalog, purchasing, money or quantity-write right is added.
create or replace function private.device_staff_permissions(d private.devices,m public.members) returns text[]
language plpgsql stable security invoker set search_path='' as $$
declare result text[]:='{}'; profile jsonb; permission text;
begin
 if not m.active or m.business_id<>d.business_id then return result;end if;
 select s.profile into profile from private.staff_profiles s
  where s.business_id=m.business_id and s.outlet_id=d.outlet_id and s.member_id=m.id;
 if m.role='staff' or m.role='kitchen' and d.mode='kitchen' then
  result:=private.device_permissions(d.mode,m.role,m.permissions);
  if profile is not null then
   result:=array_remove(array_remove(result,'orders.acknowledge'),'orders.ready');
   if profile#>'{permissions,confirmOrders}'='true'::jsonb then
    foreach permission in array array['orders.read','orders.acknowledge','orders.ready'] loop
     if not m.permissions ? permission or m.permissions->permission='true'::jsonb then result:=array_append(result,permission);end if;
    end loop;
   end if;
   if not result @> array['orders.read'] then result:=array_remove(array_remove(result,'orders.acknowledge'),'orders.ready');end if;
   if profile#>'{permissions,updateStock}'='true'::jsonb and
    (not m.permissions ? 'stock.read' or m.permissions->'stock.read'='true'::jsonb) then
    result:=array_append(result,'stock.read');
   end if;
  end if;
 end if;
 if m.role in('staff','kitchen','rider') and profile->'methods' ? 'order_phone' then result:=array_append(result,'staff.check-in');end if;
 return coalesce((select array_agg(distinct p order by p) from unnest(result) p),'{}');
end $$;
revoke all on function private.device_staff_permissions(private.devices,public.members) from public,anon,authenticated,service_role;

create table private.staff_stock_budget (
 device_id public.ulid primary key references private.devices(id),
 window_at public.utc_ms not null,request_count integer not null check(request_count>=0)
);
alter table private.staff_stock_budget enable row level security;
alter table private.staff_stock_budget force row level security;
revoke all on private.staff_stock_budget from public,anon,authenticated,service_role;

-- The installer-owned service is the only RPC caller. Neither the browser's
-- selected outlet/member nor JWT claims can select a different stock scope.
create function private.read_staff_stock_page(device_secret text,session_secret text,after_id public.ulid,page_limit integer,request_limit integer) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='2s' as $$
declare actor jsonb;business public.ulid;outlet public.ulid;device public.ulid;session_id public.ulid;member public.ulid;
 at_ms public.utc_ms;window_ms bigint;requests integer;rows jsonb;next_id public.ulid;outlet_name text;
begin
 if page_limit is null or page_limit not between 1 and 100 or request_limit is null or request_limit not between 1 and 60000 then
  raise invalid_parameter_value using message='Use a bounded stock page.';end if;
 actor:=private.read_device_session(device_secret,session_secret);
 if actor is null or not actor->'permissions' ? 'stock.read' then return jsonb_build_object('v',1,'state','missing');end if;
 business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;device:=(actor->>'deviceId')::public.ulid;
 session_id:=(actor->>'sessionId')::public.ulid;member:=(actor->>'memberId')::public.ulid;
 -- Team and stock mutations serialize at this same outlet. Lock identities too
 -- so permission/PIN/revocation changes cannot race the returned projection.
 perform 1 from public.businesses b where b.id=business for share;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for share;
 perform 1 from private.devices d where d.id=device for share;
 perform 1 from private.device_sessions s where s.id=session_id for share;
 perform 1 from public.members m where m.business_id=business and m.id=member for share;
 perform 1 from private.staff_pins p where p.business_id=business and p.member_id=member for share;
 perform 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=member for share;
 perform 1 from private.staff_profiles p where p.business_id=business and p.outlet_id=outlet and p.member_id=member for share;
 actor:=private.read_device_session(device_secret,session_secret);at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if actor is null or not actor->'permissions' ? 'stock.read' or (actor->>'expiresAt')::bigint<=at_ms or not exists(
  select 1 from private.devices d where d.id=device and d.revoked_at is null and d.expires_at>at_ms) then
  return jsonb_build_object('v',1,'state','missing');end if;
 window_ms:=at_ms-at_ms%60000;
 insert into private.staff_stock_budget as b values(device,window_ms,1) on conflict(device_id) do update
  set window_at=excluded.window_at,request_count=case when b.window_at=excluded.window_at then least(b.request_count+1,60001) else 1 end
  returning request_count into requests;
 if requests>request_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',greatest(1,ceil((window_ms+60000-at_ms)/1000.0)::integer));end if;
 select o.name::text into outlet_name from public.outlets o where o.business_id=business and o.id=outlet;
 with candidates as materialized(
  select s.* from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.archived_at is null
   and (after_id is null or s.id>after_id) order by s.id limit page_limit+1
 ),page as(select * from candidates order by id limit page_limit)
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'outletId',s.outlet_id,'revision',s.revision,
  'nameJson',s.name::text,'nameLocalJson',s.name_local::text,'unitJson',s.unit::text,'categoryJson',s.category::text,'aliasesJson',s.aliases::text,
  'onHand',s.on_hand,'target',s.target,'packSize',s.pack_size,'lowAt',s.low_at,'lastCountedAt',s.last_counted_at,
  'eventId',s.event_id,'createdAt',s.created_at,'updatedAt',s.updated_at) order by s.id),'[]'::jsonb),
  case when(select count(*) from candidates)>page_limit then(select p.id from page p order by p.id desc limit 1)end
 into rows,next_id from page s;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if (actor->>'expiresAt')::bigint<=at_ms or not exists(select 1 from private.devices d where d.id=device and d.expires_at>at_ms) then
  return jsonb_build_object('v',1,'state','missing');end if;
 return jsonb_build_object('v',1,'state','stock','access',actor,'outletNameJson',outlet_name,'serverAt',at_ms,'items',rows,'next',next_id);
end $$;
revoke all on function private.read_staff_stock_page(text,text,public.ulid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_staff_stock_page(text,text,public.ulid,integer,integer) to service_role;
create function public.read_staff_stock_page(p_device_token text,p_session_token text,p_after_id public.ulid,p_limit integer,p_request_limit integer) returns jsonb
language sql security invoker set search_path='' as $$select private.read_staff_stock_page(p_device_token,p_session_token,p_after_id,p_limit,p_request_limit)$$;
revoke all on function public.read_staff_stock_page(text,text,public.ulid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_staff_stock_page(text,text,public.ulid,integer,integer) to service_role;
