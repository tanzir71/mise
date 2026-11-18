-- Only future receipts gain an admission identity. Existing receipts stay unknown.
alter table private.command_receipts add column admission_xid xid8;
alter table private.shop_command_receipts add column admission_xid xid8;
alter table private.command_receipts alter column admission_xid set default pg_current_xact_id();
alter table private.shop_command_receipts alter column admission_xid set default pg_current_xact_id();
create function private.sync_receipt_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_schema<>'private' or tg_table_name not in ('command_receipts','shop_command_receipts') then raise insufficient_privilege using message='Invalid receipt boundary.';end if;
 if tg_op='INSERT' then new.admission_xid:=pg_current_xact_id();
 elsif new.admission_xid is distinct from old.admission_xid or (row_to_json(new)::text is distinct from row_to_json(old)::text and (old.admission_xid is null or old.admission_xid<>pg_current_xact_id())) then raise insufficient_privilege using message='Keep the original accepted command receipt.';end if;
 return new;
end $$;
create trigger mise_receipt_identity before insert or update on private.command_receipts for each row execute function private.sync_receipt_identity();
create trigger mise_receipt_identity before insert or update on private.shop_command_receipts for each row execute function private.sync_receipt_identity();

create table private.sync_read_coverage (
 window_id public.ulid not null references private.sync_read_windows(id) on delete cascade,
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),content jsonb not null,
 primary key(window_id,request_hash)
);
alter table private.sync_read_coverage enable row level security;
alter table private.sync_read_coverage force row level security;
revoke all on private.sync_read_coverage from public,anon,authenticated,service_role;

-- Preserve membership-first locking and apply the same account check to every read.
create or replace function private.sync_read_actor(outlet public.ulid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare business public.ulid;actor public.ulid;role_value text;scope_version uuid;epoch uuid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This sync scope is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));perform private.operator_account_hash();
 select m.role into role_value from public.members m where m.business_id=business and m.id=actor;
 select v.version into scope_version from private.sync_scope_versions v where v.business_id=business and v.outlet_id=outlet for share;select e.id into epoch from private.sync_epoch e;
 if scope_version is null or epoch is null then raise object_not_in_prerequisite_state using message='Sync capture is unavailable.';end if;
 return jsonb_build_object('businessId',business,'outletId',outlet,'actorId',actor,'role',role_value,'scopeVersion',scope_version,'epoch',epoch,'accountHash',encode(sha256(uuid_send((select auth.uid()))),'hex'));
end $$;

create function private.read_sync_coverage(window_id public.ulid,outlet public.ulid,command_ids jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb;w private.sync_read_windows;legacy private.command_receipts;saved private.shop_command_receipts;
 fingerprint text;command public.ulid;kind text;admission xid8;state text;canonical text;
 batch_fingerprint text;cached jsonb;result jsonb;facts jsonb:='[]';at_ms public.utc_ms;
begin
 actor:=private.sync_read_actor(outlet);select * into w from private.sync_read_windows x where x.id=window_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if w.id is null or w.auth_user_id<>(select auth.uid()) or w.actor_id::text<>actor->>'actorId' or w.business_id::text<>actor->>'businessId' or w.outlet_id<>outlet then raise insufficient_privilege using message='This sync review is unavailable.';end if;
 if w.expires_at<=at_ms or w.epoch::text<>actor->>'epoch' or w.scope_version::text<>actor->>'scopeVersion' or w.actor_role<>actor->>'role' then raise sqlstate 'PT409' using message='Prepare a fresh sync review from its accepted cursor.';end if;
 if not w.done then raise invalid_parameter_value using message='Finish the original download before checking command coverage.';end if;
 if jsonb_typeof(command_ids) is distinct from 'array' or jsonb_array_length(command_ids) not between 1 and 128 then raise invalid_parameter_value using message='Keep one bounded original command batch.';end if;
 if exists(select 1 from jsonb_array_elements(command_ids) x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$') or (select count(distinct x) from jsonb_array_elements(command_ids) x)<>jsonb_array_length(command_ids) then raise invalid_parameter_value using message='Keep distinct original command identities.';end if;
 batch_fingerprint:=encode(sha256(convert_to(command_ids::text,'UTF8')),'hex');
 select c.content into cached from private.sync_read_coverage c where c.window_id=w.id and c.request_hash=batch_fingerprint;
 if found then if cached->'ids' is distinct from command_ids then raise unique_violation using message='Keep the original coverage source.';end if;return cached;end if;
 if (select count(*) from private.sync_read_coverage c where c.window_id=w.id)>=1024 then raise sqlstate 'PT429' using message='Keep pending coverage and prepare a fresh download.';end if;
 for command in select x::public.ulid from jsonb_array_elements_text(command_ids) x loop
  kind:=null;fingerprint:=null;admission:=null;state:='absent';
  select * into legacy from private.command_receipts r where r.id=command and r.business_id=w.business_id and r.outlet_id=w.outlet_id and r.actor_id=w.actor_id and r.auth_user_id=w.auth_user_id;
  if found then
   if exists(select 1 from private.shop_command_receipts r where r.id=command and r.business_id=w.business_id and r.outlet_id=w.outlet_id and r.actor_id=w.actor_id and r.auth_user_id=w.auth_user_id) then raise sqlstate 'PT409' using message='Review conflicting original command receipts.';end if;
   kind:=legacy.type;admission:=legacy.admission_xid;fingerprint:=legacy.request_hash;
   if kind in ('catalogue.availability','catalogue.undo') and legacy.occurred_at is not null then
    canonical:='{"id":'||to_json(legacy.id)::text||',"outletId":'||to_json(legacy.outlet_id)::text||',"occurredAt":'||legacy.occurred_at::text||',"type":'||to_json(kind)::text;
    if kind='catalogue.availability' then canonical:=canonical||',"itemId":'||to_json(legacy.resource_id)::text||',"available":'||legacy.requested_available::text||'}';
    else canonical:=canonical||',"undoOf":'||to_json(legacy.undo_of)::text||'}';end if;
    fingerprint:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
   end if;
  else
   select * into saved from private.shop_command_receipts r where r.id=command and r.business_id=w.business_id and r.outlet_id=w.outlet_id and r.actor_id=w.actor_id and r.auth_user_id=w.auth_user_id;
   if found then kind:=saved.type;admission:=saved.admission_xid;fingerprint:=saved.request_hash;end if;
  end if;
  if kind is not null then state:=case when admission is null or fingerprint is null then 'unknown' when pg_visible_in_snapshot(admission,w.current_snapshot) then 'visible' else 'later' end;end if;
  facts:=facts||jsonb_build_array(jsonb_build_object('id',command,'state',state,'type',kind,'requestHash',fingerprint));
 end loop;
 result:=actor||jsonb_build_object('v',1,'id',w.id,'ids',command_ids,'coverage',facts,'snapshot',w.current_snapshot::text);
 insert into private.sync_read_coverage values(w.id,batch_fingerprint,result);return result;
end $$;
revoke all on function private.sync_receipt_identity(),private.read_sync_coverage(public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.read_sync_coverage(public.ulid,public.ulid,jsonb) to authenticated;
create function public.read_sync_coverage(p_id public.ulid,p_outlet_id public.ulid,p_command_ids jsonb) returns jsonb
language sql security invoker set search_path='' as $$select private.read_sync_coverage(p_id,p_outlet_id,p_command_ids)$$;
revoke all on function public.read_sync_coverage(public.ulid,public.ulid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_sync_coverage(public.ulid,public.ulid,jsonb) to authenticated;
