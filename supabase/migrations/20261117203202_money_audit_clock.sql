-- Use the authenticated preparation time consistently for persisted rows, audit
-- snapshots and receipt metadata; the live completion clock still governs expiry
-- and undo eligibility. Literal JSON audit snapshots need no lossy rewrite.
create or replace function private.finish_money_write(ticket_id public.ulid,secret text,occurred public.utc_ms,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.money_write_tickets;r jsonb;v jsonb;allowed jsonb;table_name text;keys text;casts text;at_ms public.utc_ms;
 original public.sales;sale public.sales;target public.credit_entries;entry public.credit_entries;
 sale_count int;entry_count int;event_count int;has_credit boolean;balance numeric;metadata jsonb;expected_entry text;expected_audit text;
 specs jsonb:='{"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare again.';end if;
 select * into t from private.money_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Prepare again.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for update;
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 select * into t from private.money_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms or occurred is distinct from t.occurred_at then raise sqlstate 'PT409' using message='Prepare again.';end if;
 if sha256(convert_to(private.money_write_context(t.business_id,t.outlet_id,t.customer_id,t.account_id,(t.plan->>'saleId')::public.ulid,t.target_entry_id,t.plan->'itemIds')::text,'UTF8'))<>t.snapshot_hash then
  raise sqlstate 'PT409' using message='Money records changed. Prepare again.',detail='money_snapshot_changed';end if;
 if t.account_id is not null and not exists(select 1 from public.customer_outlets a where a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.customer_id=t.customer_id) then raise insufficient_privilege using message='This khata is unavailable.';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
 select * into original from public.sales s where s.id=t.plan->>'saleId';
 select * into target from public.credit_entries e where e.id=t.target_entry_id;
 has_credit:=t.type='sale.credit' or (t.type='sale.undo' and original.method='credit');
 if t.type='sale.undo' and (original.order_id is not null or original.closing_id is not null or original.voided_at is not null or at_ms<original.created_at or at_ms-original.created_at>600000 or occurred<original.created_at) then raise sqlstate 'PT409' using message='This receipt cannot be undone.';end if;
 if t.type in ('sale.undo','khata.undo') and t.target_entry_id is not null and
  (target.reversal_of is not null or target.type='reminder' or at_ms<target.created_at or at_ms-target.created_at>600000 or occurred<target.created_at
   or exists(select 1 from public.credit_entries e where e.account_id=t.account_id and e.reversal_of=target.id)) then raise sqlstate 'PT409' using message='This entry cannot be undone.';end if;
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 2 and 4 or octet_length(records::text)>512000 then raise invalid_parameter_value using message='Invalid money mutation.';end if;
 select count(*) filter(where x->>'table'='sales'),count(*) filter(where x->>'table'='credit_entries'),count(*) filter(where x->>'table'='events') into sale_count,entry_count,event_count from jsonb_array_elements(records) x;
 if sale_count<>(case when t.type like 'sale.%' then 1 else 0 end) or entry_count<>(case when has_credit or t.type like 'khata.%' then 1 else 0 end)
  or event_count<>(case when has_credit then 2 else 1 end) or sale_count+entry_count+event_count<>jsonb_array_length(records) then raise invalid_parameter_value using message='Invalid money mutation shape.';end if;
 expected_entry:=case when t.type='khata.undo' then t.plan->>'reversalId' else t.plan->>'entryId' end;
 select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0) into balance from public.credit_entries e where e.account_id=t.account_id;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if allowed is null or jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed)
   or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid money record fields.';end if;
  if table_name='sales' then
   if v->>'id' is distinct from t.plan->>'saleId' then raise invalid_parameter_value using message='Invalid sale identity.';end if;
   if t.type='sale.undo' then
    if (v->>'voided_at')::bigint is distinct from occurred::bigint or v->>'void_reason'<>'undo' then raise invalid_parameter_value using message='Invalid sale reversal.';end if;
    update public.sales s set voided_at=occurred,void_reason='undo',updated_at=greatest(t.created_at,s.created_at,occurred) where s.id=original.id;
    continue;
   end if;
   if v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.command_id::text or (v->>'created_at')::bigint is distinct from occurred::bigint
    or v->>'currency' is distinct from (select o.currency from public.outlets o where o.id=t.outlet_id)
    or (v->>'amount')::numeric<=0 or ((v->>'method'='credit') is distinct from has_credit)
    or v->>'customer_id' is distinct from t.customer_id::text or v->>'credit_account_id' is distinct from t.account_id::text
    or exists(select 1 from unnest(array['order_id','order_number','closing_id','delivery_fee','discount','voided_at','void_reason']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid counter sale.';end if;
   v:=jsonb_set(v,'{updated_at}',to_jsonb(greatest(t.created_at,occurred)));
  elsif table_name='credit_entries' then
   expected_audit:=case when has_credit then t.plan->>'creditEventId' else t.command_id::text end;
   if v->>'id' is distinct from expected_entry or v->>'event_id' is distinct from expected_audit
    or v->>'account_id' is distinct from t.account_id::text or v->>'customer_id' is distinct from t.customer_id::text
    or v->>'created_by' is distinct from t.actor_id::text or (v->>'created_at')::bigint is distinct from occurred::bigint
    or v->>'currency' is distinct from (select a.currency from public.credit_accounts a where a.id=t.account_id)
    or (v->>'sequence')::bigint is distinct from (select coalesce(max(e.sequence),0)+1 from public.credit_entries e where e.account_id=t.account_id)
    or exists(select 1 from unnest(array['order_id','refund_id','returns_charge_id','occurred_at']) k where v->>k is not null)
    or (t.type='sale.credit' and (v->>'type'<>'charge' or v->>'sale_id' is distinct from t.plan->>'saleId' or (v->>'amount')::numeric is distinct from
      (select (x->'values'->>'amount')::numeric from jsonb_array_elements(records) x where x->>'table'='sales')))
    or (t.type<>'sale.credit' and v->>'sale_id' is not null)
    or (t.type='khata.payment' and (v->>'type'<>'payment' or (v->>'amount')::numeric<=0 or (v->>'amount')::numeric>balance))
    or (t.type='khata.communication' and (v->>'type'<>'reminder' or (v->>'amount')::numeric<>0))
    or (t.type in ('sale.undo','khata.undo') and (v->>'type'<>'adjustment' or v->>'reversal_of' is distinct from target.id::text
      or (v->>'amount')::numeric is distinct from (case when target.type='payment' then target.amount else -target.amount end)
      or balance+(v->>'amount')::numeric<0))
    or (t.type not in ('sale.undo','khata.undo') and v->>'reversal_of' is not null) then raise invalid_parameter_value using message='Invalid khata entry.';end if;
   v:=jsonb_set(v,'{updated_at}',to_jsonb(greatest(t.created_at,occurred)));
  else
   if v->>'actor_type'<>'member' or v->>'actor_id' is distinct from t.actor_id::text or v->>'customer_id' is distinct from t.customer_id::text
    or exists(select 1 from unnest(array['order_id','order_revision','stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null)
    or (v->>'id'=t.command_id and not (v->>'command'=t.type or (t.type='sale.credit' and v->>'command'='sale.record') or (t.type='khata.communication' and v->>'command' in ('khata.reminder-sent','khata.receipt-sent','khata.call-sent'))))
    or (v->>'id'<>t.command_id and (not has_credit or v->>'id' is distinct from t.plan->>'creditEventId' or v->>'command'<>(case when t.type='sale.credit' then 'khata.charge' else 'khata.undo' end)))
    or v->>'undo_of' is distinct from (case when t.type='khata.undo' or (t.type='sale.undo' and v->>'id'<>t.command_id) then target.event_id::text when t.type='sale.undo' then original.event_id::text else null end) then raise invalid_parameter_value using message='Invalid money audit.';end if;
   v:=jsonb_set(v,'{at}',to_jsonb(t.created_at));
  end if;
  select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key) into keys,casts
   from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
  execute format('insert into public.%I(%s) select %s',table_name,keys,casts) using v;
 end loop;
 if not exists(select 1 from public.events e where e.id=t.command_id and e.business_id=t.business_id and e.outlet_id=t.outlet_id) then raise invalid_parameter_value using message='Missing primary audit.';end if;
 select * into sale from public.sales s where s.id=t.plan->>'saleId';
 select * into entry from public.credit_entries e where e.id=expected_entry;
 metadata:=jsonb_build_object('id',t.command_id,'occurredAt',occurred,'type',t.type,'outletId',t.outlet_id,'saleId',sale.id,'accountId',t.account_id,
  'entryId',entry.id,'amount',case when t.type='sale.undo' then -sale.amount when sale.id is not null then sale.amount else entry.amount end,
  'at',t.created_at,'saleUpdatedAt',sale.updated_at,'entrySequence',entry.sequence,'undoOf',case when t.type='sale.undo' then sale.id when t.type='khata.undo' then target.id else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt)
  values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.customer_id,t.request_hash,metadata);
 delete from private.money_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;
