-- Previously signed-in eligible members can recover their own offline originals.
-- Listing a name grants no preparation, attendance or current-order capability.
create or replace function private.read_device_signin(p_device_secret text,p_after_id public.ulid,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare device private.devices;outlet_name text;members jsonb;next_id public.ulid;at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
 if p_device_secret is null or p_device_secret!~'^[A-Za-z0-9_-]{43}$' then return null;end if;
 if p_limit is null or p_limit not between 1 and 100 then raise invalid_parameter_value using message='Use a bounded staff page.';end if;
 select * into device from private.devices d where d.token_hash=sha256(convert_to(p_device_secret,'UTF8')) and d.revoked_at is null and d.expires_at>at_ms;
 if not found then return null;end if;
 select o.name into outlet_name from public.outlets o where o.business_id=device.business_id and o.id=device.outlet_id;
 with eligible as(select m.id,m.name from public.members m join private.staff_pins pin on pin.business_id=m.business_id and pin.member_id=m.id where m.business_id=device.business_id and (p_after_id is null or m.id>p_after_id) and private.staff_device_allowed(device,pin) and (cardinality(private.device_staff_permissions(device,m))>0 or exists(
    select 1 from private.device_sessions prior where prior.business_id=device.business_id and prior.outlet_id=device.outlet_id
      and prior.device_id=device.id and prior.member_id=m.id)) order by m.id limit p_limit+1),
 page as(select * from eligible order by id limit p_limit)
 select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'nameJson',p.name::text) order by p.id) from page p),'[]'),case when (select count(*) from eligible)>p_limit then(select p.id from page p order by p.id desc limit 1)end into members,next_id;
 return jsonb_build_object('v',1,'device',private.device_metadata(device),'outletNameJson',outlet_name,'members',members,'next',next_id);
end $$;
