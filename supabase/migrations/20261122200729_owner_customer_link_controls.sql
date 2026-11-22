-- An authorized operator can manage this resource's grants across devices.
-- Listing exposes only metadata, never token hashes or one-time secrets.
create index public_links_resource_page_idx on private.public_links(business_id,outlet_id,kind,(coalesce(order_id,account_id)),id);
create function private.read_customer_link_page(link_kind text,resource_id public.ulid,after_id public.ulid,page_size integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare scope record; entries jsonb; more boolean; last_id public.ulid; actor_role text;
begin
  if page_size is null or page_size<1 or page_size>100 then
    raise invalid_parameter_value using message='Choose up to 100 customer links.';
  end if;
  select * into strict scope from private.public_link_scope(link_kind,resource_id);
  select m.role into strict actor_role from public.members m where m.id=scope.actor_id and m.business_id=scope.business_id;
  select coalesce(jsonb_agg(p.entry order by p.id),'[]'::jsonb),max(p.id::text)::public.ulid into entries,last_id from (
    select c.id,private.public_link_metadata(c)||jsonb_build_object('createEventId',c.created_event_id) entry
    from private.public_links c where c.business_id=scope.business_id and c.outlet_id=scope.outlet_id
      and c.kind=link_kind and coalesce(c.order_id,c.account_id)=resource_id and (after_id is null or c.id>after_id)
    order by c.id limit page_size
  ) p;
  select exists(select 1 from private.public_links c where c.business_id=scope.business_id and c.outlet_id=scope.outlet_id
    and c.kind=link_kind and coalesce(c.order_id,c.account_id)=resource_id and c.id>last_id) into more;
  return jsonb_build_object('businessId',scope.business_id,'outletId',scope.outlet_id,'actorId',scope.actor_id,'actorRole',actor_role,
    'kind',link_kind,'resourceId',resource_id,'entries',entries,'next',case when more then last_id end);
end $$;
revoke all on function private.read_customer_link_page(text,public.ulid,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_customer_link_page(text,public.ulid,public.ulid,integer) to authenticated;
create function public.read_customer_link_page(p_kind text,p_resource_id public.ulid,p_after_id public.ulid default null,p_page_size integer default 50)
returns jsonb language sql security invoker set search_path='' as $$
  select private.read_customer_link_page(p_kind,p_resource_id,p_after_id,p_page_size)
$$;
revoke all on function public.read_customer_link_page(text,public.ulid,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_customer_link_page(text,public.ulid,public.ulid,integer) to authenticated;
notify pgrst, 'reload schema';
