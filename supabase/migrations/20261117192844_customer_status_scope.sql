-- Shared contact status affects every associated outlet. Check every assignment;
-- ordinary profile/terms contexts and snapshots do not read another outlet's ledger.
create function private.customer_status_scope(business public.ulid,outlet public.ulid,actor public.ulid,customer public.ulid,kind text) returns void
language plpgsql security invoker set search_path='' as $$declare link record;
begin
 if kind not in ('customer.archive','customer.restore') then return;end if;
 perform 1 from public.customer_outlets a where a.business_id=business and a.customer_id=customer and a.outlet_id=outlet for share;
 if not found then raise insufficient_privilege using message='This customer change is unavailable.';end if;
 if exists(select 1 from public.members m where m.business_id=business and m.id=actor and m.role='owner') then return;end if;
 for link in select a.outlet_id from public.customer_outlets a where a.business_id=business and a.customer_id=customer order by a.outlet_id for share loop
  perform 1 from public.member_outlets a where a.business_id=business and a.member_id=actor and a.outlet_id=link.outlet_id for share;
  if not found then raise insufficient_privilege using message='This customer change is unavailable.';end if;
 end loop;
end $$;
create function private.customer_write_snapshot(business public.ulid,outlet public.ulid,customer public.ulid,account public.ulid,kind text) returns bytea
language sql volatile security invoker set search_path='' as $$
 select sha256(convert_to(json_build_object(
  'business',(select row_to_json(b) from public.businesses b where b.id=business),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'customer',(select row_to_json(c) from public.customers c where c.business_id=business and c.id=customer),
  'accounts',(select coalesce(json_agg(row_to_json(a) order by a.id),'[]') from public.credit_accounts a where a.business_id=business and a.customer_id=customer
    and (kind in ('customer.archive','customer.restore') or (a.outlet_id=outlet and (a.id=account or (account is null and a.currency=(select o.currency from public.outlets o where o.id=outlet)))))),
  'entries',case when kind in ('customer.archive','customer.restore') then (select coalesce(json_agg(row_to_json(e) order by e.id),'[]') from public.credit_entries e where e.business_id=business and e.customer_id=customer) else '[]'::json end,
  'assignments',(select coalesce(json_agg(row_to_json(a) order by a.outlet_id),'[]') from public.customer_outlets a where a.business_id=business and a.customer_id=customer and (kind in ('customer.archive','customer.restore') or a.outlet_id=outlet))
 )::text,'UTF8'))
$$;
revoke all on function private.customer_status_scope(public.ulid,public.ulid,public.ulid,public.ulid,text),private.customer_write_snapshot(public.ulid,public.ulid,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;

create or replace function private.prepare_customer_write(command_id public.ulid,ticket_id public.ulid,kind text,customer public.ulid,outlet public.ulid,account public.ulid,fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;secret text;at_ms public.utc_ms;
  chosen public.ulid;context json;actor_role text;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This customer change is unavailable.';end if;
  if command_id is null or ticket_id is null or customer is null or outlet is null or kind is null
    or kind not in ('customer.create','customer.update','customer.archive','customer.restore','khata.settings')
    or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or (kind<>'khata.settings' and account is not null) then
    raise invalid_parameter_value using message='Choose a valid customer change.';end if;
  perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
  select * into old from private.shop_command_receipts r where r.id=command_id;
  if found then
    actor:=private.public_link_actor(old.business_id,old.outlet_id);
    if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This change is unavailable.';end if;
    if old.type<>kind or old.customer_id<>customer or old.outlet_id<>outlet or old.request_hash<>fingerprint then
      raise unique_violation using message='This command ID was already used.';end if;
    return jsonb_build_object('done',true,'receipt',old.receipt);
  end if;
  select o.business_id into business from public.outlets o where o.id=outlet;
  if not found then raise insufficient_privilege using message='This change is unavailable.';end if;
  actor:=private.public_link_actor(business,outlet);
  -- Shared contacts/phone uniqueness and cross-outlet archive balances require
  -- this business lock before the common outlet lock. Future ledger writers use it too.
  perform 1 from public.businesses b where b.id=business for update;
  perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
  if exists(select 1 from public.events e where e.id=command_id) then raise unique_violation using message='This command ID was already used.';end if;
  if kind='customer.create' then
    if exists(select 1 from public.customers c where c.id=customer) then raise unique_violation using message='This customer ID already exists.';end if;
  else
    perform 1 from public.customers c where c.business_id=business and c.id=customer for update;
    if not found then raise insufficient_privilege using message='This change is unavailable.';end if;
    select m.role into actor_role from public.members m where m.id=actor;
    if actor_role<>'owner' and not exists(select 1 from public.customer_outlets a where a.business_id=business and a.customer_id=customer and a.outlet_id=outlet) then
      raise insufficient_privilege using message='This change is unavailable.';end if;
  end if;
  perform private.customer_status_scope(business,outlet,actor,customer,kind);
  if account is not null then
    select a.id into chosen from public.credit_accounts a where a.business_id=business and a.outlet_id=outlet and a.customer_id=customer and a.id=account;
    if not found then raise insufficient_privilege using message='This khata is unavailable.';end if;
  elsif kind not in ('customer.archive','customer.restore') then
    select a.id into chosen from public.credit_accounts a join public.outlets o on o.id=a.outlet_id
      where a.business_id=business and a.outlet_id=outlet and a.customer_id=customer and a.currency=o.currency;
  end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  delete from private.customer_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
  if exists(select 1 from private.customer_write_tickets t where t.command_id=prepare_customer_write.command_id and t.auth_user_id=(select auth.uid()) and t.request_hash<>fingerprint) then
    raise unique_violation using message='Keep the original command intent.';end if;
  delete from private.customer_write_tickets t where t.command_id=prepare_customer_write.command_id and t.auth_user_id=(select auth.uid());
  if (select count(*) from private.customer_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  insert into private.customer_write_tickets(id,command_id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,account_id,request_hash,snapshot_hash,token_hash,created_at,expires_at)
    values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,customer,chosen,fingerprint,private.customer_write_snapshot(business,outlet,customer,chosen,kind),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
  select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=business),
    'outlet',(select row_to_json(o) from public.outlets o where o.id=outlet),
    'customer',(select row_to_json(c) from public.customers c where c.business_id=business and c.id=customer),
    'accounts',(select coalesce(json_agg(row_to_json(a)),'[]') from public.credit_accounts a where a.id=chosen),
    'hasBalance',kind in ('customer.archive','customer.restore') and exists(select 1 from public.credit_entries e where e.business_id=business and e.customer_id=customer group by e.account_id
      having sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end)<>0)) into context;
  return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

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
      v:=jsonb_set(v,'{at}',to_jsonb(at_ms));
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
  metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'customerId',t.customer_id,'outletId',t.outlet_id,'accountId',account.id,'at',at_ms,
    'customerUpdatedAt',customer.updated_at,'accountUpdatedAt',account.updated_at);
  insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt)
    values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.customer_id,t.request_hash,metadata);
  delete from private.customer_write_tickets x where x.command_id=t.command_id;
  return metadata;
end $$;
