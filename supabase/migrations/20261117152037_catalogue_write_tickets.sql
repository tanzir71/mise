alter table private.command_receipts drop constraint command_receipts_type_check,drop constraint command_receipts_check,
  alter column before_available drop not null,alter column after_available drop not null,
  add column request_hash text check(request_hash ~ '^[0-9a-f]{64}$'),add column before_record json,add column after_record json;
alter table private.command_receipts add constraint command_receipts_intent_check check(
  (type='catalogue.availability' and requested_available is not null and undo_of is null and before_available is not null and after_available is not null and request_hash is null)
  or (type='catalogue.undo' and requested_available is null and undo_of is not null and before_available is not null and after_available is not null and request_hash is null)
  or (type in ('catalogue.create','catalogue.update','catalogue.delete') and requested_available is null and undo_of is null and request_hash is not null
    and (type<>'catalogue.create' or (before_available is null and after_available is not null))
    and (type<>'catalogue.update' or (before_available is not null and after_available is not null))
    and (type<>'catalogue.delete' or (before_available is not null and after_available is null))));
create table private.catalogue_write_tickets (
  id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
  actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('catalogue.create','catalogue.update','catalogue.delete')),
  item_id public.ulid not null,request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),snapshot_hash bytea not null,
  token_hash bytea not null unique,expires_at public.utc_ms not null,
  foreign key(business_id,outlet_id) references public.outlets(business_id,id),
  foreign key(business_id,actor_id) references public.members(business_id,id),
  check(octet_length(token_hash)=32 and octet_length(snapshot_hash)=32)
);
alter table private.catalogue_write_tickets enable row level security;alter table private.catalogue_write_tickets force row level security;
revoke all on private.catalogue_write_tickets from public,anon,authenticated,service_role;
create index catalogue_tickets_actor_idx on private.catalogue_write_tickets(business_id,actor_id,expires_at);
create index catalogue_tickets_outlet_idx on private.catalogue_write_tickets(business_id,outlet_id);
create index catalogue_tickets_command_idx on private.catalogue_write_tickets(command_id);

create function private.catalogue_write_snapshot(business public.ulid,outlet public.ulid,item public.ulid) returns bytea
language sql volatile security invoker set search_path='' as $$
  select sha256(convert_to(json_build_object('item',(select row_to_json(i) from public.items i where i.business_id=business and i.outlet_id=outlet and i.id=item),
    'categories',(select coalesce(json_agg(row_to_json(c) order by c.id),'[]'::json) from public.categories c where c.business_id=business and c.outlet_id=outlet))::text,'UTF8'))
$$;
-- Only the stored, originally verified identity is used by the service commit.
create function private.catalogue_ticket_actor(t private.catalogue_write_tickets) returns void
language plpgsql security invoker set search_path='' as $$
declare role text;
begin
  select m.role into role from public.members m join auth.users u on u.id=m.auth_user_id
    where m.id=t.actor_id and m.business_id=t.business_id and m.auth_user_id=t.auth_user_id and m.active and m.role in ('owner','manager')
      and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>'' and u.deleted_at is null and (u.banned_until is null or u.banned_until<=statement_timestamp()) for share of m,u;
  if not found then raise insufficient_privilege using message='This change is unavailable.';end if;
  if role='manager' then
    perform 1 from public.member_outlets a where a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.member_id=t.actor_id for share;
    if not found then raise insufficient_privilege using message='This change is unavailable.';end if;
  end if;
end $$;
create function private.prepare_catalogue_write(command_id public.ulid,ticket_id public.ulid,kind text,item_id public.ulid,outlet_id public.ulid,fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous private.command_receipts;business public.ulid;outlet public.ulid;actor public.ulid;secret text;at_ms public.utc_ms;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This change is unavailable.';end if;
  if command_id is null or ticket_id is null or item_id is null or kind is null or kind not in ('catalogue.create','catalogue.update','catalogue.delete')
    or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or (kind='catalogue.create')<>(outlet_id is not null) then
    raise invalid_parameter_value using message='Choose a valid catalogue write.';end if;
  perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
  select * into previous from private.command_receipts r where r.id=command_id;
  if found then
    actor:=private.public_link_actor(previous.business_id,previous.outlet_id);
    if previous.actor_id<>actor or previous.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This change is unavailable.';end if;
    if previous.type<>kind or previous.resource_id<>item_id or previous.request_hash is distinct from fingerprint or (outlet_id is not null and previous.outlet_id<>outlet_id) then
      raise unique_violation using message='This command ID was already used.';end if;
    return jsonb_build_object('done',true,'receipt',private.command_receipt_metadata(previous));
  end if;
  if kind='catalogue.create' then
    select o.business_id,o.id into business,outlet from public.outlets o where o.id=outlet_id;
  else select i.business_id,i.outlet_id into business,outlet from public.items i where i.id=item_id;end if;
  if not found then raise insufficient_privilege using message='This change is unavailable.';end if;
  actor:=private.public_link_actor(business,outlet);
  perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
  if kind='catalogue.create' and exists(select 1 from public.items i where i.id=item_id) then raise unique_violation using message='This item ID already exists.';end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  delete from private.catalogue_write_tickets t where t.business_id=business and t.actor_id=actor and t.expires_at<=at_ms;
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  insert into private.catalogue_write_tickets(id,command_id,business_id,outlet_id,actor_id,auth_user_id,type,item_id,request_hash,snapshot_hash,token_hash,expires_at)
    values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,item_id,fingerprint,private.catalogue_write_snapshot(business,outlet,item_id),sha256(convert_to(secret,'UTF8')),at_ms+60000);
  return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'outletId',outlet,'actorId',actor,'at',at_ms,
    'itemJson',coalesce((select private.catalogue_item_snapshot(i)::text from public.items i where i.business_id=business and i.outlet_id=outlet and i.id=item_id),'null'),
    'categoriesJson',(select coalesce(json_agg(json_build_object('id',c.id,'outletId',c.outlet_id,'name',c.name,'sort',c.sort,'createdAt',c.created_at,'updatedAt',c.updated_at) order by c.id),'[]'::json)::text from public.categories c where c.business_id=business and c.outlet_id=outlet));
end $$;

create function private.finish_catalogue_write(ticket_id public.ulid,secret text,name_json text,local_json text,unit_json text,price public.minor_units,
  category_id public.ulid,new_category_json text,available boolean,often_bought boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.catalogue_write_tickets;saved public.items;previous private.command_receipts;r private.command_receipts;before_data json;before_row json;category public.categories;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;old_available boolean;
begin
  if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise serialization_failure using message='Prepare this write again.';end if;
  select * into t from private.catalogue_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) and x.expires_at>at_ms;
  if not found then raise serialization_failure using message='Prepare this write again.';end if;
  perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.catalogue_ticket_actor(t);
  perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
  select * into t from private.catalogue_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) and x.expires_at>floor(extract(epoch from clock_timestamp())*1000)::bigint for update;
  if not found then raise serialization_failure using message='Prepare this write again.';end if;
  select * into previous from private.command_receipts x where x.id=t.command_id;
  if found then raise serialization_failure using message='Read the accepted receipt again.';end if;
  select * into saved from public.items i where i.business_id=t.business_id and i.outlet_id=t.outlet_id and i.id=t.item_id for update;
  if private.catalogue_write_snapshot(t.business_id,t.outlet_id,t.item_id)<>t.snapshot_hash then raise serialization_failure using message='The catalogue changed. Prepare again.';end if;
  if t.type='catalogue.create' then
    if saved.id is not null then raise unique_violation using message='This item ID already exists.';end if;
    before_data:='null';before_row:='null';old_available:=null;
  else
    if saved.id is null then raise serialization_failure using message='The item changed. Prepare again.';end if;
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
revoke all on function private.catalogue_write_snapshot(public.ulid,public.ulid,public.ulid),private.catalogue_ticket_actor(private.catalogue_write_tickets),
  private.prepare_catalogue_write(public.ulid,public.ulid,text,public.ulid,public.ulid,text),
  private.finish_catalogue_write(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function private.prepare_catalogue_write(public.ulid,public.ulid,text,public.ulid,public.ulid,text) to authenticated;
grant execute on function private.finish_catalogue_write(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean) to service_role;
create function public.prepare_catalogue_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_item_id public.ulid,p_outlet_id public.ulid,p_hash text) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_catalogue_write(p_id,p_ticket_id,p_type,p_item_id,p_outlet_id,p_hash)$$;
create function public.finish_catalogue_write(p_ticket_id public.ulid,p_token text,p_name_json text,p_local_json text,p_unit_json text,p_price public.minor_units,
  p_category_id public.ulid,p_new_category_json text,p_available boolean,p_often_bought boolean) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_catalogue_write(p_ticket_id,p_token,p_name_json,p_local_json,p_unit_json,p_price,p_category_id,p_new_category_json,p_available,p_often_bought)$$;
revoke all on function public.prepare_catalogue_write(public.ulid,public.ulid,text,public.ulid,public.ulid,text),
  public.finish_catalogue_write(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function public.prepare_catalogue_write(public.ulid,public.ulid,text,public.ulid,public.ulid,text) to authenticated;
grant execute on function public.finish_catalogue_write(public.ulid,text,text,text,text,public.minor_units,public.ulid,text,boolean,boolean) to service_role;
