-- Admit original non-quantity stock set intents against current metadata.
-- Keep current quantities/count history and immutable units, all physical-count/undo
-- checks, complete audit snapshots, current scope and service-only completion.
-- CREATE OR REPLACE retains existing ownership and execution grants.
create or replace function private.finish_stock_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
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
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
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
  if t.type<>'stock.create' and (before.id is null or before.archived_at is not null and not (t.type in ('stock.archive','stock.restore') or t.type='stock.update' and p->>'moveId' is null)) then raise sqlstate 'PT409' using message='Review this stock item.';end if;
  if t.type<>'stock.create' and ((p->>'revision')::bigint>before.revision or (p->>'reason'='count' and (p->>'revision')::bigint<>before.revision)) then raise sqlstate 'PT409' using message='Review the latest stock revision.';end if;
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
    or (t.type='stock.archive' and v->>'active_key' is not null)
    or (t.type='stock.restore' and v->>'active_key' is null)
    or (t.type in ('stock.create','stock.update') and v->>'active_key' is distinct from (case when t.type='stock.update' and before.archived_at is not null then null else t.plan->>'nameKey' end))
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
