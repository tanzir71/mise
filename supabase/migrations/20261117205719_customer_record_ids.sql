-- Device-generated customer/account/opening/audit IDs are immutable intent data.
alter table private.customer_write_tickets add column ids jsonb;
create function private.prepare_customer_intent(command_id public.ulid,ticket_id public.ulid,kind text,customer public.ulid,outlet public.ulid,account public.ulid,fingerprint text,record_ids jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prepared jsonb;t private.customer_write_tickets;
begin
 if kind in ('customer.archive','customer.restore') then
  if record_ids is not null then raise invalid_parameter_value using message='A status action has no companion IDs.';end if;
 else
  if record_ids is null or jsonb_typeof(record_ids)<>'object' or (select count(*) from jsonb_object_keys(record_ids))<>4
   or exists(select 1 from jsonb_object_keys(record_ids) k where k not in ('accountId','accountEventId','openingEntryId','openingEventId'))
   or exists(select 1 from jsonb_each(record_ids) e where jsonb_typeof(e.value)<>'string' or e.value#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
   or (select count(distinct v) from (select e.value#>>'{}' v from jsonb_each(record_ids) e union all select command_id::text union all select customer::text) all_ids)<>6
   or (account is not null and account::text is distinct from record_ids->>'accountId') then
   raise invalid_parameter_value using message='Keep the device record IDs.';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 if exists(select 1 from private.customer_write_tickets x where x.command_id=prepare_customer_intent.command_id and x.auth_user_id=(select auth.uid()) and x.ids is distinct from record_ids) then
  raise unique_violation using message='Keep the original device record IDs.';end if;
 prepared:=private.prepare_customer_write(command_id,ticket_id,kind,customer,outlet,account,fingerprint);
 if prepared->>'done'='true' then return prepared;end if;
 select * into t from private.customer_write_tickets x where x.id=ticket_id;
 if kind not in ('customer.archive','customer.restore') then
  if t.account_id is not null and t.account_id::text is distinct from record_ids->>'accountId' then
   raise sqlstate 'PT409' using message='The khata identity changed. Review the retained intent.',detail='customer_identity_conflict';end if;
  if t.account_id is null and exists(select 1 from public.credit_accounts a where a.id=record_ids->>'accountId') then
   raise unique_violation using message='The planned khata ID already exists.';end if;
 end if;
 update private.customer_write_tickets x set ids=record_ids where x.id=ticket_id;
 return prepared;
end $$;
-- Close the unplanned RPC and its private implementation to ordinary callers.
revoke all on function public.prepare_customer_write(public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,text),
 private.prepare_customer_write(public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
revoke all on function private.prepare_customer_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.prepare_customer_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,text,jsonb) to authenticated;
create function public.prepare_customer_intent(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_customer_id public.ulid,p_outlet_id public.ulid,p_account_id public.ulid,p_hash text,p_ids jsonb) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_customer_intent(p_id,p_ticket_id,p_type,p_customer_id,p_outlet_id,p_account_id,p_hash,p_ids)$$;
revoke all on function public.prepare_customer_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.prepare_customer_intent(public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,text,jsonb) to authenticated;

create or replace function private.finish_customer_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.customer_write_tickets;r jsonb;v jsonb;table_name text;columns_allowed jsonb;keys text;casts text;updates text;
  old_customer public.customers;old_account public.credit_accounts;account public.credit_accounts;customer public.customers;
  at_ms public.utc_ms;customer_count integer;account_count integer;entry_count integer;event_count integer;metadata jsonb;
  specs jsonb:='{"customers":["id","created_at","updated_at","business_id","name","nickname","phone","address","notes","tags","consent","archived_at"],"credit_accounts":["id","created_at","updated_at","outlet_id","customer_id","currency","allowed","credit_limit","reminder","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
  if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare this change again.';end if;
  select * into t from private.customer_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
  if not found then raise sqlstate 'PT409' using message='Prepare this change again.';end if;
  perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
  perform 1 from public.businesses b where b.id=t.business_id for update;
  perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
  select * into t from private.customer_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Prepare this change again.';end if;
  if t.type not in ('customer.archive','customer.restore') and t.ids is null then raise sqlstate 'PT409' using message='Prepare the device record IDs again.';end if;
  perform private.customer_status_scope(t.business_id,t.outlet_id,t.actor_id,t.customer_id,t.type);
  if private.customer_write_snapshot(t.business_id,t.outlet_id,t.customer_id,t.account_id,t.type)<>t.snapshot_hash then
    raise sqlstate 'PT409' using message='The customer changed. Prepare again.',detail='customer_snapshot_changed';end if;
  if t.type='customer.archive' and exists(select 1 from public.credit_entries e where e.business_id=t.business_id and e.customer_id=t.customer_id group by e.account_id
    having sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end)<>0) then
    raise sqlstate 'PT409' using message='Settle all khata before archiving.';end if;
  if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
  select * into old_customer from public.customers c where c.id=t.customer_id;
  select * into old_account from public.credit_accounts a where a.id=t.account_id;
  if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 1 and 6 or octet_length(records::text)>512000 then
    raise invalid_parameter_value using message='Invalid customer mutation.';end if;
  select count(*) filter(where x->>'table'='customers'),count(*) filter(where x->>'table'='credit_accounts'),
    count(*) filter(where x->>'table'='credit_entries'),count(*) filter(where x->>'table'='events')
    into customer_count,account_count,entry_count,event_count from jsonb_array_elements(records) x;
  if customer_count<>(case when t.type='khata.settings' then 0 else 1 end) or account_count>1 or entry_count>1
    or (t.type in ('customer.archive','customer.restore') and (account_count<>0 or entry_count<>0))
    or (t.type='khata.settings' and (account_count<>1 or entry_count<>0))
    or (t.type in ('customer.create','customer.update') and t.account_id is null and account_count<>1)
    or (entry_count=1 and (account_count<>1 or t.account_id is not null))
    or event_count<>(case when t.type='khata.settings' then 1 else 1+account_count+entry_count end)
    or customer_count+account_count+entry_count+event_count<>jsonb_array_length(records) then raise invalid_parameter_value using message='Invalid customer mutation shape.';end if;
  for r in select x from jsonb_array_elements(records) x loop
    table_name:=r->>'table';v:=r->'values';columns_allowed:=specs->table_name;
    if columns_allowed is null or jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(columns_allowed)
      or exists(select 1 from jsonb_object_keys(v) k where not columns_allowed ? k)
      or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
      or v->>'business_id' is distinct from t.business_id::text or (table_name<>'customers' and v->>'outlet_id' is distinct from t.outlet_id::text) then
      raise invalid_parameter_value using message='Invalid customer record fields.';end if;
    if table_name='credit_accounts' and v->>'id' is distinct from t.ids->>'accountId' then raise invalid_parameter_value using message='Keep the planned account ID.';end if;
    if table_name='credit_entries' and (v->>'id' is distinct from t.ids->>'openingEntryId' or v->>'event_id' is distinct from t.ids->>'openingEventId') then raise invalid_parameter_value using message='Keep the planned opening IDs.';end if;
    if table_name='events' and v->>'id'<>t.command_id and v->>'id' is distinct from (case when v->>'command'='khata.opening-balance' then t.ids->>'openingEventId' when v->>'command' in ('khata.create','khata.settings') then t.ids->>'accountEventId' else null end) then raise invalid_parameter_value using message='Keep the planned audit ID.';end if;
    if table_name='customers' then
      if v->>'id' is distinct from t.customer_id::text or (t.type<>'customer.create' and (v->>'created_at')::bigint<>old_customer.created_at)
        or (t.type='customer.archive' and (v->>'archived_at')::bigint is distinct from t.created_at)
        or (t.type='customer.restore' and v->>'archived_at' is not null) then raise invalid_parameter_value using message='Invalid customer identity.';end if;
      if t.type in ('customer.archive','customer.restore') then
        update public.customers c set archived_at=(v->>'archived_at')::public.utc_ms,updated_at=(v->>'updated_at')::public.utc_ms where c.id=t.customer_id;
        continue;
      end if;
    elsif table_name='credit_accounts' then
      if v->>'customer_id' is distinct from t.customer_id::text or (t.account_id is not null and v->>'id' is distinct from t.account_id::text)
        or (t.account_id is null and exists(select 1 from public.credit_accounts a where a.id=v->>'id'))
        or (t.account_id is not null and (v->>'currency'<>old_account.currency or (v->>'created_at')::bigint<>old_account.created_at))
        or (t.account_id is null and v->>'currency'<>(select o.currency from public.outlets o where o.id=t.outlet_id)) then raise invalid_parameter_value using message='Invalid khata identity.';end if;
    elsif table_name='credit_entries' then
      if v->>'customer_id' is distinct from t.customer_id::text or v->>'created_by' is distinct from t.actor_id::text
        or v->>'type'<>'adjustment' or (v->>'amount')::bigint<=0 or (v->>'sequence')::bigint<>1 or v->>'occurred_at' is null or (v->>'occurred_at')::bigint>t.created_at
        or v->>'account_id' is distinct from (select x->'values'->>'id' from jsonb_array_elements(records) x where x->>'table'='credit_accounts')
        or not exists(select 1 from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=v->>'event_id' and x->'values'->>'command'='khata.opening-balance')
        or exists(select 1 from unnest(array['sale_id','order_id','refund_id','returns_charge_id','method_name','reversal_of','purpose','over_limit']) k where v->>k is not null)
        or exists(select 1 from public.credit_entries e where e.account_id=v->>'account_id') then raise invalid_parameter_value using message='Invalid opening balance.';end if;
    else
      if v->>'customer_id' is distinct from t.customer_id::text or v->>'actor_type'<>'member' or v->>'actor_id' is distinct from t.actor_id::text
        or exists(select 1 from unnest(array['undo_of','order_id','order_revision','stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null)
        or (v->>'id'=t.command_id and not (v->>'command'=t.type or (t.type='khata.settings' and v->>'command' in ('khata.create','khata.settings'))))
        or (v->>'id'<>t.command_id and v->>'command' not in ('khata.create','khata.settings','khata.opening-balance')) then raise invalid_parameter_value using message='Invalid customer audit.';end if;
      v:=jsonb_set(v,'{at}',to_jsonb(t.created_at));
    end if;
    select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key),
      string_agg(format('%I=excluded.%I',a.key,a.key),',' order by a.key) filter(where a.key not in ('id','business_id') and (a.key<>'notes' or table_name='customers'))
      into keys,casts,updates from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
    execute format('insert into public.%I(%s) select %s%s',table_name,keys,casts,
      case when table_name in ('customers','credit_accounts') then ' on conflict(id) do update set '||updates else '' end) using v;
  end loop;
  if not exists(select 1 from public.events e where e.id=t.command_id and e.business_id=t.business_id and e.outlet_id=t.outlet_id) then raise invalid_parameter_value using message='Missing primary audit.';end if;
  insert into public.customer_outlets(business_id,outlet_id,customer_id) values(t.business_id,t.outlet_id,t.customer_id) on conflict do nothing;
  select * into customer from public.customers c where c.id=t.customer_id;
  if t.type not in ('customer.archive','customer.restore') then
    select * into account from public.credit_accounts a where a.id=coalesce((select x->'values'->>'id' from jsonb_array_elements(records) x where x->>'table'='credit_accounts'),t.account_id::text);
  end if;
  metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'customerId',t.customer_id,'outletId',t.outlet_id,'accountId',account.id,'at',t.created_at,
    'accountEventId',case when t.type='khata.settings' then t.command_id::text else (select x->'values'->>'id' from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'command' in ('khata.create','khata.settings')) end,
    'entryId',(select x->'values'->>'id' from jsonb_array_elements(records) x where x->>'table'='credit_entries'),
    'openingEventId',(select x->'values'->>'id' from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'command'='khata.opening-balance'),
    'customerUpdatedAt',customer.updated_at,'accountUpdatedAt',account.updated_at);
  insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt)
    values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.customer_id,t.request_hash,metadata);
  delete from private.customer_write_tickets x where x.command_id=t.command_id;
  return metadata;
end $$;
