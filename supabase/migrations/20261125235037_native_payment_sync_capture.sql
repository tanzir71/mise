-- Native rows join the same immutable transaction stream and snapshot as money.
-- Raw JSON strings preserve literal NUL/surrogate source without public row grants.
create or replace function private.sync_columns(kind text) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select case when kind='member_refs' then '["id","business_id","created_at","updated_at","name","role"]'::jsonb
 when kind in ('native_payments','native_payment_events') then '["id","business_id","outlet_id","record_json"]'::jsonb
 when kind='native_payment_actions' then '["id","business_id","outlet_id","actor_id","request_hash","intent_json","receipt"]'::jsonb
 else private.sync_columns_v1(kind) end
$$;

alter table private.native_payment_observations add column sync_actor_id public.ulid;
alter table private.native_payment_events add column sync_actor_id public.ulid;
create function private.sync_native_member(payload text,kind text) returns public.ulid
language plpgsql immutable security invoker set search_path='' as $$
declare value jsonb:=private.native_payment_tokens(payload::json);
begin
 return case when kind='native_payment_observations' then private.native_payment_text(value->'createdBy')::public.ulid
 when kind='native_payment_events' and private.native_payment_text(value->'actor'->'type')='member' then private.native_payment_text(value->'actor'->'id')::public.ulid end;
end $$;
-- Derive the private FK reference once, with the same opaque literal reader as
-- native execution. JSON field extraction can otherwise reject unrelated NULs.
create function private.sync_native_member_identity() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_schema<>'private' or tg_table_name not in ('native_payment_observations','native_payment_events') then raise insufficient_privilege using message='Invalid native member reference.';end if;
 new.sync_actor_id:=private.sync_native_member(new.record_json,tg_table_name);return new;
end $$;
update private.native_payment_observations set sync_actor_id=private.sync_native_member(record_json,'native_payment_observations');
update private.native_payment_events set sync_actor_id=private.sync_native_member(record_json,'native_payment_events');
create trigger mise_sync_native_identity before insert or update on private.native_payment_observations for each row execute function private.sync_native_member_identity();
create trigger mise_sync_native_identity before insert or update on private.native_payment_events for each row execute function private.sync_native_member_identity();
create index native_payment_creator_reference_idx on private.native_payment_observations(business_id,sync_actor_id,outlet_id);
create index native_payment_event_reference_idx on private.native_payment_events(business_id,sync_actor_id,outlet_id);
create index native_payment_action_reference_idx on private.native_payment_actions(business_id,actor_id,outlet_id);
create index sync_native_presence_idx on private.sync_changes(business_id,outlet_id)
 where table_name in ('native_payments','native_payment_events','native_payment_actions');

-- Native private writers already run inside their protected definer boundary.
-- Their trigger inherits that caller; it needs no additional definer privilege.
create function private.sync_capture_native_payment() returns trigger
language plpgsql security invoker set search_path='' as $$
declare r record;member public.ulid;kind text;data json;source record;
begin
 if tg_table_schema<>'private' or tg_table_name not in ('native_payment_observations','native_payment_events','native_payment_actions') then raise insufficient_privilege using message='Invalid native sync source.';end if;
 kind:=case when tg_table_name='native_payment_observations' then 'native_payments' else tg_table_name end;
 if tg_op='TRUNCATE' then
  for source in execute format('select id,business_id,outlet_id,%s as member from private.%I',case when tg_table_name='native_payment_actions' then 'actor_id' else 'sync_actor_id' end,tg_table_name) loop
   perform private.sync_emit(source.business_id,source.outlet_id,kind,source.id,'delete',null);
   perform private.sync_enqueue_member_reference(source.business_id,source.outlet_id,source.member);
  end loop;
  return null;
 end if;
 if tg_op not in ('INSERT','UPDATE','DELETE') then raise insufficient_privilege using message='Invalid native sync operation.';end if;
 if tg_op<>'INSERT' then
  r:=old;
  if tg_table_name='native_payment_actions' then member:=r.actor_id;else member:=r.sync_actor_id;end if;
  perform private.sync_enqueue_member_reference(r.business_id,r.outlet_id,member);
  if tg_op='DELETE' or row(old.id,old.business_id,old.outlet_id) is distinct from row(new.id,new.business_id,new.outlet_id) then
   perform private.sync_emit(r.business_id,r.outlet_id,kind,r.id,'delete',null);
  end if;
 end if;
 if tg_op<>'DELETE' then
  r:=new;
  if tg_table_name='native_payment_actions' then
   data:=json_build_object('id',r.id,'business_id',r.business_id,'outlet_id',r.outlet_id,'actor_id',r.actor_id,'request_hash',r.request_hash,'intent_json',r.intent_json,'receipt',r.receipt);member:=r.actor_id;
  else
   data:=json_build_object('id',r.id,'business_id',r.business_id,'outlet_id',r.outlet_id,'record_json',r.record_json);member:=r.sync_actor_id;
  end if;
  perform private.sync_emit(r.business_id,r.outlet_id,kind,r.id,'upsert',data);
  perform private.sync_enqueue_member_reference(r.business_id,r.outlet_id,member);
 end if;
 return null;
end $$;

create or replace function private.sync_member_reference_outlets(business public.ulid,member public.ulid) returns setof public.ulid
language sql stable security invoker set search_path='' as $$
 select outlet_id from public.events where business_id=business and actor_member_id=member
 union select outlet_id from public.orders where business_id=business and created_by=member
 union select outlet_id from public.orders where business_id=business and handled_by=member
 union select outlet_id from public.sales where business_id=business and created_by=member
 union select outlet_id from public.credit_entries where business_id=business and created_by=member
 union select outlet_id from public.order_notes where business_id=business and created_by=member
 union select outlet_id from public.order_communications where business_id=business and created_by=member
 union select outlet_id from public.order_refunds where business_id=business and created_by=member
 union select outlet_id from public.stock_moves where business_id=business and created_by=member
 union select outlet_id from public.supplier_messages where business_id=business and created_by=member
 union select outlet_id from public.day_closings where business_id=business and created_by=member
 union select outlet_id from public.purchases where business_id=business and created_by=member
 union select outlet_id from private.native_payment_observations where business_id=business and sync_actor_id=member
 union select outlet_id from private.native_payment_events where business_id=business and sync_actor_id=member
 union select outlet_id from private.native_payment_actions where business_id=business and actor_id=member
$$;

-- Legacy-only windows retain their existing protocol. Once native history exists,
-- every admission, fresh/cached page and preparation needs a live actual session.
create function private.sync_require_native_session(outlet public.ulid) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 if exists(select 1 from private.sync_changes c where c.outlet_id=outlet and c.business_id=(select o.business_id from public.outlets o where o.id=outlet) and c.table_name in ('native_payments','native_payment_events','native_payment_actions')) then
  perform private.current_native_payment_session();
 end if;
end $$;

create or replace function private.sync_read_actor(outlet public.ulid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare business public.ulid;actor public.ulid;role_value text;scope_version uuid;epoch uuid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This sync scope is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));perform private.operator_account_hash();
 -- Keep the existing membership/user locking order before the additional session lease.
 perform private.sync_require_native_session(outlet);
 select m.role into role_value from public.members m where m.business_id=business and m.id=actor;
 select v.version into scope_version from private.sync_scope_versions v where v.business_id=business and v.outlet_id=outlet for share;select e.id into epoch from private.sync_epoch e;
 if scope_version is null or epoch is null then raise object_not_in_prerequisite_state using message='Sync capture is unavailable.';end if;
 return jsonb_build_object('businessId',business,'outletId',outlet,'actorId',actor,'role',role_value,'scopeVersion',scope_version,'epoch',epoch,'accountHash',encode(sha256(uuid_send((select auth.uid()))),'hex'));
end $$;
create or replace function private.prepare_sync_read(window_id public.ulid,outlet public.ulid,previous jsonb) returns jsonb
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
 perform private.sync_require_native_session(outlet);
 return actor||jsonb_build_object('v',1,'id',w.id,'createdAt',w.created_at,'expiresAt',w.expires_at,'snapshot',w.current_snapshot::text);
end $$;
create or replace function private.read_sync_page(window_id public.ulid,outlet public.ulid,page_index integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb;w private.sync_read_windows;c private.sync_changes;cached jsonb;result jsonb;parts jsonb:='[]';budget integer:=196608;take integer;at_ms public.utc_ms;
begin
 if page_index is null or page_index<0 or page_index>1000000 then raise invalid_parameter_value using message='Keep the original sync page position.';end if;
 actor:=private.sync_read_actor(outlet);select * into w from private.sync_read_windows x where x.id=window_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if w.id is null or w.auth_user_id<>(select auth.uid()) or w.actor_id::text<>actor->>'actorId' or w.business_id::text<>actor->>'businessId' or w.outlet_id<>outlet then raise insufficient_privilege using message='This sync review is unavailable.';end if;
 if w.expires_at<=at_ms or w.epoch::text<>actor->>'epoch' or w.scope_version::text<>actor->>'scopeVersion' or w.actor_role<>actor->>'role' then raise sqlstate 'PT409' using message='Prepare a fresh sync review from the last accepted cursor.';end if;
 select p.content into cached from private.sync_read_pages p where p.window_id=w.id and p.page_index=read_sync_page.page_index;if found then perform private.sync_require_native_session(outlet);return cached;end if;
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
 perform private.sync_require_native_session(outlet);
 return result;
end $$;

-- Backfill complete existing native histories before rotating the feed epoch.
-- Capture is atomic with genuine native writes; it never executes an invocation.
do $$declare relation text;r record;kind text;data json;member public.ulid;begin
 foreach relation in array array['native_payment_observations','native_payment_events','native_payment_actions'] loop
  execute format('create trigger mise_sync_native_row after insert or update or delete on private.%I for each row execute function private.sync_capture_native_payment()',relation);
  execute format('create trigger mise_sync_native_truncate before truncate on private.%I for each statement execute function private.sync_capture_native_payment()',relation);
  kind:=case when relation='native_payment_observations' then 'native_payments' else relation end;
  for r in execute format('select * from private.%I order by id',relation) loop
   if relation='native_payment_actions' then
    data:=json_build_object('id',r.id,'business_id',r.business_id,'outlet_id',r.outlet_id,'actor_id',r.actor_id,'request_hash',r.request_hash,'intent_json',r.intent_json,'receipt',r.receipt);member:=r.actor_id;
   else
    data:=json_build_object('id',r.id,'business_id',r.business_id,'outlet_id',r.outlet_id,'record_json',r.record_json);member:=r.sync_actor_id;
   end if;
   perform private.sync_emit(r.business_id,r.outlet_id,kind,r.id,'upsert',data);
   perform private.sync_enqueue_member_reference(r.business_id,r.outlet_id,member);
  end loop;
 end loop;
 update private.sync_epoch set id=gen_random_uuid();
end $$;
revoke all on function private.sync_native_member(text,text),private.sync_native_member_identity(),private.sync_capture_native_payment(),private.sync_require_native_session(public.ulid) from public,anon,authenticated,service_role;
