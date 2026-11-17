-- Staff read a projection using both device and short-session secrets. No table
-- grants, caller-selected tenant, or JWT metadata participates in authorization.
create function private.read_device_orders(device_secret text,session_secret text,after_time public.utc_ms,after_id public.ulid,page_size integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; entries jsonb; cursor jsonb; has_more boolean; business public.ulid; outlet public.ulid; mode text;
begin
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not (actor->'permissions' ? 'orders.read') then return null;end if;
  if page_size is null or page_size not between 1 and 100 or (after_time is null)<>(after_id is null) then
    raise invalid_parameter_value using message='Use a complete order cursor and 1 to 100 orders.';
  end if;
  business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;mode:=actor->>'mode';
  with candidates as materialized (
    select o.* from public.orders o where o.business_id=business and o.outlet_id=outlet
      and (after_time is null or (o.created_at,o.id)>(after_time,after_id))
      order by o.created_at,o.id limit page_size+1
  ), page as (
    select * from candidates order by created_at,id limit page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',o.id,'number',o.number,'businessType',o.business_type,'type',o.type,'source',o.source,
    'status',o.status,'statusChangedAt',o.status_changed_at,'scheduledFor',o.scheduled_for,
    'createdAt',o.created_at,'updatedAt',o.updated_at,'revision',o.revision,'timezone',o.timezone,
    'tableJson',o.table_label::text,'linesJson',o.lines::text)
    ||case when mode='counter' then jsonb_build_object('customerNameJson',o.customer_name::text,
      'currency',o.currency,'subtotal',o.subtotal,'deliveryFee',o.delivery_fee,'discount',o.discount,'total',o.total,
      'paymentStatusJson',(o.payment->'status')::text,'paymentMethodJson',(o.payment->'method')::text)
      else '{}'::jsonb end order by o.created_at,o.id),'[]'::jsonb),
    (select jsonb_build_object('createdAt',p.created_at,'id',p.id) from page p order by p.created_at desc,p.id desc limit 1),
    (select count(*)>page_size from candidates)
    into entries,cursor,has_more from page o;
  return jsonb_build_object('v',1,'businessId',business,'outletId',outlet,'mode',mode,'permissions',actor->'permissions',
    'outletNameJson',s.name::text,'currency',s.currency,'timezone',s.timezone,'orderWarningMinutes',s.order_warning_minutes,
    'orders',entries,'next',case when has_more then cursor else null end)
    from public.outlets s where s.business_id=business and s.id=outlet;
end $$;
revoke all on function private.read_device_orders(text,text,public.utc_ms,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_device_orders(text,text,public.utc_ms,public.ulid,integer) to service_role;

-- VOLATILE intentionally makes PostgREST refuse GET: credentials belong in the
-- POST body, never query URLs. The private read uses one statement snapshot.
create function public.read_device_orders(p_device_token text,p_session_token text,p_after_time public.utc_ms default null,
  p_after_id public.ulid default null,p_limit integer default 50) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
begin
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]',true);
  return private.read_device_orders(p_device_token,p_session_token,p_after_time,p_after_id,p_limit);
end $$;
revoke all on function public.read_device_orders(text,text,public.utc_ms,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_device_orders(text,text,public.utc_ms,public.ulid,integer) to service_role;

-- This is a bounded history listing, not the M31 change cursor/sync protocol.
-- Original line JSON travels only to the server, which applies a strict field
-- allowlist for each mode. PostgreSQL JSON field extraction cannot retain NUL
-- and lone surrogate code units; never expose these raw lines to a client.
create index orders_device_page_idx on public.orders(business_id,outlet_id,created_at,id);
