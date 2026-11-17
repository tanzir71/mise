-- Durable, actor-bound command receipts. Resource IDs survive later deletion.
create table private.command_receipts (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  actor_id public.ulid not null, auth_user_id uuid not null, type text not null
    check(type in ('catalogue.availability','catalogue.undo')),
  resource_id public.ulid not null, requested_available boolean, undo_of public.ulid,
  before_available boolean not null, after_available boolean not null,
  at public.utc_ms not null, item_updated_at public.utc_ms not null,
  sequence bigint generated always as identity unique check(sequence between 1 and 9007199254740991),
  unique(business_id,outlet_id,id), unique(business_id,outlet_id,undo_of),
  check((type='catalogue.availability' and requested_available is not null and undo_of is null)
    or (type='catalogue.undo' and requested_available is null and undo_of is not null)),
  foreign key(business_id,outlet_id) references public.outlets(business_id,id),
  foreign key(business_id,actor_id) references public.members(business_id,id),
  foreign key(business_id,outlet_id,undo_of) references private.command_receipts(business_id,outlet_id,id),
  foreign key(business_id,outlet_id,id) references public.events(business_id,outlet_id,id) deferrable initially deferred
);
alter table private.command_receipts enable row level security;
alter table private.command_receipts force row level security;
revoke all on private.command_receipts from public,anon,authenticated,service_role;
revoke all on sequence private.command_receipts_sequence_seq from public,anon,authenticated,service_role;
create index command_receipts_outlet_idx on private.command_receipts(business_id,outlet_id,sequence);
create index command_receipts_actor_idx on private.command_receipts(business_id,actor_id);
create index command_receipts_resource_idx on private.command_receipts(business_id,outlet_id,resource_id,sequence desc);

-- JSON construction preserves literal NUL/surrogates; do not extract them into
-- text or convert these snapshots to jsonb. Match the existing core Item shape.
create function private.catalogue_item_snapshot(i public.items) returns json
language sql immutable security invoker set search_path='' as $$
 select case when i.often_bought is null then json_build_object('id',i.id,'outletId',i.outlet_id,'name',i.name,
   'nameLocal',i.name_local,'categoryId',i.category_id,'price',i.price,'unit',i.unit,'available',i.available,
   'isSample',i.is_sample,'createdAt',i.created_at,'updatedAt',i.updated_at)
 else json_build_object('id',i.id,'outletId',i.outlet_id,'name',i.name,'nameLocal',i.name_local,'categoryId',i.category_id,
   'price',i.price,'unit',i.unit,'available',i.available,'isSample',i.is_sample,'oftenBought',i.often_bought,
   'createdAt',i.created_at,'updatedAt',i.updated_at) end
$$;
create function private.command_receipt_metadata(r private.command_receipts) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('id',r.id,'type',r.type,'itemId',r.resource_id,'outletId',r.outlet_id,
   'available',r.after_available,'at',r.at,'itemUpdatedAt',r.item_updated_at,'sequence',r.sequence,'undoOf',r.undo_of)
$$;
revoke all on function private.catalogue_item_snapshot(public.items),private.command_receipt_metadata(private.command_receipts)
  from public,anon,authenticated,service_role;

create function private.apply_catalogue_command(command_id public.ulid,command_type text,item_id public.ulid,available boolean,undo_id public.ulid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous private.command_receipts; original private.command_receipts; receipt private.command_receipts;
  saved public.items; before_data json; actor public.ulid; business public.ulid; outlet public.ulid; target public.ulid;
  desired boolean; at_ms public.utc_ms; latest public.ulid;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This command is not allowed.';end if;
  if command_id is null or command_type is null or command_type not in ('catalogue.availability','catalogue.undo')
    or (command_type='catalogue.availability' and (item_id is null or available is null or undo_id is not null))
    or (command_type='catalogue.undo' and (item_id is not null or available is not null or undo_id is null)) then
    raise invalid_parameter_value using message='Choose a supported catalogue command.';
  end if;
  -- Serialize duplicate IDs across outlets without reserving an incomplete receipt.
  perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
  select * into previous from private.command_receipts r where r.id=command_id;
  if found then
    actor:=private.public_link_actor(previous.business_id,previous.outlet_id);
    if previous.actor_id<>actor or previous.auth_user_id<>(select auth.uid()) then
      raise insufficient_privilege using message='This command is not allowed.';end if;
    if previous.type<>command_type or previous.requested_available is distinct from available or previous.undo_of is distinct from undo_id
      or (command_type='catalogue.availability' and previous.resource_id<>item_id) then
      raise unique_violation using message='This command ID was already used.';end if;
    return private.command_receipt_metadata(previous);
  end if;
  if command_type='catalogue.undo' then
    select * into original from private.command_receipts r where r.id=undo_id and r.type='catalogue.availability';
    if not found then raise insufficient_privilege using message='This command is not allowed.';end if;
    target:=original.resource_id;business:=original.business_id;outlet:=original.outlet_id;desired:=original.before_available;
  else
    select i.business_id,i.outlet_id into business,outlet from public.items i where i.id=item_id;
    if not found then raise insufficient_privilege using message='This command is not allowed.';end if;
    target:=item_id;desired:=available;
  end if;
  actor:=private.public_link_actor(business,outlet);
  -- All future command handlers for this outlet must use this same write lock.
  perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
  select * into saved from public.items i where i.business_id=business and i.outlet_id=outlet and i.id=target for update;
  if not found then raise insufficient_privilege using message='This command is not allowed.';end if;
  if command_type='catalogue.undo' then
    select r.id into latest from private.command_receipts r where r.business_id=business and r.outlet_id=outlet
      and r.resource_id=target order by r.sequence desc limit 1;
    if latest is distinct from undo_id or saved.available<>original.after_available then
      raise serialization_failure using message='A newer availability change must be kept.';end if;
  end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;before_data:=private.catalogue_item_snapshot(saved);
  insert into private.command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,resource_id,requested_available,
    undo_of,before_available,after_available,at,item_updated_at)
    values(command_id,business,outlet,actor,(select auth.uid()),command_type,target,available,undo_id,
      saved.available,desired,at_ms,greatest(at_ms,saved.created_at)) returning * into receipt;
  update public.items i set available=desired,updated_at=receipt.item_updated_at where i.id=target returning * into saved;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,undo_of)
    values(command_id,business,outlet,'member',actor,case when command_type='catalogue.undo' then 'catalogue.availability.undo' else command_type end,
      before_data,private.catalogue_item_snapshot(saved),at_ms,undo_id);
  return private.command_receipt_metadata(receipt);
end $$;
revoke all on function private.apply_catalogue_command(public.ulid,text,public.ulid,boolean,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.apply_catalogue_command(public.ulid,text,public.ulid,boolean,public.ulid) to authenticated;
create function public.apply_catalogue_command(p_id public.ulid,p_type text,p_item_id public.ulid default null,
  p_available boolean default null,p_undo_of public.ulid default null) returns jsonb
language sql security invoker set search_path='' as $$select private.apply_catalogue_command(p_id,p_type,p_item_id,p_available,p_undo_of)$$;
revoke all on function public.apply_catalogue_command(public.ulid,text,public.ulid,boolean,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.apply_catalogue_command(public.ulid,text,public.ulid,boolean,public.ulid) to authenticated;
