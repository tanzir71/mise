-- Device/PIN quantity requests have their own authority and original receipts.
-- Owner/Auth tickets, catalogue, purchasing and financial paths stay separate.
create or replace function private.device_staff_permissions(d private.devices,m public.members) returns text[]
language plpgsql stable security invoker set search_path='' as $$
declare result text[]:='{}';profile jsonb;permission text;
begin
 if not m.active or m.business_id<>d.business_id then return result;end if;
 select s.profile into profile from private.staff_profiles s where s.business_id=m.business_id and s.outlet_id=d.outlet_id and s.member_id=m.id;
 if m.role='staff' or m.role='kitchen' and d.mode='kitchen' then
  result:=private.device_permissions(d.mode,m.role,m.permissions);
  if profile is not null then
   result:=array_remove(array_remove(result,'orders.acknowledge'),'orders.ready');
   if profile#>'{permissions,confirmOrders}'='true'::jsonb then
    foreach permission in array array['orders.read','orders.acknowledge','orders.ready'] loop
     if not m.permissions ? permission or m.permissions->permission='true'::jsonb then result:=array_append(result,permission);end if;
    end loop;
   end if;
   if not result @>array['orders.read'] then result:=array_remove(array_remove(result,'orders.acknowledge'),'orders.ready');end if;
   if profile#>'{permissions,updateStock}'='true'::jsonb and (not m.permissions ? 'stock.read' or m.permissions->'stock.read'='true'::jsonb) then
    result:=array_append(result,'stock.read');
    foreach permission in array array['stock.adjust','stock.undo'] loop
     if not m.permissions ? permission or m.permissions->permission='true'::jsonb then result:=array_append(result,permission);end if;
    end loop;
   end if;
  end if;
 end if;
 if m.role in('staff','kitchen','rider') and profile->'methods' ? 'order_phone' then result:=array_append(result,'staff.check-in');end if;
 return coalesce((select array_agg(distinct p order by p) from unnest(result) p),'{}');
end $$;

create table private.staff_stock_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 device_id public.ulid not null references private.devices(id),original_session_id public.ulid not null references private.device_sessions(id),
 member_id public.ulid not null,review_session_id public.ulid not null references private.device_sessions(id),
 kind text not null check(kind in('stock.adjust','stock.batch','stock.undo')),plan jsonb not null,facts jsonb not null,undo_receipt jsonb,
 occurred_at public.utc_ms not null,original_json text not null check(octet_length(original_json)<=52428800),
 source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),
 review_json text not null check(octet_length(review_json)<=67108864),review_hash text not null check(review_hash~'^[0-9a-f]{64}$'),
 token_hash bytea not null check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),foreign key(business_id,member_id) references public.members(business_id,id),
 check(id<>command_id and expires_at>created_at and expires_at<=created_at+60000)
);
create index staff_stock_ticket_device_idx on private.staff_stock_tickets(device_id,expires_at);
create index staff_stock_ticket_original_session_idx on private.staff_stock_tickets(original_session_id);
create index staff_stock_ticket_review_session_idx on private.staff_stock_tickets(review_session_id);
create index staff_stock_ticket_member_idx on private.staff_stock_tickets(business_id,member_id);
create index staff_stock_ticket_outlet_idx on private.staff_stock_tickets(business_id,outlet_id,command_id);
create table private.staff_stock_receipts (
 command_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 device_id public.ulid not null references private.devices(id),original_session_id public.ulid not null references private.device_sessions(id),
 member_id public.ulid not null,review_session_id public.ulid not null references private.device_sessions(id),
 source_hash text not null,original_json text not null,receipt jsonb not null,accepted_at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),foreign key(business_id,member_id) references public.members(business_id,id)
);
create index staff_stock_receipt_device_idx on private.staff_stock_receipts(device_id);
create index staff_stock_receipt_original_session_idx on private.staff_stock_receipts(original_session_id);
create index staff_stock_receipt_review_session_idx on private.staff_stock_receipts(review_session_id);
create index staff_stock_receipt_member_idx on private.staff_stock_receipts(business_id,member_id);
create index staff_stock_receipt_outlet_idx on private.staff_stock_receipts(business_id,outlet_id);
create table private.staff_stock_closures (
 command_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 device_id public.ulid not null references private.devices(id),original_session_id public.ulid not null references private.device_sessions(id),
 member_id public.ulid not null,review_session_id public.ulid not null references private.device_sessions(id),
 source_hash text not null,original_json text not null,closed_at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id),foreign key(business_id,member_id) references public.members(business_id,id)
);
create index staff_stock_closure_device_idx on private.staff_stock_closures(device_id);
create index staff_stock_closure_original_session_idx on private.staff_stock_closures(original_session_id);
create index staff_stock_closure_review_session_idx on private.staff_stock_closures(review_session_id);
create index staff_stock_closure_member_idx on private.staff_stock_closures(business_id,member_id);
create index staff_stock_closure_outlet_idx on private.staff_stock_closures(business_id,outlet_id);
create table private.staff_stock_reserved_ids (
 id public.ulid primary key,command_id public.ulid not null references private.staff_stock_closures(command_id)
);
create index staff_stock_reserved_command_idx on private.staff_stock_reserved_ids(command_id);
alter table private.staff_stock_tickets enable row level security;alter table private.staff_stock_tickets force row level security;
alter table private.staff_stock_receipts enable row level security;alter table private.staff_stock_receipts force row level security;
alter table private.staff_stock_closures enable row level security;alter table private.staff_stock_closures force row level security;
alter table private.staff_stock_reserved_ids enable row level security;alter table private.staff_stock_reserved_ids force row level security;
revoke all on private.staff_stock_tickets,private.staff_stock_receipts,private.staff_stock_closures,private.staff_stock_reserved_ids from public,anon,authenticated,service_role;

-- Every stock/event insertion, including owner imports, uses the same new-ID
-- lock as closure. An existing stock item remains usable; withdrawal creates
-- neither a movement nor a synthetic physical count.
create function private.reject_closed_staff_stock_identity() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 if tg_table_name='stock_items' and exists(select 1 from public.stock_items s where s.id=new.id) then return new;end if;
 if not pg_try_advisory_xact_lock(hashtextextended(new.id::text,71934)) then raise sqlstate 'PT409' using message='This stock identity is being reviewed. Keep the original request.';end if;
 if exists(select 1 from private.staff_stock_reserved_ids r where r.id=new.id) then raise sqlstate 'PT409' using message='Keep the original closed stock identities.';end if;
 return new;
end $$;
create trigger closed_staff_stock_item before insert on public.stock_items for each row execute function private.reject_closed_staff_stock_identity();
create trigger closed_staff_stock_move before insert on public.stock_moves for each row execute function private.reject_closed_staff_stock_identity();
create trigger closed_staff_stock_event before insert on public.events for each row execute function private.reject_closed_staff_stock_identity();

create function private.staff_stock_actor(device_secret text,session_secret text,scope jsonb,occurred public.utc_ms,write_kind text default null) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare a jsonb;at_ms bigint;
begin
 if scope is null or jsonb_typeof(scope)<>'object' or scope-array['businessId','outletId','deviceId','sessionId','memberId']<>'{}'::jsonb
  or not scope ?&array['businessId','outletId','deviceId','sessionId','memberId'] or exists(select 1 from jsonb_each(scope) e where jsonb_typeof(e.value) is distinct from 'string' or (e.value#>>'{}')!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$') then raise invalid_parameter_value using message='Keep the original stock scope.';end if;
 a:=private.read_device_session(device_secret,session_secret);at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if a is null or (a->>'expiresAt')::bigint<=at_ms or a->>'businessId'<>scope->>'businessId' or a->>'outletId'<>scope->>'outletId'
  or a->>'deviceId'<>scope->>'deviceId' or a->>'memberId'<>scope->>'memberId' or not exists(select 1 from private.devices d where d.id=a->>'deviceId' and d.revoked_at is null and d.expires_at>at_ms)
  or not exists(select 1 from private.device_sessions s where s.id=scope->>'sessionId' and s.device_id=a->>'deviceId' and s.member_id=a->>'memberId' and s.business_id=a->>'businessId' and s.outlet_id=a->>'outletId' and occurred>=s.created_at and occurred<s.expires_at) then return null;end if;
 if write_kind is not null and (not a->'permissions' ? 'stock.read' or not a->'permissions' ? (case when write_kind='stock.undo' then 'stock.undo' else 'stock.adjust' end)) then return null;end if;
 return a;
end $$;
create function private.lock_staff_stock_actor(scope jsonb,session_id public.ulid) returns void
language plpgsql volatile security invoker set search_path='' as $$
begin
 perform 1 from public.businesses b where b.id=scope->>'businessId' for share;
 perform 1 from public.outlets o where o.id=scope->>'outletId' and o.business_id=scope->>'businessId' for update;
 perform 1 from private.devices d where d.id=scope->>'deviceId' for share;
 perform 1 from private.device_sessions s where s.id in((scope->>'sessionId')::public.ulid,session_id) order by s.id for share;
 perform 1 from public.members m where m.business_id=scope->>'businessId' and m.id=scope->>'memberId' for share;
 perform 1 from private.staff_pins p where p.business_id=scope->>'businessId' and p.member_id=scope->>'memberId' for share;
 perform 1 from public.member_outlets x where x.business_id=scope->>'businessId' and x.outlet_id=scope->>'outletId' and x.member_id=scope->>'memberId' for share;
 perform 1 from private.staff_profiles p where p.business_id=scope->>'businessId' and p.outlet_id=scope->>'outletId' and p.member_id=scope->>'memberId' for share;
end $$;
create function private.admit_staff_stock_body(device_secret text,request_limit integer) returns jsonb
language plpgsql volatile security definer set search_path='' set lock_timeout='2s' as $$
declare d private.devices;at_ms bigint;window_ms bigint;n integer;
begin
 if device_secret is null or device_secret!~'^[A-Za-z0-9_-]{43}$' or request_limit is null or request_limit not between 1 and 60000 then return jsonb_build_object('state','missing');end if;
 select * into d from private.devices x where x.token_hash=sha256(convert_to(device_secret,'UTF8')) for share;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or d.revoked_at is not null or d.expires_at<=at_ms then return jsonb_build_object('state','missing');end if;
 window_ms:=at_ms-at_ms%60000;
 insert into private.staff_stock_budget as b values(d.id,window_ms,1) on conflict(device_id) do update set window_at=excluded.window_at,request_count=case when b.window_at=excluded.window_at then least(b.request_count+1,60001) else 1 end returning request_count into n;
 if n>request_limit then return jsonb_build_object('state','limited','retryAfter',greatest(1,ceil((window_ms+60000-at_ms)/1000.0)::integer));end if;
 return jsonb_build_object('state','allowed');
end $$;

-- Native JSON snapshots preserve literal NUL/surrogates. Optional domain fields
-- are omitted exactly as the existing cloud decoder omits SQL NULL columns.
create function private.staff_stock_item_snapshot(s public.stock_items) returns json
language sql immutable security invoker set search_path='' as $$
 select (rtrim(json_build_object('id',s.id,'outletId',s.outlet_id,'revision',s.revision,'name',s.name,'nameLocal',s.name_local,'unit',s.unit,'category',s.category,'aliases',s.aliases,
  'onHand',s.on_hand,'target',s.target,'packSize',s.pack_size,'lowAt',s.low_at,'eventId',s.event_id,'createdAt',s.created_at,'updatedAt',s.updated_at)::text,'}')
  ||case when s.active_key is not null then ',"activeKey":'||s.active_key else '' end
  ||case when s.supplier_id is not null then ',"supplierId":'||to_json(s.supplier_id)::text else '' end
  ||case when s.archived_at is not null then ',"archivedAt":'||s.archived_at::text else '' end
  ||case when s.last_counted_at is not null then ',"lastCountedAt":'||s.last_counted_at::text else '' end||'}')::json
$$;
create function private.staff_stock_move_snapshot(m public.stock_moves) returns json
language sql immutable security invoker set search_path='' as $$
 select (rtrim(json_build_object('id',m.id,'outletId',m.outlet_id,'stockItemId',m.stock_item_id,'revision',m.revision,'name',m.name,'unit',m.unit,'before',m.before_quantity,'after',m.after_quantity,
  'delta',m.delta,'reason',m.reason,'source',m.source,'note',m.note,'createdBy',m.created_by,'eventId',m.event_id,'createdAt',m.created_at,'updatedAt',m.updated_at)::text,'}')
  ||case when m.count_batch_id is not null then ',"countBatchId":'||to_json(m.count_batch_id)::text else '' end
  ||case when m.undo_of is not null then ',"undoOf":'||to_json(m.undo_of)::text else '' end||'}')::json
$$;

create function private.staff_stock_comparison(scope jsonb,kind text,plan jsonb,facts jsonb,undo_receipt jsonb,occurred public.utc_ms,at_ms public.utc_ms) returns json
language plpgsql volatile security invoker set search_path='' as $$
declare p jsonb;fact jsonb;s public.stock_items;m public.stock_moves;parent private.staff_stock_receipts;
 items json[]:='{}';lines jsonb:='[]';withdrawn jsonb:='[]';after_quantity numeric;position integer:=0;
begin
 if jsonb_typeof(facts) is distinct from 'array' or jsonb_array_length(facts)<>jsonb_array_length(plan->'rows') then raise invalid_parameter_value using message='Keep every original stock unit.';end if;
 if kind='stock.undo' then
  select * into m from public.stock_moves x where x.business_id=scope->>'businessId' and x.outlet_id=scope->>'outletId' and x.id=plan->>'undoMoveId';
  select * into parent from private.staff_stock_receipts x where x.member_id=scope->>'memberId' and x.business_id=scope->>'businessId' and x.outlet_id=scope->>'outletId' and x.receipt=undo_receipt;
  if m.id is null or parent.command_id is null or m.stock_item_id::text is distinct from plan#>>'{rows,0,itemId}' or m.created_by::text<>scope->>'memberId' or m.undo_of is not null or parent.receipt#>>'{command,type}'='stock.undo'
   or not exists(select 1 from jsonb_array_elements(parent.receipt#>'{command,results}') r where r->>'moveId'=m.id::text and r->>'eventId'=m.event_id::text and r->>'stockItemId'=m.stock_item_id::text)
   or at_ms<m.created_at or at_ms-m.created_at>86400000 or occurred<m.created_at or exists(select 1 from public.stock_moves u where u.business_id=m.business_id and u.outlet_id=m.outlet_id and u.undo_of=m.id)
   or exists(select 1 from public.stock_moves c where c.business_id=m.business_id and c.outlet_id=m.outlet_id and c.stock_item_id=m.stock_item_id and c.reason='count' and c.revision>m.revision and not exists(select 1 from public.stock_moves u where u.business_id=c.business_id and u.outlet_id=c.outlet_id and u.undo_of=c.id)) then raise sqlstate 'PT409' using message='Undo only your own original movement, once within 24 hours and before a later count.';end if;
 elsif undo_receipt is not null then raise invalid_parameter_value using message='Choose a quantity request.';end if;
 for p in select x from jsonb_array_elements(plan->'rows') x loop
  fact:=facts->position;position:=position+1;
  if jsonb_typeof(fact) is distinct from 'object' or fact-array['itemId','unitHash','createdAt','noteJson']<>'{}'::jsonb or not fact ?&array['itemId','unitHash','createdAt','noteJson'] or fact->>'itemId'<>p->>'itemId' or jsonb_typeof(fact->'unitHash') is distinct from 'string' or fact->>'unitHash'!~'^[0-9a-f]{64}$' or jsonb_typeof(fact->'createdAt') is distinct from 'number' or jsonb_typeof(fact->'noteJson') is distinct from 'string'
   or octet_length(fact->>'noteJson')>6002 or json_typeof((fact->>'noteJson')::json) is distinct from 'string' then raise invalid_parameter_value using message='Keep the original stock unit and note.';end if;
  select * into s from public.stock_items x where x.business_id=scope->>'businessId' and x.outlet_id=scope->>'outletId' and x.id=p->>'itemId';
  if s.id is null or s.archived_at is not null or s.revision<(p->>'revision')::bigint or s.revision>=9007199254740991 or encode(sha256(convert_to(s.unit::text,'UTF8')),'hex') is distinct from fact->>'unitHash' or s.created_at::text is distinct from fact->>'createdAt' then raise sqlstate 'PT409' using message='Review the current active stock and its original unit.';end if;
  after_quantity:=case p->>'reason' when 'count' then (p->>'quantity')::numeric when 'received' then s.on_hand+(p->>'quantity')::numeric when 'used' then s.on_hand-(p->>'quantity')::numeric when 'waste' then s.on_hand-(p->>'quantity')::numeric when 'undo' then s.on_hand-m.delta end;
  if after_quantity is null or after_quantity<0 or after_quantity>1000000000 then raise sqlstate 'PT409' using message='Review the available stock quantity.';end if;
  items:=array_append(items,json_build_object('id',s.id,'outletId',s.outlet_id,'revision',s.revision,'name',s.name,'nameLocal',s.name_local,'unit',s.unit,'category',s.category,'aliases',s.aliases,'onHand',s.on_hand,'target',s.target,'packSize',s.pack_size,'lowAt',s.low_at,'lastCountedAt',s.last_counted_at,'eventId',s.event_id,'createdAt',s.created_at,'updatedAt',s.updated_at));
  lines:=lines||jsonb_build_array(jsonb_build_object('itemId',s.id,'revision',s.revision,'before',s.on_hand,'after',after_quantity,'lastCountedAt',s.last_counted_at));
  if exists(select 1 from private.stock_command_resolutions r where r.position=private.stock_review_last_movement_resolution(s.business_id,s.outlet_id,s.id) and r.outcome='withdrawn') then withdrawn:=withdrawn||to_jsonb(s.id);end if;
 end loop;
 return json_build_object('items',array_to_json(items),'lines',lines,'withdrawn',withdrawn);
end $$;

-- A quantity snapshot also includes actual Team/member revisions and the
-- latest owner movement withdrawal. No->Yes cannot revive an older review,
-- and a new withdrawal cannot bypass the comparison's explicit warning.
create function private.staff_stock_snapshot(scope jsonb,plan jsonb) returns bytea
language sql volatile security invoker set search_path='' as $$
 select sha256(convert_to(private.stock_write_context((scope->>'businessId')::public.ulid,(scope->>'outletId')::public.ulid,plan)::text||E'\n'
  ||coalesce((select row_to_json(m)::text from public.members m where m.business_id=scope->>'businessId' and m.id=scope->>'memberId'),'null')||E'\n'
  ||coalesce((select row_to_json(p)::text from private.staff_profiles p where p.business_id=scope->>'businessId' and p.outlet_id=scope->>'outletId' and p.member_id=scope->>'memberId'),'null')||E'\n'
  ||coalesce((select jsonb_agg(jsonb_build_array(r->>'itemId',private.stock_review_last_movement_resolution((scope->>'businessId')::public.ulid,(scope->>'outletId')::public.ulid,(r->>'itemId')::public.ulid)) order by r->>'itemId')::text from jsonb_array_elements(plan->'rows') r),'[]'),'UTF8'))
$$;

create function private.visit_staff_stock_original(device_secret text,session_secret text,operation text,scope jsonb,command_id public.ulid,kind text,plan jsonb,facts jsonb,undo_receipt jsonb,occurred public.utc_ms,original_json text,source_hash text,ticket_id public.ulid default null) returns json
language plpgsql volatile security definer set search_path='' set lock_timeout='2s' as $$
declare actor jsonb;accepted private.staff_stock_receipts;closed private.staff_stock_closures;t private.staff_stock_tickets;
 at_ms public.utc_ms;expires public.utc_ms;secret text;comparison json;review_value json;outlet_name json;allocated public.ulid[];identity public.ulid;lookup jsonb;
begin
 if operation is null or operation not in('prepare','inspect','close') or command_id is null or kind is null or kind not in('stock.adjust','stock.batch','stock.undo') or not private.stock_review_plan_valid(kind,plan,command_id)
  or plan->>'supplierId' is not null or plan->>'nameKey' is not null
  or original_json is null or octet_length(original_json)>52428800 or source_hash is null or source_hash!~'^[0-9a-f]{64}$' or encode(sha256(convert_to(original_json,'UTF8')),'hex')<>source_hash or occurred is null then raise invalid_parameter_value using message='Keep the complete original stock request.';end if;
 actor:=private.staff_stock_actor(device_secret,session_secret,scope,occurred);if actor is null then return json_build_object('state','missing');end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 perform private.lock_staff_stock_actor(scope,(actor->>'sessionId')::public.ulid);
 actor:=private.staff_stock_actor(device_secret,session_secret,scope,occurred);if actor is null then return json_build_object('state','missing');end if;
 select * into accepted from private.staff_stock_receipts r where r.command_id=visit_staff_stock_original.command_id;
 select * into closed from private.staff_stock_closures c where c.command_id=visit_staff_stock_original.command_id;
 if accepted.command_id is not null or closed.command_id is not null then
  lookup:=case when accepted.command_id is not null then to_jsonb(accepted)-'original_json'-'receipt' else to_jsonb(closed)-'original_json' end;
  if lookup->>'business_id'<>scope->>'businessId' or lookup->>'outlet_id'<>scope->>'outletId' or lookup->>'device_id'<>scope->>'deviceId' or lookup->>'member_id'<>scope->>'memberId' or lookup->>'original_session_id'<>scope->>'sessionId' or lookup->>'source_hash'<>source_hash
   or coalesce(accepted.original_json,closed.original_json)<>original_json then raise unique_violation using message='Keep this member’s exact original stock request.';end if;
  return json_build_object('v',1,'id',command_id,'state',case when accepted.command_id is not null then 'applied' else 'closed' end,'intentHash',source_hash,'receipt',accepted.receipt,'at',coalesce(accepted.accepted_at,closed.closed_at));
 end if;
 if exists(select 1 from private.staff_stock_tickets x where x.command_id=visit_staff_stock_original.command_id and (x.source_hash<>visit_staff_stock_original.source_hash or x.original_json<>visit_staff_stock_original.original_json or x.device_id::text<>scope->>'deviceId' or x.member_id::text<>scope->>'memberId' or x.original_session_id::text<>scope->>'sessionId')) then raise unique_violation using message='Keep the exact original stock request.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if operation='inspect' then return json_build_object('v',1,'id',command_id,'state','pending','intentHash',source_hash,'receipt',null,'at',null);end if;
 allocated:=private.stock_review_new_ids(kind,plan,command_id);
 foreach identity in array (select array_agg(x order by x) from unnest(allocated) x) loop perform pg_advisory_xact_lock(hashtextextended(identity::text,71934));end loop;
 if exists(select 1 from private.staff_stock_reserved_ids r where r.id=any(allocated)) then raise unique_violation using message='Keep the closed stock identities.';end if;
 perform private.assert_stock_resolution_access(command_id,kind,plan);
 if exists(select 1 from public.events e where e.id=any(allocated)) or exists(select 1 from public.stock_moves m where m.id=any(allocated)) or exists(select 1 from public.stock_items s where s.id=any(allocated)) then raise unique_violation using message='Keep distinct stock identities.';end if;
 if operation='close' then
  insert into private.staff_stock_closures values(command_id,(scope->>'businessId')::public.ulid,(scope->>'outletId')::public.ulid,(scope->>'deviceId')::public.ulid,(scope->>'sessionId')::public.ulid,(scope->>'memberId')::public.ulid,(actor->>'sessionId')::public.ulid,source_hash,original_json,at_ms);
  insert into private.staff_stock_reserved_ids select x,command_id from unnest(allocated) x;
  delete from private.staff_stock_tickets x where x.command_id=visit_staff_stock_original.command_id;
  return json_build_object('v',1,'id',command_id,'state','closed','intentHash',source_hash,'receipt',null,'at',at_ms);
 end if;
 actor:=private.staff_stock_actor(device_secret,session_secret,scope,occurred,kind);if actor is null then return json_build_object('state','missing');end if;
 if ticket_id is null or ticket_id=any(allocated) or occurred>at_ms+300000 then raise invalid_parameter_value using message='Review the stock identity and device clock.';end if;
 delete from private.staff_stock_tickets x where x.device_id::text=scope->>'deviceId' and x.expires_at<=at_ms;
 delete from private.staff_stock_tickets x where x.command_id=visit_staff_stock_original.command_id;
 if (select count(*) from private.staff_stock_tickets x where x.device_id::text=scope->>'deviceId')>=100 then raise sqlstate 'PT429' using message='Finish saved stock reviews first.';end if;
 comparison:=private.staff_stock_comparison(scope,kind,plan,facts,undo_receipt,occurred,at_ms);
 expires:=least(at_ms+60000,(actor->>'expiresAt')::bigint,(select d.expires_at from private.devices d where d.id=scope->>'deviceId'));
 if expires<=floor(extract(epoch from clock_timestamp())*1000)::bigint then return json_build_object('state','missing');end if;
 -- JSON concatenation keeps literal source opaque; only safe numeric/ID arrays
 -- are decoded. No whole source/label is cast to JSONB.
 review_value:=('{'||'"v":1,"id":'||to_json(ticket_id)::text||',"intentHash":'||to_json(source_hash)::text||',"access":'||actor::text||',"at":'||at_ms::text||',"expiresAt":'||expires::text||','||substr(comparison::text,2))::json;
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.staff_stock_tickets values(ticket_id,command_id,(scope->>'businessId')::public.ulid,(scope->>'outletId')::public.ulid,(scope->>'deviceId')::public.ulid,(scope->>'sessionId')::public.ulid,(scope->>'memberId')::public.ulid,(actor->>'sessionId')::public.ulid,kind,plan,facts,undo_receipt,occurred,original_json,source_hash,private.staff_stock_snapshot(scope,plan),review_value::text,encode(sha256(convert_to(review_value::text,'UTF8')),'hex'),sha256(convert_to(secret,'UTF8')),at_ms,expires);
 return json_build_object('state','review','review',review_value,'reviewHash',encode(sha256(convert_to(review_value::text,'UTF8')),'hex'),'token',secret);
end $$;

create function private.finish_staff_stock_action(device_secret text,session_secret text,ticket_id public.ulid,secret text,review_hash text,source_hash text) returns json
language plpgsql volatile security definer set search_path='' set lock_timeout='2s' as $$
declare t private.staff_stock_tickets;a jsonb;scope jsonb;at_ms public.utc_ms;comparison json;line jsonb;p jsonb;fact jsonb;
 before public.stock_items;after_item public.stock_items;movement public.stock_moves;original public.stock_moves;before_json json;after_json json;
 results jsonb:='[]';reviewed jsonb;receipt_value jsonb;position integer:=0;counted public.utc_ms;note_value json;command_name text;identity public.ulid;
begin
 if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' or review_hash is null or source_hash is null then raise invalid_parameter_value using message='Confirm the current stock review.';end if;
 select * into t from private.staff_stock_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) and x.review_hash=finish_staff_stock_action.review_hash and x.source_hash=finish_staff_stock_action.source_hash;
 if not found then raise sqlstate 'PT409' using message='The stock review expired or changed. Keep the original request.';end if;
 scope:=jsonb_build_object('businessId',t.business_id,'outletId',t.outlet_id,'deviceId',t.device_id,'sessionId',t.original_session_id,'memberId',t.member_id);
 a:=private.staff_stock_actor(device_secret,session_secret,scope,t.occurred_at,t.kind);if a is null then return json_build_object('state','missing');end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.lock_staff_stock_actor(scope,(a->>'sessionId')::public.ulid);
 a:=private.staff_stock_actor(device_secret,session_secret,scope,t.occurred_at,t.kind);at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if a is null then return json_build_object('state','missing');end if;
 if a->>'sessionId'<>t.review_session_id::text then raise sqlstate 'PT409' using message='Review again with your current PIN.';end if;
 select * into t from private.staff_stock_tickets x where x.id=ticket_id for update;
 if not found then raise sqlstate 'PT409' using message='The stock review expired or was closed.';end if;
 foreach identity in array (select array_agg(x order by x) from unnest(private.stock_review_new_ids(t.kind,t.plan,t.command_id)) x) loop perform pg_advisory_xact_lock(hashtextextended(identity::text,71934));end loop;
 if t.expires_at<=at_ms or exists(select 1 from private.staff_stock_closures c where c.command_id=t.command_id)
  or exists(select 1 from private.staff_stock_reserved_ids r where r.id=any(private.stock_review_new_ids(t.kind,t.plan,t.command_id))) then raise sqlstate 'PT409' using message='The stock review expired or was closed.';end if;
 perform private.assert_stock_resolution_access(t.command_id,t.kind,t.plan);
 if private.staff_stock_snapshot(scope,t.plan)<>t.snapshot_hash then raise sqlstate 'PT409' using message='Stock or access changed after this comparison. Review it again.';end if;
 comparison:=private.staff_stock_comparison(scope,t.kind,t.plan,t.facts,t.undo_receipt,t.occurred_at,at_ms);
 -- Extract only the safe line array. PostgreSQL JSON accessors can decode
 -- unrelated literal strings, so build it independently from actual rows.
 select jsonb_agg(jsonb_build_object('itemId',s.id,'revision',s.revision,'before',s.on_hand,
  'after',case p.value->>'reason' when 'count' then (p.value->>'quantity')::numeric when 'received' then s.on_hand+(p.value->>'quantity')::numeric when 'used' then s.on_hand-(p.value->>'quantity')::numeric when 'waste' then s.on_hand-(p.value->>'quantity')::numeric when 'undo' then s.on_hand-(select m.delta from public.stock_moves m where m.id=t.plan->>'undoMoveId') end,'lastCountedAt',s.last_counted_at) order by p.ordinality) into reviewed
  from jsonb_array_elements(t.plan->'rows') with ordinality p join public.stock_items s on s.id=p.value->>'itemId' and s.business_id=t.business_id and s.outlet_id=t.outlet_id;
 if t.kind='stock.undo' then select * into original from public.stock_moves m where m.id=t.plan->>'undoMoveId' and m.business_id=t.business_id and m.outlet_id=t.outlet_id;end if;
 for p in select x from jsonb_array_elements(t.plan->'rows') x loop
  fact:=t.facts->position;line:=reviewed->position;position:=position+1;
  select * into before from public.stock_items s where s.id=p->>'itemId' and s.business_id=t.business_id and s.outlet_id=t.outlet_id for update;
  before_json:=private.staff_stock_item_snapshot(before);counted:=before.last_counted_at;
  if p->>'reason'='count' then counted:=t.occurred_at;
  elsif t.kind='stock.undo' then select m.created_at into counted from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.stock_item_id=before.id and m.reason='count' and m.id<>original.id and not exists(select 1 from public.stock_moves u where u.business_id=m.business_id and u.outlet_id=m.outlet_id and u.undo_of=m.id) order by m.revision desc limit 1;end if;
  update public.stock_items set on_hand=(line->>'after')::public.stock_quantity,revision=before.revision+1,last_counted_at=counted,event_id=(p->>'eventId')::public.ulid,updated_at=greatest(t.created_at,t.occurred_at,before.created_at) where id=before.id returning * into after_item;
  note_value:=case when t.kind='stock.undo' then to_json('Undo '||original.reason) else (fact->>'noteJson')::json end;
  insert into public.stock_moves(id,business_id,outlet_id,created_at,updated_at,stock_item_id,revision,name,unit,before_quantity,after_quantity,delta,reason,source,note,created_by,event_id,count_batch_id,undo_of)
   values((p->>'moveId')::public.ulid,t.business_id,t.outlet_id,t.occurred_at,greatest(t.created_at,t.occurred_at),before.id,after_item.revision,before.name,before.unit,before.on_hand,after_item.on_hand,after_item.on_hand-before.on_hand,p->>'reason',p->>'source',note_value,t.member_id,(p->>'eventId')::public.ulid,case when t.kind='stock.undo' then original.count_batch_id else (t.plan->>'batchId')::public.ulid end,(t.plan->>'undoMoveId')::public.ulid) returning * into movement;
  after_json:=json_build_object('item',private.staff_stock_item_snapshot(after_item),'move',private.staff_stock_move_snapshot(movement));command_name:=case when t.kind='stock.undo' then 'stock.undo' else 'stock.'||(p->>'reason') end;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,undo_of,stock_item_id,stock_revision)
   values((p->>'eventId')::public.ulid,t.business_id,t.outlet_id,'member',t.member_id,command_name,before_json,after_json,t.created_at,case when t.kind='stock.undo' then original.event_id else null end,before.id,after_item.revision);
  results:=results||jsonb_build_array(jsonb_build_object('stockItemId',before.id,'eventId',p->>'eventId','moveId',p->>'moveId','revision',after_item.revision,'onHand',after_item.on_hand,'updatedAt',after_item.updated_at));
 end loop;
 -- Real clock is rechecked after all records, before commit. Expiry rolls the
 -- whole transaction back, including every item, movement, audit and receipt.
 if private.staff_stock_actor(device_secret,session_secret,scope,t.occurred_at,t.kind) is null or t.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then raise sqlstate 'PT409' using message='This review expired before confirmation.';end if;
 receipt_value:=jsonb_build_object('v',1,'type','staff.stock','businessId',t.business_id,'outletId',t.outlet_id,'deviceId',t.device_id,'sessionId',t.original_session_id,'memberId',t.member_id,'intentHash',t.source_hash,'reviewHash',t.review_hash,'reviewed',reviewed,
  'command',jsonb_build_object('id',t.command_id,'type',t.kind,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'at',t.created_at,'batchId',t.plan->>'batchId','undoOf',t.plan->>'undoMoveId','results',results));
 insert into private.staff_stock_receipts values(t.command_id,t.business_id,t.outlet_id,t.device_id,t.original_session_id,t.member_id,t.review_session_id,t.source_hash,t.original_json,receipt_value,t.created_at);
 delete from private.staff_stock_tickets x where x.command_id=t.command_id;
 return json_build_object('v',1,'id',t.command_id,'state','applied','intentHash',t.source_hash,'receipt',receipt_value,'at',t.created_at);
end $$;

create function public.admit_staff_stock_body(p_device_token text,p_request_limit integer) returns jsonb language sql security invoker set search_path='' as $$select private.admit_staff_stock_body(p_device_token,p_request_limit)$$;
create function public.visit_staff_stock_original(p_device_token text,p_session_token text,p_operation text,p_scope jsonb,p_command_id public.ulid,p_kind text,p_plan jsonb,p_facts jsonb,p_undo_receipt jsonb,p_occurred_at public.utc_ms,p_original_json text,p_source_hash text,p_ticket_id public.ulid default null) returns json language sql security invoker set search_path='' as $$select private.visit_staff_stock_original(p_device_token,p_session_token,p_operation,p_scope,p_command_id,p_kind,p_plan,p_facts,p_undo_receipt,p_occurred_at,p_original_json,p_source_hash,p_ticket_id)$$;
create function public.finish_staff_stock_action(p_device_token text,p_session_token text,p_ticket_id public.ulid,p_token text,p_review_hash text,p_source_hash text) returns json language sql security invoker set search_path='' as $$select private.finish_staff_stock_action(p_device_token,p_session_token,p_ticket_id,p_token,p_review_hash,p_source_hash)$$;
revoke all on function private.device_staff_permissions(private.devices,public.members),private.reject_closed_staff_stock_identity(),private.staff_stock_actor(text,text,jsonb,public.utc_ms,text),private.lock_staff_stock_actor(jsonb,public.ulid),private.staff_stock_item_snapshot(public.stock_items),private.staff_stock_move_snapshot(public.stock_moves),private.staff_stock_comparison(jsonb,text,jsonb,jsonb,jsonb,public.utc_ms,public.utc_ms),private.staff_stock_snapshot(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.admit_staff_stock_body(text,integer),private.visit_staff_stock_original(text,text,text,jsonb,public.ulid,text,jsonb,jsonb,jsonb,public.utc_ms,text,text,public.ulid),private.finish_staff_stock_action(text,text,public.ulid,text,text,text),public.admit_staff_stock_body(text,integer),public.visit_staff_stock_original(text,text,text,jsonb,public.ulid,text,jsonb,jsonb,jsonb,public.utc_ms,text,text,public.ulid),public.finish_staff_stock_action(text,text,public.ulid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function private.admit_staff_stock_body(text,integer),private.visit_staff_stock_original(text,text,text,jsonb,public.ulid,text,jsonb,jsonb,jsonb,public.utc_ms,text,text,public.ulid),private.finish_staff_stock_action(text,text,public.ulid,text,text,text),public.admit_staff_stock_body(text,integer),public.visit_staff_stock_original(text,text,text,jsonb,public.ulid,text,jsonb,jsonb,jsonb,public.utc_ms,text,text,public.ulid),public.finish_staff_stock_action(text,text,public.ulid,text,text,text) to service_role;
