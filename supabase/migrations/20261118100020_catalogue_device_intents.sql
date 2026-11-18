-- Device catalogue identities and occurrence times; no unplanned client write path.
alter table private.command_receipts add column occurred_at public.utc_ms,add column category_id public.ulid,add column record_plan jsonb;
alter table private.catalogue_write_tickets add column occurred_at public.utc_ms,add column created_at public.utc_ms,add column record_plan jsonb;
create index catalogue_tickets_auth_expiry_idx on private.catalogue_write_tickets(auth_user_id,expires_at);
alter table private.catalogue_write_tickets drop constraint catalogue_write_tickets_type_check;
alter table private.catalogue_write_tickets add constraint catalogue_write_tickets_type_check check(type in ('catalogue.create','catalogue.update','catalogue.delete','catalogue.remove-sample'));
alter table private.command_receipts drop constraint command_receipts_intent_check;
alter table private.command_receipts add constraint command_receipts_intent_check check(
 (type='catalogue.availability' and requested_available is not null and undo_of is null and before_available is not null and after_available is not null and request_hash is null)
 or (type='catalogue.undo' and requested_available is null and undo_of is not null and before_available is not null and after_available is not null and request_hash is null)
 or (type in ('catalogue.create','catalogue.update','catalogue.delete','catalogue.remove-sample') and requested_available is null and undo_of is null and request_hash is not null
  and (type<>'catalogue.create' or (before_available is null and after_available is not null))
  and (type<>'catalogue.update' or (before_available is not null and after_available is not null))
  and (type not in ('catalogue.delete','catalogue.remove-sample') or (before_available is not null and after_available is null))));

create or replace function private.command_receipt_metadata(r private.command_receipts) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('id',r.id,'type',r.type,'itemId',r.resource_id,'outletId',r.outlet_id,'occurredAt',r.occurred_at,'categoryId',r.category_id,
  'available',r.after_available,'at',r.at,'itemUpdatedAt',r.item_updated_at,'sequence',r.sequence,'undoOf',r.undo_of)
$$;

-- JSON-string tokens in the plan preserve NUL and lone surrogates without jsonb conversion.
create function private.catalogue_intent_plan(command_id public.ulid,kind text,item_id public.ulid,outlet public.ulid,occurred public.utc_ms,ids jsonb,fingerprint text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare field text;encoded text;stats integer[];limits integer[];position integer:=0;canonical text;input jsonb;
begin
 if command_id is null or item_id is null or outlet is null or occurred is null or command_id=item_id or kind is null or kind not in ('catalogue.create','catalogue.update','catalogue.delete','catalogue.remove-sample')
  or jsonb_typeof(ids) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(ids) k) is distinct from array['categoryId','input','intentJson']
  or jsonb_typeof(ids->'intentJson') is distinct from 'string' or octet_length(ids->>'intentJson')>32000 or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$'
  or encode(sha256(convert_to(ids->>'intentJson','UTF8')),'hex')<>fingerprint then raise invalid_parameter_value using message='Keep the complete original catalogue intent.';end if;
 canonical:='{"id":'||to_json(command_id)::text||',"outletId":'||to_json(outlet)::text||',"occurredAt":'||occurred::text||',"type":'||to_json(kind)::text||',"itemId":'||to_json(item_id)::text;
 if kind in ('catalogue.create','catalogue.update') then
  if jsonb_typeof(ids->'categoryId') is distinct from 'string' or ids->>'categoryId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or ids->>'categoryId' in (command_id::text,item_id::text)
   or jsonb_typeof(ids->'input') is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(ids->'input') k) is distinct from array['available','categoryJson','localJson','nameJson','oftenBought','price','unitJson'] then raise invalid_parameter_value using message='Keep the original category identity and normalized input.';end if;
  input:=ids->'input';limits:=array[120,120,16,80];
  foreach field in array array['nameJson','localJson','unitJson','categoryJson'] loop
   position:=position+1;
   if jsonb_typeof(input->field) is distinct from 'string' then raise invalid_parameter_value using message='Keep literal catalogue strings.';end if;
   encoded:=input->>field;
   if left(encoded,1)<>'"' or right(encoded,1)<>'"' then raise invalid_parameter_value using message='Keep canonical literal catalogue tokens.';end if;
   stats:=private.inbox_literal_stats(encoded::json);
   if stats[1]>limits[position] or (field<>'localJson' and stats[2]=0) then raise invalid_parameter_value using message='Check catalogue names, unit and category lengths.';end if;
  end loop;
  if jsonb_typeof(input->'price') is distinct from 'number' or (input->>'price')::numeric<>trunc((input->>'price')::numeric) or (input->>'price')::numeric not between 0 and 9007199254740991
   or jsonb_typeof(input->'available') is distinct from 'boolean' or jsonb_typeof(input->'oftenBought') is distinct from 'boolean' then raise invalid_parameter_value using message='Keep the exact price and catalogue choices.';end if;
  canonical:=canonical||',"categoryId":'||to_json(ids->>'categoryId')::text||',"input":{"name":'||(input->>'nameJson')||',"nameLocal":'||(input->>'localJson')||',"price":'||(input->>'price')||',"unit":'||(input->>'unitJson')||',"category":'||(input->>'categoryJson')||',"available":'||(input->>'available')||',"oftenBought":'||(input->>'oftenBought')||'}}';
 else
  if ids->'categoryId' is distinct from 'null'::jsonb or ids->'input' is distinct from 'null'::jsonb then raise invalid_parameter_value using message='Keep the original catalogue removal.';end if;
  canonical:=canonical||'}';
 end if;
 -- Never parse/extract this full JSON: unrelated literal strings may contain NUL/surrogates.
 if canonical is distinct from ids->>'intentJson' then raise invalid_parameter_value using message='Keep the exact original catalogue fields, IDs and time.';end if;
 return ids-'intentJson';
end $$;

create function private.prepare_catalogue_intent(command_id public.ulid,ticket_id public.ulid,kind text,item_id public.ulid,outlet_id public.ulid,fingerprint text,occurred public.utc_ms,ids jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous private.command_receipts;business public.ulid;actor public.ulid;secret text;at_ms public.utc_ms;plan jsonb;saved public.items;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This catalogue action is unavailable.';end if;
 if ticket_id is null or command_id=ticket_id then raise invalid_parameter_value using message='Keep distinct preparation and command IDs.';end if;
 plan:=private.catalogue_intent_plan(command_id,kind,item_id,outlet_id,occurred,ids,fingerprint);
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into previous from private.command_receipts r where r.id=command_id;
 if found then
  actor:=private.public_link_actor(previous.business_id,previous.outlet_id);perform private.customer_write_actor(previous.business_id,previous.outlet_id,actor,(select auth.uid()));
  if previous.actor_id<>actor or previous.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This catalogue command is unavailable.';end if;
  if previous.type<>kind or previous.resource_id<>item_id or previous.outlet_id<>prepare_catalogue_intent.outlet_id or previous.request_hash is distinct from fingerprint or previous.occurred_at is distinct from occurred or previous.record_plan is distinct from plan then raise unique_violation using message='Keep the original catalogue intent.';end if;
  return jsonb_build_object('done',true,'receipt',private.command_receipt_metadata(previous));
 end if;
 select o.business_id into business from public.outlets o where o.id=prepare_catalogue_intent.outlet_id;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet_id);perform 1 from public.businesses b where b.id=business for share;perform 1 from public.outlets o where o.business_id=business and o.id=prepare_catalogue_intent.outlet_id for update;
 perform private.customer_write_actor(business,outlet_id,actor,(select auth.uid()));at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 select * into saved from public.items i where i.business_id=business and i.outlet_id=prepare_catalogue_intent.outlet_id and i.id=item_id;
 if kind='catalogue.create' then if exists(select 1 from public.items i where i.id=item_id) then raise unique_violation using message='This item identity exists.';end if;
 elsif saved.id is null then raise insufficient_privilege using message='This item is unavailable in this outlet.';
 elsif kind='catalogue.remove-sample' and saved.is_sample is distinct from true then raise invalid_parameter_value using message='Only sample items can be removed during setup.';end if;
 delete from private.catalogue_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.catalogue_write_tickets t where t.command_id=prepare_catalogue_intent.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.occurred_at is distinct from occurred or t.record_plan is distinct from plan or t.outlet_id<>prepare_catalogue_intent.outlet_id)) then raise unique_violation using message='Keep the original category, time and input.';end if;
 delete from private.catalogue_write_tickets t where t.command_id=prepare_catalogue_intent.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.catalogue_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.catalogue_write_tickets(id,command_id,business_id,outlet_id,actor_id,auth_user_id,type,item_id,request_hash,snapshot_hash,token_hash,expires_at,occurred_at,created_at,record_plan)
  values(ticket_id,command_id,business,outlet_id,actor,(select auth.uid()),kind,item_id,fingerprint,private.catalogue_write_snapshot(business,outlet_id,item_id),sha256(convert_to(secret,'UTF8')),at_ms+60000,occurred,at_ms,plan);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'outletId',outlet_id,'actorId',actor,'at',at_ms,
  'itemJson',coalesce((select private.catalogue_item_snapshot(i)::text from public.items i where i.business_id=business and i.outlet_id=prepare_catalogue_intent.outlet_id and i.id=item_id),'null'),
  'categoriesJson',(select coalesce(json_agg(json_build_object('id',c.id,'outletId',c.outlet_id,'name',c.name,'sort',c.sort,'createdAt',c.created_at,'updatedAt',c.updated_at) order by c.id),'[]'::json)::text from public.categories c where c.business_id=business and c.outlet_id=prepare_catalogue_intent.outlet_id));
end $$;

create function private.finish_catalogue_intent(ticket_id public.ulid,secret text,name_json text,local_json text,unit_json text,price public.minor_units,
  category_id public.ulid,new_category_json text,available boolean,often_bought boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.catalogue_write_tickets;saved public.items;previous private.command_receipts;r private.command_receipts;before_data json;before_row json;category public.categories;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;old_available boolean;
begin
  if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Prepare this write again.';end if;
  select * into t from private.catalogue_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) and x.expires_at>at_ms;
  if not found or t.occurred_at is null or t.created_at is null or t.record_plan is null then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Prepare this write again.';end if;
  perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform 1 from public.businesses b where b.id=t.business_id for share;
  perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;perform private.catalogue_ticket_actor(t);
  select * into t from private.catalogue_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) and x.expires_at>floor(extract(epoch from clock_timestamp())*1000)::bigint for update;
  if not found or t.occurred_at is null or t.created_at is null or t.record_plan is null then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Prepare this write again.';end if;
  select * into previous from private.command_receipts x where x.id=t.command_id;
  if found then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='Read the accepted receipt again.';end if;
  select * into saved from public.items i where i.business_id=t.business_id and i.outlet_id=t.outlet_id and i.id=t.item_id for update;
  if private.catalogue_write_snapshot(t.business_id,t.outlet_id,t.item_id)<>t.snapshot_hash then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='The catalogue changed. Prepare again.';end if;
  if t.type='catalogue.create' then
    if saved.id is not null then raise unique_violation using message='This item ID already exists.';end if;
    before_data:='null';before_row:='null';old_available:=null;
  else
    if saved.id is null then raise sqlstate 'PT409' using detail='catalogue_snapshot_changed',message='The item changed. Prepare again.';end if;
    if t.type='catalogue.remove-sample' and saved.is_sample is distinct from true then raise invalid_parameter_value using message='Only sample items can be removed during setup.';end if;
    before_data:=private.catalogue_item_snapshot(saved);before_row:=row_to_json(saved);old_available:=saved.available;
  end if;
  at_ms:=t.created_at;
  if t.type in ('catalogue.delete','catalogue.remove-sample') then
    if name_json is not null or local_json is not null or unit_json is not null or price is not null or category_id is not null or new_category_json is not null or available is not null or often_bought is not null then raise invalid_parameter_value using message='Invalid deletion payload.';end if;
    delete from public.items i where i.id=t.item_id;
  else
    if name_json is distinct from t.record_plan->'input'->>'nameJson' or local_json is distinct from t.record_plan->'input'->>'localJson' or unit_json is distinct from t.record_plan->'input'->>'unitJson'
      or price is distinct from (t.record_plan->'input'->>'price')::bigint or category_id is distinct from (t.record_plan->>'categoryId')::public.ulid or available is distinct from (t.record_plan->'input'->>'available')::boolean or often_bought is distinct from (t.record_plan->'input'->>'oftenBought')::boolean
      or (new_category_json is not null and new_category_json is distinct from t.record_plan->'input'->>'categoryJson') then raise invalid_parameter_value using message='Keep the validated original catalogue input and category.';end if;
    if name_json is null or local_json is null or unit_json is null or price is null or price<0 or category_id is null or available is null or often_bought is null then raise invalid_parameter_value using message='Invalid catalogue payload.';end if;
    if new_category_json is not null then
      insert into public.categories(id,business_id,outlet_id,name,sort,created_at,updated_at) values(category_id,t.business_id,t.outlet_id,new_category_json::public.literal_text,
        (select count(*) from public.categories c where c.business_id=t.business_id and c.outlet_id=t.outlet_id),t.occurred_at,greatest(at_ms,t.occurred_at)) returning * into category;
    elsif not exists(select 1 from public.categories c where c.business_id=t.business_id and c.outlet_id=t.outlet_id and c.id=category_id) then raise insufficient_privilege using message='This category is unavailable.';end if;
    if t.type='catalogue.create' then
      insert into public.items(id,business_id,outlet_id,name,name_local,price,unit,category_id,available,often_bought,is_sample,created_at,updated_at)
        values(t.item_id,t.business_id,t.outlet_id,name_json::public.literal_text,local_json::public.literal_text,price,unit_json::public.literal_text,category_id,available,often_bought,false,t.occurred_at,greatest(at_ms,t.occurred_at)) returning * into saved;
    else
      update public.items i set name=name_json::public.literal_text,name_local=local_json::public.literal_text,price=finish_catalogue_intent.price,unit=unit_json::public.literal_text,
        category_id=finish_catalogue_intent.category_id,available=finish_catalogue_intent.available,often_bought=finish_catalogue_intent.often_bought,is_sample=false,updated_at=greatest(at_ms,t.occurred_at,i.created_at) where i.id=t.item_id returning * into saved;
    end if;
  end if;
  insert into private.command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,resource_id,request_hash,before_available,after_available,at,item_updated_at,before_record,after_record,occurred_at,category_id,record_plan)
    values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.item_id,t.request_hash,old_available,
      case when t.type in ('catalogue.delete','catalogue.remove-sample') then null else saved.available end,at_ms,case when t.type in ('catalogue.delete','catalogue.remove-sample') then at_ms else saved.updated_at end,before_row,
      case when t.type in ('catalogue.delete','catalogue.remove-sample') then 'null'::json else row_to_json(saved) end,t.occurred_at,case when t.type in ('catalogue.delete','catalogue.remove-sample') then null else saved.category_id end,t.record_plan) returning * into r;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,t.type,before_data,
      case when t.type in ('catalogue.delete','catalogue.remove-sample') then 'null'::json else json_build_object('item',private.catalogue_item_snapshot(saved),'category',case when category.id is null then 'null'::json else json_build_object('id',category.id,'outletId',category.outlet_id,'name',category.name,'sort',category.sort,'createdAt',category.created_at,'updatedAt',category.updated_at) end) end,at_ms);
  delete from private.catalogue_write_tickets x where x.command_id=t.command_id;
  return private.command_receipt_metadata(r);
end $$;


create function private.apply_catalogue_intent(command_id public.ulid,command_type text,item_id public.ulid,origin_outlet public.ulid,available boolean,undo_id public.ulid,occurred public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous private.command_receipts; original private.command_receipts; receipt private.command_receipts;
  saved public.items; before_data json; actor public.ulid; business public.ulid; outlet public.ulid; target public.ulid;
  desired boolean; at_ms public.utc_ms; latest public.ulid;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This command is not allowed.';end if;
  if command_id is null or command_id=item_id or command_id=undo_id or origin_outlet is null or occurred is null or command_type is null or command_type not in ('catalogue.availability','catalogue.undo')
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
    if previous.outlet_id<>origin_outlet or previous.occurred_at is distinct from occurred or previous.type<>command_type or previous.requested_available is distinct from available or previous.undo_of is distinct from undo_id
      or (command_type='catalogue.availability' and previous.resource_id<>item_id) then
      raise unique_violation using message='This command ID was already used.';end if;
    return private.command_receipt_metadata(previous);
  end if;
  if command_type='catalogue.undo' then
    select * into original from private.command_receipts r where r.id=undo_id and r.outlet_id=origin_outlet and r.type='catalogue.availability';
    if not found then raise insufficient_privilege using message='This command is not allowed.';end if;
    target:=original.resource_id;business:=original.business_id;outlet:=original.outlet_id;desired:=original.before_available;
  else
    select i.business_id,i.outlet_id into business,outlet from public.items i where i.id=item_id and i.outlet_id=origin_outlet;
    if not found then raise insufficient_privilege using message='This command is not allowed.';end if;
    target:=item_id;desired:=available;
  end if;
  actor:=private.public_link_actor(business,outlet);
  -- All future command handlers for this outlet must use this same write lock.
  perform 1 from public.businesses b where b.id=business for share;perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
  select * into saved from public.items i where i.business_id=business and i.outlet_id=outlet and i.id=target for update;
  if not found then raise insufficient_privilege using message='This command is not allowed.';end if;
  if saved.category_id is null then raise sqlstate 'PT409' using message='Review the item category before retrying.';end if;
  if command_type='catalogue.undo' then
    select r.id into latest from private.command_receipts r where r.business_id=business and r.outlet_id=outlet
      and r.resource_id=target order by r.sequence desc limit 1;
    if latest is distinct from undo_id or saved.available<>original.after_available then
      raise sqlstate 'PT409' using detail='catalogue_intent_conflict',message='A newer availability change must be kept.';end if;
  end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;before_data:=private.catalogue_item_snapshot(saved);
  insert into private.command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,resource_id,requested_available,
    undo_of,before_available,after_available,at,item_updated_at,occurred_at,category_id,before_record,after_record)
    values(command_id,business,outlet,actor,(select auth.uid()),command_type,target,available,undo_id,
      saved.available,desired,at_ms,greatest(at_ms,occurred,saved.created_at),occurred,saved.category_id,row_to_json(saved),row_to_json(saved)) returning * into receipt;
  update public.items i set available=desired,updated_at=receipt.item_updated_at where i.id=target returning * into saved;
  update private.command_receipts r set after_record=row_to_json(saved) where r.id=receipt.id;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,undo_of)
    values(command_id,business,outlet,'member',actor,case when command_type='catalogue.undo' then 'catalogue.availability.undo' else command_type end,
      before_data,private.catalogue_item_snapshot(saved),at_ms,undo_id);
  return private.command_receipt_metadata(receipt);
end $$;


-- Old protocols cannot create unplanned writes or receipts. Historical rows remain intact.
revoke all on function public.prepare_catalogue_write(public.ulid,public.ulid,text,public.ulid,public.ulid,text),private.prepare_catalogue_write(public.ulid,public.ulid,text,public.ulid,public.ulid,text),
 public.finish_catalogue_write(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean),private.finish_catalogue_write(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean),
 public.apply_catalogue_command(public.ulid,text,public.ulid,boolean,public.ulid),private.apply_catalogue_command(public.ulid,text,public.ulid,boolean,public.ulid) from public,anon,authenticated,service_role;
revoke all on function private.catalogue_intent_plan(public.ulid,text,public.ulid,public.ulid,public.utc_ms,jsonb,text),
 private.prepare_catalogue_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,text,public.utc_ms,jsonb),
 private.finish_catalogue_intent(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean),
 private.apply_catalogue_intent(public.ulid,text,public.ulid,public.ulid,boolean,public.ulid,public.utc_ms) from public,anon,authenticated,service_role;
grant execute on function private.prepare_catalogue_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,text,public.utc_ms,jsonb),private.apply_catalogue_intent(public.ulid,text,public.ulid,public.ulid,boolean,public.ulid,public.utc_ms) to authenticated;
grant execute on function private.finish_catalogue_intent(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean) to service_role;
create function public.prepare_catalogue_intent(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_item_id public.ulid,p_outlet_id public.ulid,p_hash text,p_occurred_at public.utc_ms,p_plan jsonb) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_catalogue_intent(p_id,p_ticket_id,p_type,p_item_id,p_outlet_id,p_hash,p_occurred_at,p_plan)$$;
create function public.finish_catalogue_intent(p_ticket_id public.ulid,p_token text,p_name_json text,p_local_json text,p_unit_json text,p_price public.minor_units,p_category_id public.ulid,p_new_category_json text,p_available boolean,p_often_bought boolean) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_catalogue_intent(p_ticket_id,p_token,p_name_json,p_local_json,p_unit_json,p_price,p_category_id,p_new_category_json,p_available,p_often_bought)$$;
create function public.apply_catalogue_intent(p_id public.ulid,p_type text,p_item_id public.ulid,p_outlet_id public.ulid,p_available boolean,p_undo_of public.ulid,p_occurred_at public.utc_ms) returns jsonb
language sql security invoker set search_path='' as $$select private.apply_catalogue_intent(p_id,p_type,p_item_id,p_outlet_id,p_available,p_undo_of,p_occurred_at)$$;
revoke all on function public.prepare_catalogue_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,text,public.utc_ms,jsonb),public.finish_catalogue_intent(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean),public.apply_catalogue_intent(public.ulid,text,public.ulid,public.ulid,boolean,public.ulid,public.utc_ms) from public,anon,authenticated,service_role;
grant execute on function public.prepare_catalogue_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,text,public.utc_ms,jsonb),public.apply_catalogue_intent(public.ulid,text,public.ulid,public.ulid,boolean,public.ulid,public.utc_ms) to authenticated;
grant execute on function public.finish_catalogue_intent(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean) to service_role;
notify pgrst,'reload schema';
