-- Scoped stock commands retain device IDs and physical occurrence times.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
  'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch'));
create table private.stock_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch')),
 plan jsonb not null,occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),
 created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.stock_write_tickets enable row level security;alter table private.stock_write_tickets force row level security;
revoke all on private.stock_write_tickets from public,anon,authenticated,service_role;
create index stock_write_tickets_actor_idx on private.stock_write_tickets(auth_user_id,expires_at);
create index stock_write_tickets_command_idx on private.stock_write_tickets(command_id);

-- At most two latest active physical counts per selected item are required for
-- rebase barriers and restoring lastCountedAt. Include the undo target/reversal.
-- Historical notes and labels never need to cross this arithmetic boundary.
create function private.stock_write_context(business public.ulid,outlet public.ulid,plan jsonb) returns json
language sql volatile security invoker set search_path='' as $$
 with targets as (select x->>'itemId' id from jsonb_array_elements(plan->'rows') x),
 latest_counts as (select c.id from targets t cross join lateral
  (select m.id from public.stock_moves m where m.business_id=business and m.outlet_id=outlet and m.stock_item_id=t.id and m.reason='count' and m.undo_of is null
   and not exists(select 1 from public.stock_moves u where u.business_id=business and u.outlet_id=outlet and u.undo_of=m.id)
   order by m.revision desc limit 2) c)
 select json_build_object(
  'business',(select row_to_json(b) from public.businesses b where b.id=business),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'items',(select coalesce(json_agg(row_to_json(s) order by s.id),'[]') from public.stock_items s where s.business_id=business and s.outlet_id=outlet and (s.id in(select id from targets) or s.active_key=plan->>'nameKey')),
  'suppliers',(select coalesce(json_agg(row_to_json(s) order by s.id),'[]') from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=plan->>'supplierId'),
  'moves',(select coalesce(json_agg(row_to_json(p) order by p.id),'[]') from
   (select m.id,m.business_id,m.outlet_id,m.created_at,m.updated_at,m.stock_item_id,m.revision,m.before_quantity,m.after_quantity,m.delta,m.reason,m.source,m.created_by,m.event_id,m.count_batch_id,m.undo_of,
     case when m.id=plan->>'undoMoveId' then m.name else '""'::json end name,
     case when m.id=plan->>'undoMoveId' then m.unit else '""'::json end unit,
     case when m.id=plan->>'undoMoveId' then m.note else '""'::json end note
    from public.stock_moves m where m.business_id=business and m.outlet_id=outlet and
     (m.id=plan->>'undoMoveId' or m.undo_of=plan->>'undoMoveId' or m.id in(select id from latest_counts))) p))
$$;

-- This check runs before the Edge Function consumes a larger batch body.
create function private.admit_stock_batch(outlet public.ulid) returns boolean language plpgsql security definer set search_path='' as $$
declare business public.ulid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 perform private.public_link_actor(business,outlet);return true;
end $$;

create function private.prepare_stock_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;r jsonb;context json;secret text;at_ms public.utc_ms;n int;created_ids int;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This stock action is unavailable.';end if;
 if command_id is null or ticket_id is null or outlet is null or occurred is null or kind is null or kind not in ('stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch')
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or jsonb_typeof(ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(ids))<>5
  or exists(select 1 from jsonb_object_keys(ids) k where k not in ('rows','batchId','undoMoveId','supplierId','nameKey'))
  or jsonb_typeof(ids->'rows') is distinct from 'array' or jsonb_array_length(ids->'rows') not between 1 and 1000
  or exists(select 1 from jsonb_each(ids) e where e.key not in ('rows','nameKey') and e.value<>'null' and (jsonb_typeof(e.value)<>'string' or e.value#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
  or (ids->>'nameKey' is not null and (jsonb_typeof(ids->'nameKey')<>'string' or octet_length(ids->>'nameKey')>16000)) then raise invalid_parameter_value using message='Check the stock intent.';end if;
 n:=jsonb_array_length(ids->'rows');
 if (kind<>'stock.batch' and n<>1) or ((kind='stock.undo')<>(ids->>'undoMoveId' is not null))
  or (kind<>'stock.batch' and ids->>'batchId' is not null) or (kind not in ('stock.create','stock.update') and (ids->>'nameKey' is not null or ids->>'supplierId' is not null))
  or ids->'rows'->0->>'eventId' is distinct from command_id::text then raise invalid_parameter_value using message='Check the stock plan.';end if;
 for r in select x from jsonb_array_elements(ids->'rows') x loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>7 or exists(select 1 from jsonb_object_keys(r) k where k not in ('itemId','revision','eventId','moveId','reason','quantity','source'))
   or exists(select 1 from unnest(array['itemId','eventId']) k where r->>k is null or jsonb_typeof(r->k)<>'string' or r->>k!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
   or (r->>'moveId' is not null and (jsonb_typeof(r->'moveId')<>'string' or r->>'moveId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
   or jsonb_typeof(r->'revision')<>'number' or (r->>'revision')::numeric<>trunc((r->>'revision')::numeric) or (r->>'revision')::numeric not between (case when kind='stock.create' then 0 else 1 end) and 9007199254740990
   or (kind='stock.create' and (r->>'revision')::numeric<>0)
   or (r->>'moveId' is null and (kind not in ('stock.update','stock.archive','stock.restore') or r->>'reason' is not null or r->>'quantity' is not null or r->>'source' is not null))
   or (r->>'moveId' is not null and (r->>'reason' is null or r->>'reason' not in ('count','used','received','waste','undo') or r->>'source' is null or r->>'source' not in ('manual','quick_update','count')))
   or (kind in ('stock.archive','stock.restore') and r->>'moveId' is not null)
   or (kind in ('stock.create','stock.update') and r->>'moveId' is not null and (r->>'reason'<>'count' or r->>'source'<>'manual'))
   or (kind='stock.undo' and (r->>'moveId' is null or r->>'reason'<>'undo' or r->>'source'<>'manual' or r->>'quantity' is not null))
   or (kind<>'stock.undo' and r->>'reason'='undo')
   or (kind in ('stock.adjust','stock.batch','stock.create') and r->>'moveId' is null)
   or (r->>'moveId' is not null and kind<>'stock.undo' and (jsonb_typeof(r->'quantity') is distinct from 'number' or (r->>'quantity')::public.stock_quantity<0 or (r->>'reason'<>'count' and (r->>'quantity')::numeric=0)))
   or (ids->>'batchId' is not null and (r->>'reason'<>'count' or r->>'source'<>'count')) then raise invalid_parameter_value using message='Check the stock row plan.';end if;
 end loop;
 select count(*) into created_ids from (select x->>'eventId' id from jsonb_array_elements(ids->'rows') x union all select x->>'moveId' from jsonb_array_elements(ids->'rows') x where x->>'moveId' is not null union all select ids->>'batchId' where ids->>'batchId' is not null) a;
 if (select count(distinct x->>'itemId') from jsonb_array_elements(ids->'rows') x)<>n
  or created_ids<>(select count(distinct id) from (select x->>'eventId' id from jsonb_array_elements(ids->'rows') x union all select x->>'moveId' from jsonb_array_elements(ids->'rows') x where x->>'moveId' is not null union all select ids->>'batchId' where ids->>'batchId' is not null) a)
  or exists(select 1 from jsonb_array_elements(ids->'rows') a join jsonb_array_elements(ids->'rows') b on a->>'itemId' in (b->>'eventId',b->>'moveId'))
  or exists(select 1 from jsonb_array_elements(ids->'rows') a where a->>'itemId'=ids->>'batchId' or ids->>'undoMoveId' in(a->>'eventId',a->>'moveId')) then raise invalid_parameter_value using message='Use distinct stock record IDs.';end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 select * into old from private.shop_command_receipts c where c.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This change is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='This command ID was already used.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 if exists(select 1 from public.events e where e.id=command_id) then raise unique_violation using message='This command ID was already used.';end if;
 if kind='stock.create' then
  if exists(select 1 from public.stock_items s where s.id=ids->'rows'->0->>'itemId') then raise unique_violation using message='This stock ID already exists.';end if;
 else
  if (select count(*) from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.id in(select x->>'itemId' from jsonb_array_elements(ids->'rows') x))<>n then raise insufficient_privilege using message='This stock is unavailable.';end if;
 end if;
 if ids->>'supplierId' is not null and not exists(select 1 from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=ids->>'supplierId') then raise insufficient_privilege using message='This supplier is unavailable.';end if;
 if kind='stock.undo' and not exists(select 1 from public.stock_moves m where m.business_id=business and m.outlet_id=outlet and m.stock_item_id=ids->'rows'->0->>'itemId' and m.id=ids->>'undoMoveId') then raise insufficient_privilege using message='This movement is unavailable.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 delete from private.stock_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.stock_write_tickets t where t.command_id=prepare_stock_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>ids)) then raise unique_violation using message='Keep the original stock intent.';end if;
 delete from private.stock_write_tickets t where t.command_id=prepare_stock_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.stock_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.stock_write_context(business,outlet,ids);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.stock_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids,occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create function private.finish_stock_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.stock_write_tickets;r jsonb;v jsonb;p jsonb;item_values jsonb;table_name text;allowed jsonb;keys text;casts text;updates text;
 old_items public.stock_items[];before public.stock_items;original public.stock_moves;at_ms public.utc_ms;expected_quantity numeric;expected_counted bigint;expected_command text;
 n int;item_count int;move_count int;event_count int;metadata jsonb;plans jsonb;item_records jsonb;count_barriers jsonb;
 specs jsonb:='{"stock_items":["id","created_at","updated_at","outlet_id","revision","name","name_local","active_key","unit","category","aliases","on_hand","target","pack_size","low_at","supplier_id","archived_at","last_counted_at","event_id","business_id"],"stock_moves":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","stock_item_id","name","unit","before_quantity","after_quantity","delta","reason","source","note","count_batch_id","undo_of","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare this stock change again.';end if;
 select * into t from private.stock_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Prepare this stock change again.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 select * into t from private.stock_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Prepare this stock change again.';end if;
 if sha256(convert_to(private.stock_write_context(t.business_id,t.outlet_id,t.plan)::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The stock changed. Prepare again.',detail='stock_snapshot_changed';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
 select jsonb_object_agg(p.value->>'itemId',p.value||jsonb_build_object('_i',p.ordinality)) into plans from jsonb_array_elements(t.plan->'rows') with ordinality p;
 select array_agg(s order by p.ordinality) into old_items from jsonb_array_elements(t.plan->'rows') with ordinality p join public.stock_items s on s.business_id=t.business_id and s.outlet_id=t.outlet_id and s.id=p.value->>'itemId';
 select jsonb_object_agg(x.stock_item_id,x.revision) into count_barriers from
  (select m.stock_item_id,max(m.revision) revision from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.reason='count' and plans ? m.stock_item_id::text
   and not exists(select 1 from public.stock_moves u where u.business_id=t.business_id and u.outlet_id=t.outlet_id and u.undo_of=m.id) group by m.stock_item_id) x;
 if t.type='stock.undo' then
  select * into original from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.id=t.plan->>'undoMoveId';
  if original.id is null or original.undo_of is not null or at_ms<original.created_at or at_ms-original.created_at>86400000 or t.occurred_at<original.created_at
   or exists(select 1 from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.undo_of=original.id)
   or exists(select 1 from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.stock_item_id=original.stock_item_id and m.reason='count' and m.revision>original.revision
     and not exists(select 1 from public.stock_moves u where u.business_id=t.business_id and u.outlet_id=t.outlet_id and u.undo_of=m.id)) then raise sqlstate 'PT409' using message='Undo once within 24 hours, before a later physical count.';end if;
 end if;
 n:=jsonb_array_length(t.plan->'rows');
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 2 and 3000 or octet_length(records::text)>64000000 then raise invalid_parameter_value using message='Invalid stock mutation.';end if;
 select count(*) filter(where x->>'table'='stock_items'),count(*) filter(where x->>'table'='stock_moves'),count(*) filter(where x->>'table'='events') into item_count,move_count,event_count from jsonb_array_elements(records) x;
 if item_count<>n or event_count<>n or move_count<>(select count(*) from jsonb_array_elements(t.plan->'rows') x where x->>'moveId' is not null)
  or item_count+move_count+event_count<>jsonb_array_length(records) then raise invalid_parameter_value using message='Invalid stock mutation shape.';end if;
 select jsonb_object_agg(x->'values'->>'id',x->'values') into item_records from jsonb_array_elements(records) x where x->>'table'='stock_items';
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if allowed is null or jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed)
   or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid stock record fields.';end if;
  p:=plans->(case when table_name='stock_items' then v->>'id' else v->>'stock_item_id' end);
  if p is null then raise invalid_parameter_value using message='Keep the planned stock identity.';end if;
  before:=old_items[(p->>'_i')::int];
  if t.type<>'stock.create' and (before.id is null or before.archived_at is not null and t.type not in ('stock.archive','stock.restore')) then raise sqlstate 'PT409' using message='Review this stock item.';end if;
  if t.type<>'stock.create' and ((p->>'revision')::bigint>before.revision or ((t.type in ('stock.update','stock.archive','stock.restore') or p->>'reason'='count') and (p->>'revision')::bigint<>before.revision)) then raise sqlstate 'PT409' using message='Review the latest stock revision.';end if;
  if t.type not in ('stock.create','stock.update','stock.archive','stock.restore','stock.undo') and p->>'reason'<>'count' and coalesce((count_barriers->>(p->>'itemId'))::bigint,0)>(p->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the later physical count.';end if;
  expected_quantity:=case p->>'reason' when 'count' then (p->>'quantity')::numeric when 'received' then before.on_hand+(p->>'quantity')::numeric when 'used' then before.on_hand-(p->>'quantity')::numeric when 'waste' then before.on_hand-(p->>'quantity')::numeric when 'undo' then before.on_hand-original.delta else before.on_hand end;
  if expected_quantity is null or expected_quantity<0 or expected_quantity>1000000000 then raise sqlstate 'PT409' using message='Review the available stock quantity.';end if;
  expected_counted:=before.last_counted_at;
  if p->>'reason'='count' then expected_counted:=t.occurred_at;
  elsif t.type='stock.undo' then
   select m.created_at into expected_counted from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.stock_item_id=p->>'itemId' and m.reason='count' and m.id<>original.id
     and not exists(select 1 from public.stock_moves u where u.business_id=t.business_id and u.outlet_id=t.outlet_id and u.undo_of=m.id) order by m.revision desc limit 1;
  end if;
  expected_command:=case t.type when 'stock.create' then 'stock.item-create' when 'stock.update' then 'stock.item-update' when 'stock.archive' then 'stock.archive' when 'stock.restore' then 'stock.restore' when 'stock.undo' then 'stock.undo' else 'stock.'||(p->>'reason') end;
  if table_name='stock_items' then
   if v->>'event_id' is distinct from p->>'eventId' or (v->>'revision')::bigint is distinct from coalesce(before.revision,0)+1
    or (v->>'created_at')::bigint is distinct from coalesce(before.created_at,t.occurred_at)
    or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(before.created_at,t.occurred_at))
    or (v->>'on_hand')::numeric is distinct from expected_quantity or (v->>'last_counted_at')::bigint is distinct from expected_counted
    or (v->>'archived_at')::bigint is distinct from (case when t.type='stock.archive' then t.occurred_at when t.type='stock.restore' then null else before.archived_at end)
    or (t.type='stock.archive' and (before.archived_at is not null or v->>'active_key' is not null))
    or (t.type='stock.restore' and (before.archived_at is null or v->>'active_key' is null))
    or (t.type in ('stock.create','stock.update') and v->>'active_key' is distinct from t.plan->>'nameKey')
    or (t.type='stock.update' and v->>'unit' is distinct from before.unit::text)
    or (t.type not in ('stock.create','stock.update') and (v->>'name' is distinct from before.name::text or v->>'name_local' is distinct from before.name_local::text or v->>'unit' is distinct from before.unit::text
      or v->>'category' is distinct from before.category::text or v->>'aliases' is distinct from before.aliases::text or (v->>'target')::numeric is distinct from before.target
      or (v->>'pack_size')::numeric is distinct from before.pack_size or (v->>'low_at')::numeric is distinct from before.low_at or v->>'supplier_id' is distinct from before.supplier_id::text))
    or (t.type not in ('stock.create','stock.update','stock.archive','stock.restore') and v->>'active_key' is distinct from before.active_key)
    or (t.type in ('stock.create','stock.update') and v->>'supplier_id' is distinct from t.plan->>'supplierId') then raise invalid_parameter_value using message='Invalid stock item mutation.';end if;
  elsif table_name='stock_moves' then
   item_values:=item_records->(p->>'itemId');
   if p->>'moveId' is null or v->>'id' is distinct from p->>'moveId' or v->>'event_id' is distinct from p->>'eventId' or (v->>'revision')::bigint is distinct from coalesce(before.revision,0)+1
    or v->>'created_by' is distinct from t.actor_id::text or (v->>'created_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at)
    or v->>'name' is distinct from item_values->>'name' or v->>'unit' is distinct from item_values->>'unit' or v->>'reason' is distinct from p->>'reason' or v->>'source' is distinct from p->>'source'
    or (v->>'before_quantity')::numeric is distinct from coalesce(before.on_hand,0) or (v->>'after_quantity')::numeric is distinct from expected_quantity
    or (v->>'delta')::numeric is distinct from expected_quantity-coalesce(before.on_hand,0)
    or v->>'undo_of' is distinct from t.plan->>'undoMoveId'
    or v->>'count_batch_id' is distinct from (case when t.type='stock.undo' then original.count_batch_id::text else t.plan->>'batchId' end) then raise invalid_parameter_value using message='Invalid stock movement.';end if;
  else
   if v->>'id' is distinct from p->>'eventId' or v->>'actor_type'<>'member' or v->>'actor_id' is distinct from t.actor_id::text or v->>'command' is distinct from expected_command
    or (v->>'stock_revision')::bigint is distinct from coalesce(before.revision,0)+1 or (v->>'at')::bigint is distinct from t.created_at
    or v->>'undo_of' is distinct from (case when t.type='stock.undo' then original.event_id::text else null end)
    or exists(select 1 from unnest(array['customer_id','order_id','order_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid stock audit.';end if;
  end if;
  select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key),
   string_agg(format('%I=excluded.%I',a.key,a.key),',' order by a.key) filter(where a.key not in ('id','business_id','outlet_id','created_at')) into keys,casts,updates
   from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
  execute format('insert into public.%I(%s) select %s%s',table_name,keys,casts,case when table_name='stock_items' then ' on conflict(id) do update set '||updates else '' end) using v;
 end loop;
 if not exists(select 1 from public.events e where e.id=t.command_id and e.business_id=t.business_id and e.outlet_id=t.outlet_id) then raise invalid_parameter_value using message='Missing stock audit.';end if;
 select jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'at',t.created_at,'batchId',t.plan->>'batchId','undoOf',t.plan->>'undoMoveId',
  'results',(select jsonb_agg(jsonb_build_object('stockItemId',s.id,'eventId',s.event_id,'moveId',p.value->>'moveId','revision',s.revision,'onHand',s.on_hand,'updatedAt',s.updated_at) order by p.ordinality)
   from jsonb_array_elements(t.plan->'rows') with ordinality p join public.stock_items s on s.id=p.value->>'itemId')) into metadata;
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.stock_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;

revoke all on function private.stock_write_context(public.ulid,public.ulid,jsonb),private.admit_stock_batch(public.ulid),
 private.prepare_stock_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),private.finish_stock_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.admit_stock_batch(public.ulid),private.prepare_stock_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_stock_write(public.ulid,text,jsonb) to service_role;
create function public.admit_stock_batch(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_stock_batch(p_outlet_id)$$;
create function public.prepare_stock_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_stock_write(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_stock_write(p_ticket_id public.ulid,p_token text,p_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_stock_write(p_ticket_id,p_token,p_records)$$;
revoke all on function public.admit_stock_batch(public.ulid),public.prepare_stock_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),public.finish_stock_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admit_stock_batch(public.ulid),public.prepare_stock_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_stock_write(public.ulid,text,jsonb) to service_role;
