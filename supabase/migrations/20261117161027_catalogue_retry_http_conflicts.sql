-- Expected application conflicts must not trigger PostgREST transaction retries.
-- https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b

create or replace function private.finish_catalogue_write(ticket_id public.ulid,secret text,name_json text,local_json text,unit_json text,price public.minor_units,
  category_id public.ulid,new_category_json text,available boolean,often_bought boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.catalogue_write_tickets;saved public.items;previous private.command_receipts;r private.command_receipts;before_data json;before_row json;category public.categories;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;old_available boolean;
begin
  if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Prepare this write again.';end if;
  select * into t from private.catalogue_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) and x.expires_at>at_ms;
  if not found then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Prepare this write again.';end if;
  perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.catalogue_ticket_actor(t);
  perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
  select * into t from private.catalogue_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) and x.expires_at>floor(extract(epoch from clock_timestamp())*1000)::bigint for update;
  if not found then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Prepare this write again.';end if;
  select * into previous from private.command_receipts x where x.id=t.command_id;
  if found then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Read the accepted receipt again.';end if;
  select * into saved from public.items i where i.business_id=t.business_id and i.outlet_id=t.outlet_id and i.id=t.item_id for update;
  if private.catalogue_write_snapshot(t.business_id,t.outlet_id,t.item_id)<>t.snapshot_hash then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='The catalogue changed. Prepare again.';end if;
  if t.type='catalogue.create' then
    if saved.id is not null then raise unique_violation using message='This item ID already exists.';end if;
    before_data:='null';before_row:='null';old_available:=null;
  else
    if saved.id is null then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='The item changed. Prepare again.';end if;
    before_data:=private.catalogue_item_snapshot(saved);before_row:=row_to_json(saved);old_available:=saved.available;
  end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if t.type='catalogue.delete' then
    if name_json is not null or local_json is not null or unit_json is not null or price is not null or category_id is not null or new_category_json is not null or available is not null or often_bought is not null then raise invalid_parameter_value using message='Invalid deletion payload.';end if;
    delete from public.items i where i.id=t.item_id;
  else
    if name_json is null or local_json is null or unit_json is null or price is null or price<0 or category_id is null or available is null or often_bought is null then raise invalid_parameter_value using message='Invalid catalogue payload.';end if;
    if new_category_json is not null then
      insert into public.categories(id,business_id,outlet_id,name,sort,created_at,updated_at) values(category_id,t.business_id,t.outlet_id,new_category_json::public.literal_text,
        (select count(*) from public.categories c where c.business_id=t.business_id and c.outlet_id=t.outlet_id),at_ms,at_ms) returning * into category;
    elsif not exists(select 1 from public.categories c where c.business_id=t.business_id and c.outlet_id=t.outlet_id and c.id=category_id) then raise insufficient_privilege using message='This category is unavailable.';end if;
    if t.type='catalogue.create' then
      insert into public.items(id,business_id,outlet_id,name,name_local,price,unit,category_id,available,often_bought,is_sample,created_at,updated_at)
        values(t.item_id,t.business_id,t.outlet_id,name_json::public.literal_text,local_json::public.literal_text,price,unit_json::public.literal_text,category_id,available,often_bought,false,at_ms,at_ms) returning * into saved;
    else
      update public.items i set name=name_json::public.literal_text,name_local=local_json::public.literal_text,price=finish_catalogue_write.price,unit=unit_json::public.literal_text,
        category_id=finish_catalogue_write.category_id,available=finish_catalogue_write.available,often_bought=finish_catalogue_write.often_bought,is_sample=false,updated_at=greatest(at_ms,i.created_at) where i.id=t.item_id returning * into saved;
    end if;
  end if;
  insert into private.command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,resource_id,request_hash,before_available,after_available,at,item_updated_at,before_record,after_record)
    values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.item_id,t.request_hash,old_available,
      case when t.type='catalogue.delete' then null else saved.available end,at_ms,case when t.type='catalogue.delete' then at_ms else saved.updated_at end,before_row,
      case when t.type='catalogue.delete' then 'null'::json else row_to_json(saved) end) returning * into r;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,t.type,before_data,
      case when t.type='catalogue.delete' then 'null'::json else json_build_object('item',private.catalogue_item_snapshot(saved),'category',case when category.id is null then 'null'::json else json_build_object('id',category.id,'outletId',category.outlet_id,'name',category.name,'sort',category.sort,'createdAt',category.created_at,'updatedAt',category.updated_at) end) end,at_ms);
  delete from private.catalogue_write_tickets x where x.command_id=t.command_id;
  return private.command_receipt_metadata(r);
end $$;

create or replace function private.apply_catalogue_command(command_id public.ulid,command_type text,item_id public.ulid,available boolean,undo_id public.ulid)
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
      raise sqlstate 'PT409' using detail='catalogue_intent_conflict',message='A newer availability change must be kept.';end if;
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
