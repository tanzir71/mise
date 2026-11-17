-- Authorize PIN administration before the Edge Function performs its KDF.
-- Derive the business from the target records, never from caller JWT metadata.
create function private.staff_pin_context(outlet public.ulid,member public.ulid,action text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid; actor public.ulid; target public.members; configured boolean;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  if action is null or action not in ('set','clear') then raise invalid_parameter_value using message='Choose set or clear.';end if;
  select m.* into target from public.members m join public.outlets o on o.business_id=m.business_id where m.id=member and o.id=outlet;
  if not found then raise insufficient_privilege using message='This PIN cannot be changed.';end if;
  business:=target.business_id;
  actor:=private.public_link_actor(business,outlet);
  if not exists(select 1 from public.members m where m.id=actor and m.role='owner') then
    raise insufficient_privilege using message='This PIN cannot be changed.';
  end if;
  if action='set' and (not target.active or target.role not in ('staff','kitchen') or not exists(
    select 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=member)) then
    raise insufficient_privilege using message='This PIN cannot be changed.';
  end if;
  select exists(select 1 from private.staff_pins p where p.business_id=business and p.member_id=member) into configured;
  return jsonb_build_object('businessId',business,'outletId',outlet,'memberId',member,'configured',configured);
end $$;
revoke all on function private.staff_pin_context(public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function private.staff_pin_context(public.ulid,public.ulid,text) to authenticated;
create function public.staff_pin_context(p_outlet_id public.ulid,p_member_id public.ulid,p_action text) returns jsonb
language sql security invoker set search_path='' as $$select private.staff_pin_context(p_outlet_id,p_member_id,p_action)$$;
revoke all on function public.staff_pin_context(public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function public.staff_pin_context(public.ulid,public.ulid,text) to authenticated;
