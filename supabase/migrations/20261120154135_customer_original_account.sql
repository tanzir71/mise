-- Customer updates retain the existing device-selected account after a profile currency change.
-- No new public surface, table permission, command shape or receipt shape.
create or replace function private.prepare_customer_write(command_id public.ulid,ticket_id public.ulid,kind text,customer public.ulid,outlet public.ulid,account public.ulid,fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;secret text;at_ms public.utc_ms;
  chosen public.ulid;context json;actor_role text;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This customer change is unavailable.';end if;
  if command_id is null or ticket_id is null or customer is null or outlet is null or kind is null
    or kind not in ('customer.create','customer.update','customer.archive','customer.restore','khata.settings')
    or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or (kind not in ('khata.settings','customer.update') and account is not null) then
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

create or replace function private.prepare_customer_intent(command_id public.ulid,ticket_id public.ulid,kind text,customer public.ulid,outlet public.ulid,account public.ulid,fingerprint text,record_ids jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prepared jsonb;t private.customer_write_tickets;bound_account public.ulid;
begin
 if kind<>'khata.settings' and account is not null then
  raise invalid_parameter_value using message='Choose a valid customer change.';end if;
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
 -- This lookup takes no row lock before the common business/outlet lock order.
 -- prepare_customer_write revalidates the selected account and caller scope.
 bound_account:=account;
 if kind='customer.update' then
  select a.id into bound_account from public.credit_accounts a join public.outlets o on o.id=a.outlet_id and o.business_id=a.business_id
   where a.id=record_ids->>'accountId' and a.customer_id=customer and a.outlet_id=outlet;
 end if;
 prepared:=private.prepare_customer_write(command_id,ticket_id,kind,customer,outlet,bound_account,fingerprint);
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

revoke all on function private.prepare_customer_write(public.ulid,public.ulid,text,public.ulid,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
