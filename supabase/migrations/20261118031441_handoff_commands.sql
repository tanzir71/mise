-- Explicit manual choices and their complete Sent side effects. No message is sent here.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
  'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch','supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo',
  'order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings','closing.record','closing.undo',
  'handoff.prepare','handoff.change','supplier-message.undo'));
create table private.handoff_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('handoff.prepare','handoff.change','supplier-message.undo')),
 plan jsonb not null,occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.handoff_write_tickets enable row level security;alter table private.handoff_write_tickets force row level security;
revoke all on private.handoff_write_tickets from public,anon,authenticated,service_role;
create index handoff_write_tickets_actor_idx on private.handoff_write_tickets(auth_user_id,expires_at);
create index handoff_write_tickets_command_idx on private.handoff_write_tickets(command_id);

create function private.handoff_source_row(business public.ulid,outlet public.ulid,kind text,source_id public.ulid) returns json
language plpgsql volatile security invoker set search_path='' as $$
begin
 case kind
  when 'credit' then return (select row_to_json(a) from public.credit_accounts a where a.business_id=business and a.outlet_id=outlet and a.id=source_id
   and exists(select 1 from public.customer_outlets co where co.business_id=business and co.outlet_id=outlet and co.customer_id=a.customer_id));
  when 'customer' then return (select row_to_json(c) from public.customers c where c.business_id=business and c.id=source_id
   and exists(select 1 from public.customer_outlets co where co.business_id=business and co.outlet_id=outlet and co.customer_id=c.id));
  when 'order' then return (select row_to_json(o) from public.orders o where o.business_id=business and o.outlet_id=outlet and o.id=source_id);
  when 'supplier' then return (select row_to_json(s) from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=source_id);
  when 'sale' then return (select row_to_json(s) from public.sales s where s.business_id=business and s.outlet_id=outlet and s.id=source_id);
  when 'closing' then return (select row_to_json(c) from public.day_closings c where c.business_id=business and c.outlet_id=outlet and c.id=source_id);
  when 'shop' then return (select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet and o.id=source_id);
  else return null;
 end case;
end $$;
-- Completion is service-only; hand-off event clocks remain physical and linear.
create function private.finish_handoff_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.handoff_write_tickets;h public.events;p public.events;latest public.events;m public.supplier_messages;o public.orders;a public.credit_accounts;
 before_state jsonb;expected_state jsonb;progress jsonb;d jsonb;r jsonb;v jsonb;allowed jsonb;table_name text;keys text;casts text;immutable text;unchanged boolean;
 source_kind text;source_id public.ulid;completion_kind text;topic text;action text;action_at public.utc_ms;at_ms public.utc_ms;generation_value bigint;entry_sequence bigint;
 expected_channel text;trimmed text;companion_created boolean:=false;expected_events integer;expected_rows integer;metadata jsonb;main_count integer:=0;companion_count integer:=0;
 specs jsonb:='{"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"],"orders":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","business_type","sequence","number","source","source_text","customer_id","customer_name","customer_phone","type","status","status_changed_at","status_event_id","lines","subtotal","delivery_fee","discount","total","currency","timezone","address","table_label","scheduled_for","payment","handled_by","business_id"],"order_communications":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","order_id","purpose","channel","text","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"supplier_messages":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","supplier_id","supplier_name","phone","text","channel","stock_item_ids","part","parts","business_id"]}';
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.handoff_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This message preparation is unavailable.';end if;
 perform 1 from public.businesses b where b.id=t.business_id for share;perform 1 from public.outlets x where x.business_id=t.business_id and x.id=t.outlet_id for update;
 select * into t from private.handoff_write_tickets x where x.id=ticket_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This message proof is unavailable.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 if t.snapshot_hash<>sha256(convert_to(private.handoff_write_context(t.business_id,t.outlet_id,t.type,t.plan)::text,'UTF8')) then raise sqlstate 'PT409' using message='The message source changed.',detail='handoff_snapshot_changed';end if;
 if t.type='supplier-message.undo' then
  select * into m from public.supplier_messages x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'messageId';action_at:=t.occurred_at;
  if m.id is null or m.voided_at is not null or at_ms<m.created_at or at_ms-m.created_at>86400000 or t.occurred_at<m.created_at then raise sqlstate 'PT409' using message='Correct a supplier sent record once within twenty-four hours.';end if;
 else
  if t.type='handoff.prepare' then
   d:=(t.plan->>'draftJson')::jsonb;topic:=t.plan->>'topic';
   select count(*)+1 into generation_value from public.events x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.command='handoff.prepare' and x.handoff_topic=topic;
   select * into p from public.events x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.command='handoff.prepare' and x.handoff_topic=topic order by (x.after_data::jsonb->>'generation')::bigint desc limit 1;
   select * into latest from public.events x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.handoff_id=p.id order by x.handoff_revision desc limit 1;
   action_at:=greatest(t.occurred_at,coalesce(latest.at,t.occurred_at));
   progress:=jsonb_build_object('revision',1,'status','ready','lastAttempt','prepared','channel','manual','updatedAt',action_at);
   expected_state:=jsonb_build_object('v',case when d ? 'template' then 2 else 1 end,'id',t.command_id,'outletId',t.outlet_id,'eventId',t.command_id,'generation',generation_value,'createdAt',action_at,'draft',d,'progress',progress);
  else
   select * into h from public.events x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'handoffId' and x.handoff_id=x.id and x.command='handoff.prepare';
   select * into latest from public.events x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.handoff_id=h.id order by x.handoff_revision desc limit 1;
   if h.id is null or latest.handoff_revision is distinct from (t.plan->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the latest message progress.';end if;
   before_state:=latest.after_data::jsonb;d:=before_state->'draft';progress:=before_state->'progress';action:=t.plan->>'choice';topic:=latest.handoff_topic;generation_value:=(before_state->>'generation')::bigint;
   if before_state->>'id' is distinct from h.id::text or before_state->>'generation' is distinct from h.after_data::jsonb->>'generation' or before_state->>'createdAt' is distinct from h.after_data::jsonb->>'createdAt' or d is distinct from h.after_data::jsonb->'draft' then raise invalid_parameter_value using message='Keep the complete original attempt.';end if;
   action_at:=greatest(t.occurred_at,latest.at);progress:=progress||jsonb_build_object('revision',latest.handoff_revision+1,'updatedAt',action_at);
   if action='sent' then
    if progress->>'sentAt' is not null then raise sqlstate 'PT409' using message='This attempt is already marked sent.';end if;
    progress:=progress||jsonb_build_object('status','sent','sentAt',action_at,'sentChannel',progress->>'channel');
   elsif action='undo-sent' then
    if progress->>'sentAt' is null or at_ms<(progress->>'sentAt')::bigint or at_ms-(progress->>'sentAt')::bigint>600000 then raise sqlstate 'PT409' using message='Undo Sent within ten minutes of confirmation.';end if;
    progress:=(progress-'sentAt'-'sentChannel')||jsonb_build_object('status',case progress->>'lastAttempt' when 'prepared' then 'ready' when 'open' then 'opened' when 'copy' then 'copied' else 'failed' end);
   else
    if action='failed' and progress->>'sentAt' is not null then raise invalid_parameter_value using message='Undo Sent before recording a failure.';end if;
    progress:=progress||jsonb_build_object('lastAttempt',action,'status',case when progress->>'sentAt' is not null then 'sent' when action='open' then 'opened' when action='copy' then 'copied' else 'failed' end);
    if action='open' then progress:=progress||jsonb_build_object('channel',t.plan->>'channel','openedAt',action_at);
    elsif action='copy' then progress:=progress||jsonb_build_object('channel','manual','copiedAt',action_at);
    else progress:=progress||jsonb_build_object('failedAt',action_at);if action='copy-failed' then progress:=progress||jsonb_build_object('channel','manual');end if;end if;
   end if;
   expected_state:=before_state||jsonb_build_object('eventId',t.command_id,'progress',progress);
   if action='sent' then expected_state:=expected_state||jsonb_build_object('sentEventId',t.command_id);elsif action='undo-sent' then expected_state:=expected_state-'sentEventId';end if;
  end if;
  source_kind:=d->'source'->>'kind';source_id:=(d->'source'->>'id')::public.ulid;
  if private.handoff_source_row(t.business_id,t.outlet_id,source_kind,source_id) is null then raise insufficient_privilege using message='The message source is unavailable in this outlet.';end if;
  if action='sent' then
   completion_kind:=t.plan->'completion'->>'kind';
   if source_kind='credit' and completion_kind is distinct from 'credit' or source_kind='order' and completion_kind is distinct from 'order'
    or ((source_kind='supplier' or source_kind='shop') and d->>'purpose'='supplier-order') and completion_kind is distinct from 'supplier'
    or not(source_kind in ('credit','order') or (source_kind='supplier' or source_kind='shop') and d->>'purpose'='supplier-order') and completion_kind is not null then raise invalid_parameter_value using message='Complete the original message source together.';end if;
   expected_channel:=case when d->>'purpose'='call' then 'call' when progress->>'sentChannel'='whatsapp' then 'whatsapp' else 'manual' end;
   -- The ECMAScript trim character set; no arbitrary source JSON is parsed here.
   trimmed:=btrim(d->>'text',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
   if completion_kind='credit' then
    select * into a from public.credit_accounts x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=source_id;
    select coalesce(max(e.sequence),0)+1 into entry_sequence from public.credit_entries e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.account_id=a.id;companion_created:=true;
   elsif completion_kind='order' then
    select * into o from public.orders x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=source_id;
    if o.revision is distinct from (t.plan->'completion'->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the latest order before confirming its message.';end if;companion_created:=true;
   elsif completion_kind='supplier' then
    select * into m from public.supplier_messages x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'handoffId';
    if (select count(*) from public.stock_items i where i.business_id=t.business_id and i.outlet_id=t.outlet_id and (t.plan->'completion'->'stockItemIds') ? i.id::text)<>jsonb_array_length(t.plan->'completion'->'stockItemIds') then raise insufficient_privilege using message='Choose stock items from this outlet.';end if;
    if m.id is not null and (m.voided_at is not null or m.supplier_id::text is distinct from (case when source_kind='supplier' then source_id::text else null end)
     or m.supplier_name::text is distinct from t.plan->'completion'->>'supplierNameJson' or m.phone is distinct from d->>'phone' or m.text::text is distinct from to_json(trimmed)::text or m.channel is distinct from expected_channel
     or (select jsonb_agg(x order by x) from jsonb_array_elements_text(m.stock_item_ids::jsonb) x) is distinct from (select jsonb_agg(x order by x) from jsonb_array_elements_text(t.plan->'completion'->'stockItemIds') x) or m.part<>(d->>'part')::bigint or m.parts<>(d->>'parts')::bigint) then raise invalid_parameter_value using message='The existing supplier sent record changed.';end if;
    companion_created:=m.id is null;
   end if;
  end if;
 end if;
 expected_events:=1+(case when companion_created then 1 else 0 end);expected_rows:=expected_events+(case when t.type='supplier-message.undo' then 1 when completion_kind='credit' then 1 when completion_kind='order' then 2 when completion_kind='supplier' and companion_created then 1 else 0 end);
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records)<>expected_rows or octet_length(records::text)>2000000
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='events')<>expected_events
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='orders')<>(case when completion_kind='order' then 1 else 0 end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='order_communications')<>(case when completion_kind='order' then 1 else 0 end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='credit_entries')<>(case when completion_kind='credit' then 1 else 0 end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='supplier_messages')<>(case when t.type='supplier-message.undo' or completion_kind='supplier' and companion_created then 1 else 0 end)
  or exists(select 1 from jsonb_array_elements(records) x group by x->>'table',x->'values'->>'id' having count(*)>1) then raise invalid_parameter_value using message='Keep the complete manual message transaction.';end if;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if jsonb_typeof(r) is distinct from 'object' or (select count(*) from jsonb_object_keys(r))<>2 or not r ? 'table' or not r ? 'values' or allowed is null or jsonb_typeof(v) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed) or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid manual message record fields or scope.';end if;
  if table_name='events' then
   if v->>'actor_type' is distinct from 'member' or v->>'actor_id' is distinct from t.actor_id::text then raise invalid_parameter_value using message='Invalid manual message actor.';end if;
   if v->>'id'=t.command_id::text then
    main_count:=main_count+1;
    if t.type='supplier-message.undo' then
     if v->>'command' is distinct from 'supplier.sent-undo' or v->>'supplier_id' is distinct from m.supplier_id::text or v->>'undo_of' is distinct from m.event_id::text or (v->>'at')::bigint is distinct from t.created_at
      or exists(select 1 from unnest(array['customer_id','order_id','order_revision','stock_item_id','stock_revision','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Keep the supplier correction audit.';end if;
    else
     if v->>'command' is distinct from (case when t.type='handoff.prepare' then 'handoff.prepare' else 'handoff.'||(t.plan->>'choice') end)
      or v->>'handoff_id' is distinct from t.plan->>'handoffId' or (v->>'handoff_revision')::bigint is distinct from (progress->>'revision')::bigint or v->>'handoff_topic' is distinct from topic or (v->>'at')::bigint is distinct from action_at
      or (v->>'before_data')::jsonb is distinct from coalesce(before_state,'null'::jsonb) or (v->>'after_data')::jsonb is distinct from expected_state
      or v->>'undo_of' is distinct from (case when action='undo-sent' then before_state->>'sentEventId' else null end)
      or exists(select 1 from unnest(array['customer_id','order_id','order_revision','stock_item_id','stock_revision','supplier_id','closing_id','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Keep the exact original message and progress transition.';end if;
    end if;
   else
    companion_count:=companion_count+1;
    if not companion_created or v->>'id' is distinct from t.plan->'related'->>'eventId' or (v->>'at')::bigint is distinct from t.created_at or v->>'undo_of' is not null
     or exists(select 1 from unnest(array['stock_item_id','stock_revision','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null)
     or v->>'customer_id' is distinct from (case when completion_kind='credit' then a.customer_id::text else null end)
     or v->>'order_id' is distinct from (case when completion_kind='order' then o.id::text else null end)
     or (v->>'order_revision')::bigint is distinct from (case when completion_kind='order' then o.revision+1 else null end)
     or v->>'supplier_id' is distinct from (case when completion_kind='supplier' and source_kind='supplier' then source_id::text else null end)
     or v->>'command' is distinct from (case when completion_kind='credit' then 'khata.'||(d->>'purpose')||'-sent' when completion_kind='order' then 'order.'||(d->>'purpose')||'-sent' else 'supplier.sent' end) then raise invalid_parameter_value using message='Keep the complete companion communication audit.';end if;
   end if;
  elsif table_name='orders' then
   if v->>'id' is distinct from o.id::text or (v->>'revision')::bigint is distinct from o.revision+1 or v->>'event_id' is distinct from t.plan->'related'->>'eventId' or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,action_at,o.created_at) then raise invalid_parameter_value using message='Keep the reviewed order communication revision and identity.';end if;
  elsif table_name='order_communications' then
   if v->>'id' is distinct from t.plan->'related'->>'recordId' or v->>'order_id' is distinct from o.id::text or (v->>'revision')::bigint is distinct from o.revision+1 or v->>'event_id' is distinct from t.plan->'related'->>'eventId'
    or v->>'created_by' is distinct from t.actor_id::text or (v->>'created_at')::bigint is distinct from action_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,action_at)
    or v->>'purpose' is distinct from d->>'purpose' or v->>'channel' is distinct from expected_channel or v->>'text' is distinct from to_json(trimmed)::text then raise invalid_parameter_value using message='Keep the exact confirmed order communication.';end if;
  elsif table_name='credit_entries' then
   if v->>'id' is distinct from t.plan->'related'->>'recordId' or v->>'event_id' is distinct from t.plan->'related'->>'eventId' or v->>'account_id' is distinct from a.id::text or v->>'customer_id' is distinct from a.customer_id::text
    or v->>'created_by' is distinct from t.actor_id::text or (v->>'created_at')::bigint is distinct from action_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,action_at)
    or v->>'currency' is distinct from a.currency or (v->>'sequence')::bigint is distinct from entry_sequence or v->>'type' is distinct from 'reminder' or (v->>'amount')::numeric is distinct from 0
    or v->>'purpose' is distinct from d->>'purpose' or v->>'method_name' is distinct from to_json(expected_channel)::text or v->>'note' is distinct from to_json(d->>'text')::text
    or exists(select 1 from unnest(array['sale_id','order_id','refund_id','returns_charge_id','occurred_at','reversal_of','over_limit']) k where v->>k is not null) then raise invalid_parameter_value using message='A confirmed message cannot alter customer debt.';end if;
  else
   if t.type='supplier-message.undo' then
    if v->>'id' is distinct from m.id::text or (v->>'voided_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,m.created_at) then raise invalid_parameter_value using message='Keep the original supplier sent record correction.';end if;
   elsif v->>'id' is distinct from t.plan->>'handoffId' or v->>'event_id' is distinct from t.plan->'related'->>'eventId' or v->>'created_by' is distinct from t.actor_id::text
    or (v->>'created_at')::bigint is distinct from action_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,action_at) or v->>'voided_at' is not null
    or v->>'supplier_id' is distinct from (case when source_kind='supplier' then source_id::text else null end) or v->>'supplier_name' is distinct from t.plan->'completion'->>'supplierNameJson' or v->>'phone' is distinct from d->>'phone'
    or v->>'channel' is distinct from expected_channel or v->>'text' is distinct from to_json(trimmed)::text or (v->>'stock_item_ids')::jsonb is distinct from t.plan->'completion'->'stockItemIds'
    or (v->>'part')::bigint is distinct from (d->>'part')::bigint or (v->>'parts')::bigint is distinct from (d->>'parts')::bigint then raise invalid_parameter_value using message='Keep the exact confirmed supplier message.';end if;
  end if;
  if table_name='orders' or table_name='supplier_messages' and t.type='supplier-message.undo' then
   select string_agg(format('($1->>%L) is not distinct from source.%I::text',k,k),' and ') into immutable from jsonb_object_keys(v) k
    where k<>all(case when table_name='orders' then array['revision','event_id','updated_at'] else array['voided_at','updated_at'] end);
   execute format('select %s from public.%I source where source.id=$2',immutable,table_name) into unchanged using v,(v->>'id')::public.ulid;
   if unchanged is distinct from true then raise invalid_parameter_value using message='Keep every original business record field.';end if;
   if table_name='orders' then update public.orders x set revision=o.revision+1,event_id=(t.plan->'related'->>'eventId')::public.ulid,updated_at=(v->>'updated_at')::bigint where x.id=o.id;
   else update public.supplier_messages x set voided_at=t.occurred_at,updated_at=(v->>'updated_at')::bigint where x.id=m.id;end if;
  else
   select string_agg(format('%I',e.key),',' order by e.key),string_agg(format('($1->>%L)::%s',e.key,format_type(att.atttypid,att.atttypmod)),',' order by e.key) into keys,casts
    from jsonb_each(v) e join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=e.key and att.attnum>0 and not att.attisdropped;
   execute format('insert into public.%I(%s) select %s',table_name,keys,casts) using v;
  end if;
 end loop;
 if main_count<>1 or companion_count<>(case when companion_created then 1 else 0 end) then raise invalid_parameter_value using message='Keep every manual message audit together.';end if;
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'at',t.created_at,'actionAt',action_at,
  'handoffId',case when t.type='supplier-message.undo' then null else t.plan->>'handoffId' end,'generation',generation_value,'revision',(progress->>'revision')::bigint,'status',progress->>'status','sentAt',(progress->>'sentAt')::bigint,'sentEventId',expected_state->>'sentEventId',
  'companionId',case when t.type='supplier-message.undo' then t.plan->>'messageId' when action='sent' then t.plan->'related'->>'recordId' else null end,
  'companionEventId',case when t.type='supplier-message.undo' then t.command_id::text when companion_created then t.plan->'related'->>'eventId' else null end,
  'orderRevision',case when completion_kind='order' then o.revision+1 else null end,'entrySequence',entry_sequence,
  'undoOf',case when t.type='supplier-message.undo' then t.plan->>'messageId' when action='undo-sent' then t.plan->>'handoffId' else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.handoff_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;
create function private.handoff_write_context(business public.ulid,outlet public.ulid,kind text,plan jsonb) returns json
language plpgsql volatile security invoker set search_path='' as $$
declare h public.events;p public.events;latest public.events;d jsonb;source_kind text;source_id public.ulid;generation_value bigint;account public.ulid;customer public.ulid;
begin
 if kind='handoff.prepare' then
  d:=(plan->>'draftJson')::jsonb;source_kind:=plan->>'sourceKind';source_id:=(plan->>'sourceId')::public.ulid;
  select count(*)+1 into generation_value from public.events x where x.business_id=business and x.outlet_id=outlet and x.command='handoff.prepare' and x.handoff_topic=plan->>'topic';
  select * into p from public.events x where x.business_id=business and x.outlet_id=outlet and x.command='handoff.prepare' and x.handoff_topic=plan->>'topic' order by (x.after_data::jsonb->>'generation')::bigint desc limit 1;
  select * into latest from public.events x where x.business_id=business and x.outlet_id=outlet and x.handoff_id=p.id order by x.handoff_revision desc limit 1;
 elsif kind='handoff.change' then
  select * into h from public.events x where x.business_id=business and x.outlet_id=outlet and x.id=plan->>'handoffId' and x.handoff_id=x.id and x.command='handoff.prepare';
  select * into latest from public.events x where x.business_id=business and x.outlet_id=outlet and x.handoff_id=h.id order by x.handoff_revision desc limit 1;
  -- Only validated hand-off states use jsonb: their draft parser rejects NUL/lone surrogates.
  d:=latest.after_data::jsonb->'draft';source_kind:=d->'source'->>'kind';source_id:=(d->'source'->>'id')::public.ulid;generation_value:=(h.after_data::jsonb->>'generation')::bigint;
 end if;
 if source_kind='credit' then
  select a.id,a.customer_id into account,customer from public.credit_accounts a where a.business_id=business and a.outlet_id=outlet and a.id=source_id;
 end if;
 return json_build_object(
  'business',(select row_to_json(b) from public.businesses b where b.id=business),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'root',case when h.id is null then null else row_to_json(h) end,'previousRoot',case when p.id is null then null else row_to_json(p) end,'latest',case when latest.id is null then null else row_to_json(latest) end,
  'generation',generation_value,'sourceKind',source_kind,'sourceId',source_id,'source',private.handoff_source_row(business,outlet,source_kind,source_id),
  'customer',(select row_to_json(c) from public.customers c where kind='handoff.change' and plan->>'choice'='sent' and c.business_id=business and c.id=customer
   and exists(select 1 from public.customer_outlets co where co.business_id=business and co.outlet_id=outlet and co.customer_id=c.id)),
  'entries',(select coalesce(json_agg(row_to_json(e) order by e.sequence,e.id),'[]') from public.credit_entries e where kind='handoff.change' and plan->>'choice'='sent' and e.business_id=business and e.outlet_id=outlet and e.account_id=account),
  'items',(select coalesce(json_agg(row_to_json(i) order by i.id),'[]') from public.stock_items i where i.business_id=business and i.outlet_id=outlet and (plan->'completion'->'stockItemIds') ? i.id::text),
  'message',(select row_to_json(m) from public.supplier_messages m where m.business_id=business and m.outlet_id=outlet and m.id=coalesce(plan->>'messageId',case when source_kind='supplier' or source_kind='shop' and d->>'purpose'='supplier-order' then plan->>'handoffId' else null end))
 );
end $$;
create function private.admit_handoff_write(outlet public.ulid) returns boolean language plpgsql security definer set search_path='' as $$
declare business public.ulid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 perform private.public_link_actor(business,outlet);return true;
end $$;
create function private.prepare_handoff_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;h public.events;latest public.events;m public.supplier_messages;d jsonb;state jsonb;
 source_kind text;source_id public.ulid;source_row json;context json;secret text;at_ms public.utc_ms;order_revision bigint;completion_kind text;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This manual message is unavailable.';end if;
 if command_id is null or ticket_id is null or outlet is null or occurred is null or occurred>253402300799999 or kind is null or kind not in ('handoff.prepare','handoff.change','supplier-message.undo')
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or jsonb_typeof(ids) is distinct from 'object' or octet_length(ids::text)>768000 or (select count(*) from jsonb_object_keys(ids))<>12
  or exists(select 1 from jsonb_object_keys(ids) k where k not in ('handoffId','messageId','revision','choice','channel','sourceKind','sourceId','topic','draftJson','completion','related','intentJson'))
  or jsonb_typeof(ids->'intentJson') is distinct from 'string' or octet_length(ids->>'intentJson')>(case when kind='handoff.prepare' then 256000 else 32000 end) or encode(sha256(convert_to(ids->>'intentJson','UTF8')),'hex')<>fingerprint
  or exists(select 1 from unnest(array['handoffId','messageId','sourceId']) k where ids->>k is not null and (jsonb_typeof(ids->k)<>'string' or (ids->>k)!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')) then raise invalid_parameter_value using message='Keep the exact manual message intent and identities.';end if;
 if kind='handoff.prepare' then
  if ids->>'handoffId' is distinct from command_id::text or ids->>'sourceKind' is null or ids->>'sourceKind' not in ('credit','customer','order','supplier','sale','closing','shop') or ids->>'sourceId' is null
   or ids->>'sourceId'=command_id::text or jsonb_typeof(ids->'draftJson') is distinct from 'string' or jsonb_typeof(ids->'topic') is distinct from 'string'
   or exists(select 1 from unnest(array['messageId','revision','choice','channel','completion','related']) k where (ids->k) is distinct from 'null'::jsonb) then raise invalid_parameter_value using message='Keep the original message preparation.';end if;
  d:=(ids->>'draftJson')::jsonb;
  if jsonb_typeof(d) is distinct from 'object' or d->'source'->>'kind' is distinct from ids->>'sourceKind' or d->'source'->>'id' is distinct from ids->>'sourceId'
   or ids->>'topic' is distinct from (ids->>'sourceKind')||':'||(ids->>'sourceId')||':'||(d->>'purpose')||':'||(d->>'part')||'/'||(d->>'parts') then raise invalid_parameter_value using message='Keep the exact message topic and source.';end if;
 elsif kind='handoff.change' then
  if ids->>'handoffId' is null or ids->>'handoffId'=command_id::text or jsonb_typeof(ids->'revision') is distinct from 'number' or (ids->>'revision')::numeric<>trunc((ids->>'revision')::numeric) or (ids->>'revision')::numeric not between 1 and 9007199254740990
   or ids->>'choice' is null or ids->>'choice' not in ('open','copy','copy-failed','failed','sent','undo-sent') or (ids->>'choice'='open' and (ids->>'channel' is null or ids->>'channel' not in ('whatsapp','call','share')))
   or (ids->>'choice'<>'open' and ids->>'channel' is not null) or exists(select 1 from unnest(array['messageId','sourceKind','sourceId','topic','draftJson']) k where (ids->k) is distinct from 'null'::jsonb)
   or ((ids->'completion')='null'::jsonb)<>((ids->'related')='null'::jsonb) or ids->>'choice'<>'sent' and ((ids->'completion')<>'null'::jsonb or (ids->'related')<>'null'::jsonb) then raise invalid_parameter_value using message='Keep the reviewed message choice.';end if;
  if ids->'completion'<>'null'::jsonb then
   if jsonb_typeof(ids->'completion') is distinct from 'object' or jsonb_typeof(ids->'related') is distinct from 'object' or (select count(*) from jsonb_object_keys(ids->'related'))<>2
    or exists(select 1 from jsonb_each_text(ids->'related') e where e.key not in ('recordId','eventId') or e.value is null or e.value!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
    or ids->'related'->>'eventId' in(command_id::text,ids->>'handoffId',ids->'related'->>'recordId') or ids->'related'->>'recordId'=command_id::text then raise invalid_parameter_value using message='Keep all companion identities.';end if;
   completion_kind:=ids->'completion'->>'kind';
   if completion_kind='credit' then
    if (select count(*) from jsonb_object_keys(ids->'completion'))<>1 or ids->'related'->>'recordId'=ids->>'handoffId' then raise invalid_parameter_value using message='Keep the credit message identity.';end if;
   elsif completion_kind='order' then
    if (select count(*) from jsonb_object_keys(ids->'completion'))<>2 or not(ids->'completion' ? 'revision') or jsonb_typeof(ids->'completion'->'revision') is distinct from 'number'
     or (ids->'completion'->>'revision')::numeric<>trunc((ids->'completion'->>'revision')::numeric) or (ids->'completion'->>'revision')::numeric not between 1 and 9007199254740990 or ids->'related'->>'recordId'=ids->>'handoffId' then raise invalid_parameter_value using message='Keep the reviewed order communication.';end if;
   elsif completion_kind='supplier' then
    if (select count(*) from jsonb_object_keys(ids->'completion'))<>3 or jsonb_typeof(ids->'completion'->'supplierNameJson') is distinct from 'string' or jsonb_typeof(ids->'completion'->'stockItemIds') is distinct from 'array'
     or jsonb_array_length(ids->'completion'->'stockItemIds') not between 1 and 1000 or jsonb_array_length(ids->'completion'->'stockItemIds')<>(select count(distinct x) from jsonb_array_elements_text(ids->'completion'->'stockItemIds') x)
     or exists(select 1 from jsonb_array_elements_text(ids->'completion'->'stockItemIds') x where x is null or x!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$') or ids->'related'->>'recordId' is distinct from ids->>'handoffId' then raise invalid_parameter_value using message='Keep the supplier message, name and stock identities.';end if;
   else raise invalid_parameter_value using message='Choose the source message completion.';end if;
  end if;
 else
  if ids->>'messageId' is null or ids->>'messageId'=command_id::text or exists(select 1 from unnest(array['handoffId','revision','choice','channel','sourceKind','sourceId','topic','draftJson','completion','related']) k where (ids->k) is distinct from 'null'::jsonb) then raise invalid_parameter_value using message='Keep the original supplier sent record.';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This message command is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original message intent.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform 1 from public.businesses b where b.id=business for share;perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 if kind='supplier-message.undo' then
  select * into m from public.supplier_messages x where x.business_id=business and x.outlet_id=outlet and x.id=ids->>'messageId';
  if not found then raise insufficient_privilege using message='This supplier sent record is unavailable.';end if;
  if m.voided_at is not null or at_ms<m.created_at or at_ms-m.created_at>86400000 or occurred<m.created_at then raise sqlstate 'PT409' using message='Correct a supplier sent record once within twenty-four hours.';end if;
 elsif kind='handoff.prepare' then
  if exists(select 1 from public.events x where x.id=command_id) then raise unique_violation using message='This message attempt identity is unavailable.';end if;
  source_kind:=ids->>'sourceKind';source_id:=(ids->>'sourceId')::public.ulid;
 else
  select * into h from public.events x where x.business_id=business and x.outlet_id=outlet and x.id=ids->>'handoffId' and x.handoff_id=x.id and x.command='handoff.prepare';
  if not found then raise insufficient_privilege using message='This message attempt is unavailable.';end if;
  select * into latest from public.events x where x.business_id=business and x.outlet_id=outlet and x.handoff_id=h.id order by x.handoff_revision desc limit 1;
  if latest.handoff_revision is distinct from (ids->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the latest message progress.';end if;
  state:=latest.after_data::jsonb;d:=state->'draft';source_kind:=d->'source'->>'kind';source_id:=(d->'source'->>'id')::public.ulid;
  if ids->>'choice'='undo-sent' and (state->'progress'->>'sentAt' is null or at_ms<(state->'progress'->>'sentAt')::bigint or at_ms-(state->'progress'->>'sentAt')::bigint>600000) then raise sqlstate 'PT409' using message='Undo Sent within ten minutes of confirmation.';end if;
  if ids->>'choice'='sent' then
   if source_kind='credit' and completion_kind is distinct from 'credit' or source_kind='order' and completion_kind is distinct from 'order'
    or ((source_kind='supplier' or source_kind='shop') and d->>'purpose'='supplier-order') and completion_kind is distinct from 'supplier'
    or not(source_kind in ('credit','order') or (source_kind='supplier' or source_kind='shop') and d->>'purpose'='supplier-order') and completion_kind is not null then raise invalid_parameter_value using message='Complete the original message source together.';end if;
   if source_kind='order' then
    select o.revision into order_revision from public.orders o where o.business_id=business and o.outlet_id=outlet and o.id=source_id;
    if order_revision is distinct from (ids->'completion'->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the latest order before confirming its message.';end if;
   end if;
   if completion_kind='supplier' and (select count(*) from public.stock_items i where i.business_id=business and i.outlet_id=outlet and (ids->'completion'->'stockItemIds') ? i.id::text)<>jsonb_array_length(ids->'completion'->'stockItemIds') then raise insufficient_privilege using message='Choose stock items from this outlet.';end if;
  end if;
 end if;
 if kind<>'supplier-message.undo' then source_row:=private.handoff_source_row(business,outlet,source_kind,source_id);if source_row is null then raise insufficient_privilege using message='The message source is unavailable in this outlet.';end if;end if;
 delete from private.handoff_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.handoff_write_tickets t where t.command_id=prepare_handoff_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>(ids-'intentJson'))) then raise unique_violation using message='Keep the original message intent and identities.';end if;
 delete from private.handoff_write_tickets t where t.command_id=prepare_handoff_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.handoff_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.handoff_write_context(business,outlet,kind,ids);secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.handoff_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids-'intentJson',occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

revoke all on function private.handoff_source_row(public.ulid,public.ulid,text,public.ulid),private.handoff_write_context(public.ulid,public.ulid,text,jsonb),private.admit_handoff_write(public.ulid),private.prepare_handoff_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),private.finish_handoff_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.admit_handoff_write(public.ulid),private.prepare_handoff_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_handoff_write(public.ulid,text,jsonb) to service_role;
create function public.admit_handoff_write(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_handoff_write(p_outlet_id)$$;
create function public.prepare_handoff_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_handoff_write(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_handoff_write(p_ticket_id public.ulid,p_token text,p_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_handoff_write(p_ticket_id,p_token,p_records)$$;
revoke all on function public.admit_handoff_write(public.ulid),public.prepare_handoff_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),public.finish_handoff_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admit_handoff_write(public.ulid),public.prepare_handoff_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_handoff_write(public.ulid,text,jsonb) to service_role;
