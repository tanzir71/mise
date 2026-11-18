-- Immutable committed change capture. Ordinals page a snapshot; they are NOT a commit cursor.
create table private.sync_epoch(singleton boolean primary key default true check(singleton),id uuid not null default gen_random_uuid());
insert into private.sync_epoch(singleton) values(true);
create table private.sync_scope_versions(business_id public.ulid not null,outlet_id public.ulid primary key,version uuid not null default gen_random_uuid());
create index sync_scope_versions_business_idx on private.sync_scope_versions(business_id);
create table private.sync_changes (
 id bigint generated always as identity primary key,business_id public.ulid not null,outlet_id public.ulid not null,transaction_id xid8 not null,
 table_name text not null,record_id public.ulid not null,operation text not null check(operation in ('upsert','delete')),
 payload bytea not null,payload_sha256 text not null check(payload_sha256~'^[0-9a-f]{64}$')
);
create index sync_changes_scope_ordinal_idx on private.sync_changes(business_id,outlet_id,id);
create index sync_changes_scope_transaction_idx on private.sync_changes(business_id,outlet_id,transaction_id);
create table private.sync_read_windows (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 actor_role text not null check(actor_role in ('owner','manager')),epoch uuid not null,scope_version uuid not null,
 previous_cursor jsonb,previous_snapshot pg_snapshot,current_snapshot pg_snapshot not null,
 last_id bigint not null default 0,last_offset integer not null default 0,next_page integer not null default 0,done boolean not null default false,
 created_at public.utc_ms not null,expires_at public.utc_ms not null
);
create index sync_read_windows_actor_idx on private.sync_read_windows(auth_user_id,expires_at);
create table private.sync_read_pages (
 window_id public.ulid not null references private.sync_read_windows(id) on delete cascade,page_index integer not null,content jsonb not null,
 primary key(window_id,page_index)
);
do $$declare t text;begin foreach t in array array['sync_epoch','sync_scope_versions','sync_changes','sync_read_windows','sync_read_pages'] loop
 execute format('alter table private.%I enable row level security',t);execute format('alter table private.%I force row level security',t);
 execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
end loop;end $$;
revoke all on sequence private.sync_changes_id_seq from public,anon,authenticated,service_role;

create function private.sync_columns(kind text) returns jsonb language sql immutable security invoker set search_path='' as $$
 select '{"businesses":["id","created_at","updated_at","name","business_type","market_code","languages"],"outlets":["id","created_at","updated_at","business_id","name","address","timezone","currency","shop_link","credit_messaging","order_warning_minutes"],"members":["id","created_at","updated_at","business_id","name","phone","role","active"],"categories":["id","created_at","updated_at","outlet_id","name","sort","business_id"],"items":["id","created_at","updated_at","outlet_id","name","name_local","category_id","price","unit","available","is_sample","often_bought","business_id"],"customers":["id","created_at","updated_at","business_id","name","nickname","phone","address","notes","tags","consent","archived_at"],"credit_accounts":["id","created_at","updated_at","outlet_id","customer_id","currency","allowed","credit_limit","reminder","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"orders":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","business_type","sequence","number","source","source_text","customer_id","customer_name","customer_phone","type","status","status_changed_at","status_event_id","lines","subtotal","delivery_fee","discount","total","currency","timezone","address","table_label","scheduled_for","payment","handled_by","business_id"],"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"order_notes":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","order_id","text","business_id"],"order_communications":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","order_id","purpose","channel","text","business_id"],"order_refunds":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","sale_id","customer_id","account_id","amount","currency","method","method_name","note","credit_entry_id","business_id"],"suppliers":["id","created_at","updated_at","outlet_id","revision","name","phone","note","archived_at","event_id","business_id"],"stock_items":["id","created_at","updated_at","outlet_id","revision","name","name_local","active_key","unit","category","aliases","on_hand","target","pack_size","low_at","supplier_id","archived_at","last_counted_at","event_id","business_id"],"stock_moves":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","stock_item_id","name","unit","before_quantity","after_quantity","delta","reason","source","note","count_batch_id","undo_of","business_id"],"supplier_messages":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","supplier_id","supplier_name","phone","text","channel","stock_item_ids","part","parts","business_id"],"day_closings":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","active_key","day","timezone","currency","summary","counted_cash","expected_cash","difference","added_walk_in","added_sale_id","note","preview_fingerprint","created_by_name","business_id"],"purchases":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","supplier_id","supplier_name","reference","lines","total","currency","timezone","paid","method_name","note","photo_ref","business_id"],"inbox_items":["id","created_at","updated_at","outlet_id","revision","title","text","url","kind","archived","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"],"member_outlets":["business_id","member_id","outlet_id"],"customer_outlets":["business_id","outlet_id","customer_id"],"inbox_images":["id","business_id","outlet_id","inbox_item_id","position","name","type","size","sha256","created_at","updated_at","uploaded_at"]}'::jsonb->kind
$$;
-- Only typed identifier columns are converted to jsonb. Literal row data is never parsed.
create function private.sync_row_scope(kind text,row_value anyelement) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;business_field text:=case when kind='businesses' then 'id' else 'business_id' end;outlet_field text:=case when kind='outlets' then 'id' when kind in ('businesses','members','customers') then null else 'outlet_id' end;record_field text:=case when kind='member_outlets' then 'member_id' when kind='customer_outlets' then 'customer_id' else 'id' end;
begin
 if private.sync_columns(kind) is null then raise invalid_parameter_value using message='Unknown sync relation.';end if;
 execute format('select jsonb_build_object(''businessId'',($1).%I,''outletId'',%s,''recordId'',($1).%I)',business_field,case when outlet_field is null then 'null' else format('($1).%I',outlet_field) end,record_field) into result using row_value;return result;
end $$;
create function private.sync_project(kind text,row_value anyelement) returns json language plpgsql stable security invoker set search_path='' as $$
declare columns_text text;result json;
begin
 if private.sync_columns(kind) is null then raise invalid_parameter_value using message='Unknown sync projection.';end if;
 select string_agg(format('($1).%I as %I',x,x),',' order by x) into columns_text from jsonb_array_elements_text(private.sync_columns(kind)) x;
 execute format('select row_to_json(p) from (select %s) p',columns_text) into result using row_value;return result;
end $$;
create function private.sync_emit(business public.ulid,outlet public.ulid,kind text,record public.ulid,action text,data json) returns void
language plpgsql security invoker set search_path='' as $$
declare bytes bytea;
begin
 if private.sync_columns(kind) is null or action not in ('upsert','delete') then raise invalid_parameter_value using message='Unknown sync projection.';end if;
 bytes:=convert_to(case when action='upsert' then data::text else 'null' end,'UTF8');
 insert into private.sync_changes(business_id,outlet_id,transaction_id,table_name,record_id,operation,payload,payload_sha256)
 values(business,outlet,pg_current_xact_id(),kind,record,action,bytes,encode(sha256(bytes),'hex'));
end $$;
create function private.sync_capture(kind text,row_value anyelement,action text) returns void
language plpgsql security invoker set search_path='' as $$
declare meta jsonb:=private.sync_row_scope(kind,row_value);business public.ulid:=(meta->>'businessId')::public.ulid;outlet public.ulid:=(meta->>'outletId')::public.ulid;record public.ulid:=(meta->>'recordId')::public.ulid;data json;branch public.ulid;m public.members;c public.customers;b public.businesses;
begin
 if action='upsert' then data:=private.sync_project(kind,row_value);end if;
 if kind in ('member_outlets','customer_outlets') then
  perform private.sync_emit(business,outlet,kind,record,action,data);
  if action='delete' then
   update private.sync_scope_versions v set version=gen_random_uuid() where v.business_id=business and v.outlet_id=outlet;
   if kind='customer_outlets' or not exists(select 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=record) then perform private.sync_emit(business,outlet,case when kind='member_outlets' then 'members' else 'customers' end,record,'delete',null);end if;
  elsif kind='member_outlets' then
   select * into m from public.members x where x.business_id=business and x.id=record;if found then perform private.sync_emit(business,outlet,'members',record,'upsert',private.sync_project('members',m));end if;
  else
   select * into c from public.customers x where x.business_id=business and x.id=record;if found then perform private.sync_emit(business,outlet,'customers',record,'upsert',private.sync_project('customers',c));end if;
  end if;return;
 end if;
 if kind in ('businesses','members','customers') then
  for branch in select o.id from public.outlets o where o.business_id=business order by o.id loop perform private.sync_emit(business,branch,kind,record,action,data);end loop;return;
 end if;
 if kind='outlets' and action='upsert' then
  insert into private.sync_scope_versions(business_id,outlet_id) values(business,outlet) on conflict(outlet_id) do nothing;
  select * into b from public.businesses x where x.id=business;if found then perform private.sync_emit(business,outlet,'businesses',business,'upsert',private.sync_project('businesses',b));end if;
 end if;
 perform private.sync_emit(business,outlet,kind,record,action,data);
end $$;
create function private.sync_capture_trigger() returns trigger language plpgsql security definer set search_path='' as $$
declare source record;before_meta jsonb;after_meta jsonb;
begin
 if tg_table_schema<>'public' or private.sync_columns(tg_table_name) is null then raise insufficient_privilege using message='Invalid sync capture relation.';end if;
 if tg_op='TRUNCATE' then
  for source in execute format('select r from public.%I r',tg_table_name) loop perform private.sync_capture(tg_table_name,source.r,'delete');end loop;return null;
 end if;
 if tg_op='DELETE' then perform private.sync_capture(tg_table_name,old,'delete');return old;end if;
 after_meta:=private.sync_row_scope(tg_table_name,new);
 if tg_op='UPDATE' then before_meta:=private.sync_row_scope(tg_table_name,old);end if;
 if tg_table_name='outlets' and (tg_op='INSERT' or before_meta->>'businessId' is distinct from after_meta->>'businessId') then
  insert into private.sync_scope_versions(business_id,outlet_id) values((after_meta->>'businessId')::public.ulid,(after_meta->>'outletId')::public.ulid) on conflict(outlet_id) do update set business_id=excluded.business_id,version=gen_random_uuid();
 end if;
 if tg_op='UPDATE' and (before_meta is distinct from after_meta or tg_table_name in ('member_outlets','customer_outlets')) then perform private.sync_capture(tg_table_name,old,'delete');end if;
 perform private.sync_capture(tg_table_name,new,'upsert');
 if tg_table_name='outlets' and tg_op='INSERT' then
  for source in select m as r from public.members m where m.business_id=(after_meta->>'businessId')::public.ulid loop perform private.sync_emit((after_meta->>'businessId')::public.ulid,(after_meta->>'outletId')::public.ulid,'members',(source.r).id,'upsert',private.sync_project('members',source.r));end loop;
  for source in select c as r from public.customers c where c.business_id=(after_meta->>'businessId')::public.ulid loop perform private.sync_emit((after_meta->>'businessId')::public.ulid,(after_meta->>'outletId')::public.ulid,'customers',(source.r).id,'upsert',private.sync_project('customers',source.r));end loop;
 end if;return new;
end $$;
-- Every BEFORE TRUNCATE runs before any table is emptied, so tombstone scope is retained.
do $$declare kind text;source record;begin
 for kind in select t.tablename from pg_catalog.pg_tables t where t.schemaname='public' and private.sync_columns(t.tablename) is not null order by t.tablename loop
  execute format('create trigger mise_sync_row after insert or update or delete on public.%I for each row execute function private.sync_capture_trigger()',kind);
  execute format('create trigger mise_sync_truncate before truncate on public.%I for each statement execute function private.sync_capture_trigger()',kind);
 end loop;
 insert into private.sync_scope_versions(business_id,outlet_id) select o.business_id,o.id from public.outlets o on conflict do nothing;
 for kind in select t.tablename from pg_catalog.pg_tables t where t.schemaname='public' and private.sync_columns(t.tablename) is not null order by t.tablename loop
  execute format('select private.sync_capture(%L,r,''upsert'') from public.%I r',kind,kind);
 end loop;
end $$;

create function private.sync_read_actor(outlet public.ulid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare business public.ulid;actor public.ulid;role_value text;scope_version uuid;epoch uuid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This sync scope is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 select m.role into role_value from public.members m where m.business_id=business and m.id=actor;
 select v.version into scope_version from private.sync_scope_versions v where v.business_id=business and v.outlet_id=outlet for share;select e.id into epoch from private.sync_epoch e;
 if scope_version is null or epoch is null then raise object_not_in_prerequisite_state using message='Sync capture is unavailable.';end if;
 return jsonb_build_object('businessId',business,'outletId',outlet,'actorId',actor,'role',role_value,'scopeVersion',scope_version,'epoch',epoch,'accountHash',encode(sha256(uuid_send((select auth.uid()))),'hex'));
end $$;
create function private.sync_visible(kind text,record public.ulid,business public.ulid,outlet public.ulid,actor public.ulid) returns boolean
language sql stable security invoker set search_path='' as $$
 select case when kind in ('members','member_outlets') then record=actor or exists(select 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=record)
 when kind in ('customers','customer_outlets') then exists(select 1 from public.customer_outlets a where a.business_id=business and a.outlet_id=outlet and a.customer_id=record)
 else true end
$$;
create function private.prepare_sync_read(window_id public.ulid,outlet public.ulid,previous jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb;w private.sync_read_windows;at_ms public.utc_ms;before_snapshot pg_snapshot;next_snapshot pg_snapshot;
begin
 if window_id is null or outlet is null then raise invalid_parameter_value using message='Keep the sync review and outlet identities.';end if;
 actor:=private.sync_read_actor(outlet);perform pg_advisory_xact_lock(hashtextextended('sync-read:'||window_id::text,0));at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if previous is not null then
  if jsonb_typeof(previous) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(previous) k) is distinct from array['accountHash','actorId','businessId','epoch','outletId','role','scopeVersion','snapshot','v'] or previous->'v' is distinct from '1'::jsonb or jsonb_typeof(previous->'snapshot') is distinct from 'string' or octet_length(previous->>'snapshot')>65536 then raise invalid_parameter_value using message='Keep the complete accepted sync cursor.';end if;
  if exists(select 1 from jsonb_each_text(actor) e where previous->>e.key is distinct from e.value) then raise sqlstate 'PT409' using message='Review this outlet again after its access or epoch changed.';end if;
  before_snapshot:=(previous->>'snapshot')::pg_snapshot;
 end if;
 select * into w from private.sync_read_windows x where x.id=window_id for update;
 if found then
  if w.auth_user_id<>(select auth.uid()) or w.actor_id::text<>actor->>'actorId' or w.business_id::text<>actor->>'businessId' or w.outlet_id<>outlet then raise insufficient_privilege using message='This sync review is unavailable.';end if;
  if w.expires_at<=at_ms or w.epoch::text<>actor->>'epoch' or w.scope_version::text<>actor->>'scopeVersion' or w.actor_role<>actor->>'role' then raise sqlstate 'PT409' using message='Prepare a fresh sync review from the last accepted cursor.';end if;
  if w.previous_cursor is distinct from previous then raise unique_violation using message='Keep the original sync review source.';end if;
 else
  delete from private.sync_read_windows x where x.auth_user_id=(select auth.uid()) and (x.expires_at<=at_ms or x.outlet_id=outlet and (x.epoch::text<>actor->>'epoch' or x.scope_version::text<>actor->>'scopeVersion' or x.actor_role<>actor->>'role'));
  if (select count(*) from private.sync_read_windows x where x.auth_user_id=(select auth.uid()) and not x.done)>=10 then raise sqlstate 'PT429' using message='Resume pending sync reviews first.';end if;
  next_snapshot:=pg_current_snapshot();
  if before_snapshot is not null and (pg_snapshot_xmin(before_snapshot)>pg_snapshot_xmin(next_snapshot) or pg_snapshot_xmax(before_snapshot)>pg_snapshot_xmax(next_snapshot) or exists(select 1 from pg_snapshot_xip(next_snapshot) x where pg_visible_in_snapshot(x,before_snapshot))) then raise invalid_parameter_value using message='Keep the last accepted cursor; the snapshot moved backwards.';end if;
  insert into private.sync_read_windows(id,business_id,outlet_id,actor_id,auth_user_id,actor_role,epoch,scope_version,previous_cursor,previous_snapshot,current_snapshot,created_at,expires_at)
  values(window_id,(actor->>'businessId')::public.ulid,outlet,(actor->>'actorId')::public.ulid,(select auth.uid()),actor->>'role',(actor->>'epoch')::uuid,(actor->>'scopeVersion')::uuid,previous,before_snapshot,next_snapshot,at_ms,at_ms+86400000) returning * into w;
 end if;
 return actor||jsonb_build_object('v',1,'id',w.id,'createdAt',w.created_at,'expiresAt',w.expires_at,'snapshot',w.current_snapshot::text);
end $$;
create function private.read_sync_page(window_id public.ulid,outlet public.ulid,page_index integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb;w private.sync_read_windows;c private.sync_changes;cached jsonb;result jsonb;parts jsonb:='[]';budget integer:=196608;take integer;at_ms public.utc_ms;
begin
 if page_index is null or page_index<0 or page_index>1000000 then raise invalid_parameter_value using message='Keep the original sync page position.';end if;
 actor:=private.sync_read_actor(outlet);select * into w from private.sync_read_windows x where x.id=window_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if w.id is null or w.auth_user_id<>(select auth.uid()) or w.actor_id::text<>actor->>'actorId' or w.business_id::text<>actor->>'businessId' or w.outlet_id<>outlet then raise insufficient_privilege using message='This sync review is unavailable.';end if;
 if w.expires_at<=at_ms or w.epoch::text<>actor->>'epoch' or w.scope_version::text<>actor->>'scopeVersion' or w.actor_role<>actor->>'role' then raise sqlstate 'PT409' using message='Prepare a fresh sync review from the last accepted cursor.';end if;
 select p.content into cached from private.sync_read_pages p where p.window_id=w.id and p.page_index=read_sync_page.page_index;if found then return cached;end if;
 if page_index<>w.next_page or w.done then raise invalid_parameter_value using message='Resume sync pages in their original order.';end if;
 while budget>0 and jsonb_array_length(parts)<256 loop
  select * into c from private.sync_changes x where x.business_id=w.business_id and x.outlet_id=w.outlet_id
   and x.id>=w.last_id and (x.id>w.last_id or x.id=w.last_id and w.last_offset>0)
   and (w.previous_snapshot is null or x.transaction_id>=pg_snapshot_xmin(w.previous_snapshot)) and pg_visible_in_snapshot(x.transaction_id,w.current_snapshot) and (w.previous_snapshot is null or not pg_visible_in_snapshot(x.transaction_id,w.previous_snapshot))
   and (x.operation='delete' or private.sync_visible(x.table_name,x.record_id,w.business_id,w.outlet_id,w.actor_id)) order by x.id limit 1;
  if not found then w.done:=true;exit;end if;
  if c.id<>w.last_id then w.last_id:=c.id;w.last_offset:=0;end if;
  take:=least(budget,octet_length(c.payload)-w.last_offset);
  parts:=parts||jsonb_build_array(jsonb_build_object('changeId',c.id::text,'table',c.table_name,'id',c.record_id,'operation',c.operation,'offset',w.last_offset,'totalBytes',octet_length(c.payload),'sha256',c.payload_sha256,'data',replace(encode(substring(c.payload from w.last_offset+1 for take),'base64'),chr(10),'')));
  budget:=budget-take;w.last_offset:=w.last_offset+take;if w.last_offset=octet_length(c.payload) then w.last_offset:=0;end if;
 end loop;
 result:=actor||jsonb_build_object('v',1,'id',w.id,'index',page_index,'parts',parts,'done',w.done,'snapshot',w.current_snapshot::text);
 insert into private.sync_read_pages values(w.id,page_index,result);
 update private.sync_read_windows x set last_id=w.last_id,last_offset=w.last_offset,next_page=page_index+1,done=w.done where x.id=w.id;
 return result;
end $$;
create function private.admit_sync_read(outlet public.ulid) returns boolean language plpgsql security definer set search_path='' as $$begin perform private.sync_read_actor(outlet);return true;end $$;
revoke all on function private.sync_columns(text),private.sync_emit(public.ulid,public.ulid,text,public.ulid,text,json),private.sync_row_scope(text,anyelement),private.sync_project(text,anyelement),private.sync_capture(text,anyelement,text),private.sync_capture_trigger(),private.sync_read_actor(public.ulid),private.sync_visible(text,public.ulid,public.ulid,public.ulid,public.ulid),private.prepare_sync_read(public.ulid,public.ulid,jsonb),private.read_sync_page(public.ulid,public.ulid,integer),private.admit_sync_read(public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.admit_sync_read(public.ulid),private.prepare_sync_read(public.ulid,public.ulid,jsonb),private.read_sync_page(public.ulid,public.ulid,integer) to authenticated;
create function public.admit_sync_read(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_sync_read(p_outlet_id)$$;
create function public.prepare_sync_read(p_id public.ulid,p_outlet_id public.ulid,p_previous jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_sync_read(p_id,p_outlet_id,p_previous)$$;
create function public.read_sync_page(p_id public.ulid,p_outlet_id public.ulid,p_index integer) returns jsonb language sql security invoker set search_path='' as $$select private.read_sync_page(p_id,p_outlet_id,p_index)$$;
revoke all on function public.admit_sync_read(public.ulid),public.prepare_sync_read(public.ulid,public.ulid,jsonb),public.read_sync_page(public.ulid,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.admit_sync_read(public.ulid),public.prepare_sync_read(public.ulid,public.ulid,jsonb),public.read_sync_page(public.ulid,public.ulid,integer) to authenticated;
