-- Preserve the complete writer and existing ACLs. Private guarded completion
-- is the only path that may cross an unresolved withdrawal financial fence.
create index events_order_resolution_idx on public.events(business_id,outlet_id,order_id,order_revision) where command='sync.resolve';
create or replace function private.finish_order_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
<<order_mutation>>
declare t private.order_write_tickets;r jsonb;v jsonb;table_name text;allowed jsonb;keys text;casts text;updates text;immutable text;unchanged boolean;
 at_ms public.utc_ms;before_order public.orders;saved_order public.orders;before_sale public.sales;saved_sale public.sales;before_refund public.order_refunds;saved_refund public.order_refunds;
 outlet_row public.outlets;account_row public.credit_accounts;charge public.credit_entries;returned public.credit_entries;reversed public.credit_entries;new_entry public.credit_entries;
 f jsonb;metadata jsonb;primary_command text;event_command text;revision_value bigint;balance numeric;refund_due numeric;expected_amount numeric;account_id public.ulid;customer_id public.ulid;
 new_sale boolean;cancel_sale boolean;restore_sale boolean;finance_allowed boolean;insert_only boolean;expected_event text;expected_undo text;expected_customer text;entry_id public.ulid;
 specs jsonb:='{"orders":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","business_type","sequence","number","source","source_text","customer_id","customer_name","customer_phone","type","status","status_changed_at","status_event_id","lines","subtotal","delivery_fee","discount","total","currency","timezone","address","table_label","scheduled_for","payment","handled_by","business_id"],"outlets":["id","created_at","updated_at","business_id","name","address","timezone","currency","shop_link","credit_messaging","order_warning_minutes"],"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"order_notes":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","order_id","text","business_id"],"order_communications":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","order_id","purpose","channel","text","business_id"],"order_refunds":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","sale_id","customer_id","account_id","amount","currency","method","method_name","note","credit_entry_id","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare this order change again.';end if;
 select * into t from private.order_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Prepare this order change again.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 if exists(select 1 from private.shop_command_receipts r where r.id=t.command_id) then raise sqlstate 'PT409' using message='Read the original action outcome again.';end if;
 perform 1 from public.businesses b where b.id=t.business_id for share;
 select * into outlet_row from public.outlets x where x.business_id=t.business_id and x.id=t.outlet_id for update;
 select * into t from private.order_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Prepare this order change again.';end if;
 if sha256(convert_to(private.order_write_context(t.business_id,t.outlet_id,t.type,t.plan)::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The order source changed. Prepare again.',detail='order_snapshot_changed';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
 -- A revision increment alone cannot fence later offline money: an old
 -- dependent action can coincidentally hold that same revision, even after a
 -- nonfinancial note. Require a deliberately reviewed financial completion.
 if (t.type in ('order.payment','order.payment-undo','order.refund','order.refund-undo')
     or t.type in ('order.create','order.update') and jsonb_typeof(t.plan->'settlement')='object'
     or t.type in ('order.status','order.status-undo') and t.plan->>'sourceSaleId' is not null)
  and coalesce((select max(e.order_revision) from public.events e where e.command='sync.resolve' and e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.order_id=t.plan->>'orderId'
    and case when e.command='sync.resolve' then e.after_data->>'outcome'='withdrawn' else false end),-1)
   >coalesce((select max(e.order_revision) from public.events e where e.command='sync.resolve' and e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.order_id=t.plan->>'orderId'
    and case when e.command='sync.resolve' then e.after_data->>'outcome'='replaced'
      and coalesce(e.after_data->'receipt'->'replacement'->'receipt'->>'saleId',e.after_data->'receipt'->'replacement'->'receipt'->>'entryId',e.after_data->'receipt'->'replacement'->'receipt'->>'refundId') is not null else false end),-1)
  and not exists(select 1 from private.order_review_tickets review where review.replacement_id=t.command_id and review.business_id=t.business_id and review.outlet_id=t.outlet_id
    and review.actor_id=t.actor_id and review.auth_user_id=t.auth_user_id and review.type=t.type and review.snapshot_hash=t.snapshot_hash and review.expires_at>at_ms
    and current_setting('mise.order_review_completion',true)=review.id::text||':'||encode(review.token_hash,'hex'))
 then raise sqlstate 'PT409' using message='Review the withdrawn order and current financial values.';end if;
 select * into before_order from public.orders x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'orderId';
 select * into before_refund from public.order_refunds x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.order_id=before_order.id and x.id=t.plan->>'refundId';
 select * into before_sale from public.sales x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.order_id=before_order.id and x.id=coalesce(t.plan->>'sourceSaleId',before_refund.sale_id::text);
 if t.type not in ('order.create','order.warning-settings') and (before_order.id is null or before_order.revision>=9007199254740991 or case when t.type in ('order.note','order.communication') or t.type='order.update' and t.plan->>'settlementId' is null or t.type='order.status' and t.plan->>'status'<>'cancelled' then before_order.revision<(t.plan->>'revision')::bigint else before_order.revision<>(t.plan->>'revision')::bigint end) then raise sqlstate 'PT409' using message='Review the latest order revision.';end if;
 if t.occurred_at>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 if t.type='order.payment-undo' and (at_ms<coalesce(before_sale.created_at,(t.plan->>'sourcePaymentAt')::bigint) or at_ms-coalesce(before_sale.created_at,(t.plan->>'sourcePaymentAt')::bigint)>600000
  or t.occurred_at<coalesce(before_sale.created_at,(t.plan->>'sourcePaymentAt')::bigint) or before_sale.closing_id is not null or before_sale.voided_at is not null) then raise sqlstate 'PT409' using message='Undo the original payment within ten minutes.';end if;
 if t.type='order.refund-undo' and (before_refund.id is null or before_refund.voided_at is not null or at_ms<before_refund.created_at or at_ms-before_refund.created_at>600000 or t.occurred_at<before_refund.created_at) then raise sqlstate 'PT409' using message='Undo the original refund once within ten minutes.';end if;
 f:=t.plan->'finance';new_sale:=t.type='order.payment' or t.plan->>'settlementId' is not null;
 cancel_sale:=t.type='order.status' and t.plan->>'status'='cancelled';restore_sale:=t.type='order.status-undo' and before_order.status='cancelled';
 finance_allowed:=new_sale or cancel_sale or restore_sale or t.type in ('order.payment-undo','order.refund','order.refund-undo');
 customer_id:=case when t.type in ('order.create','order.update') then (t.plan->>'customerId')::public.ulid else before_order.customer_id end;
 account_id:=coalesce((t.plan->>'accountId')::public.ulid,before_sale.credit_account_id,before_refund.account_id,
  (select a.id from public.credit_accounts a where t.plan->'bindings'->>'method'='credit' and a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.customer_id=order_mutation.customer_id and a.currency=coalesce(before_order.currency,outlet_row.currency)));
 select * into account_row from public.credit_accounts a where a.business_id=t.business_id and a.outlet_id=t.outlet_id and a.id=order_mutation.account_id and a.customer_id=order_mutation.customer_id;
 if account_id is not null and account_row.id is null then raise insufficient_privilege using message='This khata is unavailable.';end if;
 select * into charge from public.credit_entries e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.account_id=order_mutation.account_id and e.sale_id=before_sale.id and e.order_id=before_order.id and e.type='charge';
 select * into reversed from public.credit_entries e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.account_id=order_mutation.account_id and e.id=before_refund.credit_entry_id;
 select * into returned from public.credit_entries e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.account_id=order_mutation.account_id and e.sale_id=before_sale.id and e.order_id=before_order.id and e.returns_charge_id=charge.id
  and not exists(select 1 from public.credit_entries u where u.reversal_of=e.id) order by e.sequence desc limit 1;
 select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0) into balance from public.credit_entries e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.account_id=order_mutation.account_id;
 refund_due:=coalesce(before_sale.amount,0)+coalesce(returned.amount,0)-(select coalesce(sum(x.amount),0) from public.order_refunds x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.order_id=before_order.id and x.voided_at is null);
 if restore_sale and exists(select 1 from public.order_refunds x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.order_id=before_order.id and x.voided_at is null) then raise sqlstate 'PT409' using message='Correct the recorded refunds before restoring cancellation.';end if;
 revision_value:=coalesce(before_order.revision,0)+1+case when t.plan->>'settlementId' is not null then 1 else 0 end;
 primary_command:=case when cancel_sale then 'order.cancel' when t.type='order.communication' then 'order.'||(t.plan->'bindings'->>'purpose')||'-sent' else t.type end;
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 2 and 12 or octet_length(records::text)>12000000
  or records->0->>'table' is distinct from (case when t.type='order.warning-settings' then 'outlets' else 'orders' end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'=case when t.type='order.warning-settings' then 'outlets' else 'orders' end)<>1
  or exists(select 1 from jsonb_array_elements(records) x group by x->>'table',x->'values'->>'id' having count(*)>1)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=t.command_id::text)<>1
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='order_notes')<>(case when t.type='order.note' then 1 else 0 end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='order_communications')<>(case when t.type='order.communication' then 1 else 0 end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='order_refunds')<>(case when t.type in ('order.refund','order.refund-undo') then 1 else 0 end) then raise invalid_parameter_value using message='Invalid order mutation shape.';end if;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if (select count(*) from jsonb_object_keys(r))<>2 or not r ? 'table' or not r ? 'values' or allowed is null or jsonb_typeof(v) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed) or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or table_name<>'outlets' and v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid order record fields.';end if;
  insert_only:=table_name in ('events','credit_entries','order_notes','order_communications');
  if table_name='orders' then
   if t.type='order.warning-settings' or v->>'id' is distinct from t.plan->>'orderId' or (v->>'revision')::bigint is distinct from revision_value
    or v->>'created_by' is distinct from coalesce(before_order.created_by,t.actor_id)::text or (v->>'created_at')::bigint is distinct from coalesce(before_order.created_at,t.occurred_at)
    or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(before_order.created_at,t.occurred_at),coalesce(before_order.updated_at,t.occurred_at))
    or v->>'event_id' is distinct from coalesce(t.plan->>'settlementId',t.command_id::text)
    or v->>'currency' is distinct from coalesce(before_order.currency,outlet_row.currency) or v->>'timezone' is distinct from coalesce(before_order.timezone,outlet_row.timezone)
    or (v->>'total')::numeric is not null and (v->>'total')::numeric<>(v->>'subtotal')::numeric+(v->>'delivery_fee')::numeric-(v->>'discount')::numeric
    or before_order.id is not null and ((v->>'sequence')::bigint<>before_order.sequence or v->>'number'<>before_order.number or v->>'business_type'<>before_order.business_type)
    or v->>'handled_by' is distinct from coalesce(before_order.handled_by,t.actor_id)::text
    or v->>'customer_id' is distinct from customer_id::text
    or t.type='order.update' and (v->>'status' is distinct from before_order.status or v->>'status_event_id' is distinct from before_order.status_event_id::text or (v->>'status_changed_at')::bigint is distinct from before_order.status_changed_at)
    or t.type='order.status' and (v->>'status' is distinct from t.plan->>'status' or v->>'status_event_id' is distinct from (case when t.plan->>'status'<>'cancelled' and before_order.status=t.plan->>'status' then before_order.status_event_id::text else t.command_id::text end) or (v->>'status_changed_at')::bigint is distinct from (case when t.plan->>'status'<>'cancelled' and before_order.status=t.plan->>'status' then before_order.status_changed_at else t.occurred_at end))
    or t.type='order.status-undo' and v->>'status_event_id' is distinct from t.command_id::text
    or exists(select 1 from public.customer_outlets co right join public.customers c on c.business_id=co.business_id and c.id=co.customer_id where c.id=v->>'customer_id' and (c.business_id<>t.business_id or not exists(select 1 from public.customer_outlets x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.customer_id=c.id))) then raise invalid_parameter_value using message='Invalid order identity, scope, revision or totals.';end if;
   if t.type='order.create' then
    if before_order.id is not null or (v->>'sequence')::bigint<>(select coalesce(max(x.sequence),0)+1 from public.orders x where x.business_id=t.business_id and x.outlet_id=t.outlet_id)
     or v->>'number'<>'A-'||lpad(v->>'sequence',greatest(4,length(v->>'sequence')),'0')
     or v->>'business_type' is distinct from (select b.business_type from public.businesses b where b.id=t.business_id)
     or v->>'status_event_id' is distinct from t.command_id::text or (v->>'status_changed_at')::bigint is distinct from t.occurred_at
     or v->>'status' is distinct from (case v->>'business_type' when 'food_stall' then 'ordered' when 'corner_shop' then 'requested' else 'new' end) then raise invalid_parameter_value using message='Keep the allocated outlet order number and flow.';end if;insert_only:=true;
   end if;
  elsif table_name='outlets' then
   if t.type<>'order.warning-settings' or v->>'id' is distinct from t.outlet_id::text or (v->>'order_warning_minutes')::bigint is distinct from (t.plan->'bindings'->>'minutes')::bigint
    or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,outlet_row.created_at) then raise invalid_parameter_value using message='Invalid order warning settings.';end if;
  elsif table_name in ('order_notes','order_communications') then
   if v->>'id' is distinct from (case table_name when 'order_notes' then t.plan->>'noteId' else t.plan->>'communicationId' end) or v->>'order_id' is distinct from before_order.id::text
    or v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.command_id::text or (v->>'revision')::bigint is distinct from revision_value
    or (v->>'created_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at)
    or table_name='order_notes' and v->>'text' is distinct from t.plan->'bindings'->>'noteJson'
    or table_name='order_communications' and (v->>'text' is distinct from t.plan->'bindings'->>'textJson' or v->>'purpose' is distinct from t.plan->'bindings'->>'purpose' or v->>'channel' is distinct from t.plan->'bindings'->>'channel') then raise invalid_parameter_value using message='Invalid order history record.';end if;
  elsif table_name='sales' then
   if not finance_allowed or t.type in ('order.refund','order.refund-undo') or v->>'order_id' is distinct from saved_order.id::text or v->>'customer_id' is distinct from saved_order.customer_id::text
    or v->>'currency' is distinct from saved_order.currency or v->>'order_number' is distinct from saved_order.number or (v->>'amount')::bigint is distinct from saved_order.total then raise invalid_parameter_value using message='Invalid linked order receipt.';end if;
   if new_sale then
    if v->>'id' is distinct from f->>'saleId' or v->>'event_id' is distinct from f->>'saleEventId' or v->>'created_by' is distinct from t.actor_id::text
     or (v->>'created_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at)
     or v->>'voided_at' is not null or v->>'void_reason' is not null or v->>'closing_id' is not null or (v->>'amount')::bigint<=0 then raise invalid_parameter_value using message='Invalid new order receipt.';end if;insert_only:=true;
   else
    if v->>'id' is distinct from before_sale.id::text or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,before_sale.created_at)
     or (v->>'voided_at')::bigint is distinct from (case when restore_sale then null else t.occurred_at end)
     or v->>'void_reason' is distinct from (case when restore_sale then null when cancel_sale then 'order-cancel' else 'undo' end)
     or restore_sale and (before_sale.voided_at is null or before_sale.void_reason is distinct from 'order-cancel') or not restore_sale and before_sale.voided_at is not null then raise invalid_parameter_value using message='Keep the original receipt when reversing payment.';end if;
   end if;
  elsif table_name='order_refunds' then
   if v->>'order_id' is distinct from before_order.id::text or v->>'sale_id' is distinct from before_sale.id::text or v->>'customer_id' is distinct from before_order.customer_id::text
    or v->>'account_id' is distinct from before_sale.credit_account_id::text or v->>'currency' is distinct from before_order.currency or before_order.status<>'cancelled' or before_sale.void_reason is distinct from 'order-cancel' then raise invalid_parameter_value using message='Invalid order refund links.';end if;
   if t.type='order.refund' then
    if v->>'id' is distinct from f->>'refundId' or v->>'event_id' is distinct from f->>'refundEventId' or v->>'created_by' is distinct from t.actor_id::text
     or (v->>'created_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at) or v->>'voided_at' is not null
     or (v->>'amount')::bigint is distinct from (t.plan->'bindings'->>'refundAmount')::bigint or (v->>'amount')::bigint not between 1 and refund_due
     or v->>'credit_entry_id' is distinct from (case when account_id is not null then f->>'entryId' else null end) then raise invalid_parameter_value using message='Keep the reviewed remaining refund amount.';end if;insert_only:=true;
   elsif t.type<>'order.refund-undo' or v->>'id' is distinct from before_refund.id::text or (v->>'voided_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,before_refund.created_at) then raise invalid_parameter_value using message='Keep the original refund when undoing.';end if;
  elsif table_name='credit_entries' then
   if not finance_allowed or account_row.id is null or v->>'id' is distinct from f->>'entryId' or v->>'event_id' is distinct from f->>'creditEventId'
    or v->>'account_id' is distinct from account_id::text or v->>'customer_id' is distinct from customer_id::text or v->>'currency' is distinct from account_row.currency or v->>'order_id' is distinct from saved_order.id::text
    or v->>'created_by' is distinct from t.actor_id::text or (v->>'created_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at)
    or v->>'sale_id' is distinct from (case when new_sale then f->>'saleId' else before_sale.id::text end)
    or v->>'purpose' is not null or v->>'occurred_at' is not null or not cancel_sale and v->>'returns_charge_id' is not null
    or (v->>'sequence')::bigint<>(select coalesce(max(e.sequence),0)+1 from public.credit_entries e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.account_id=order_mutation.account_id) then raise invalid_parameter_value using message='Invalid linked credit entry.';end if;
   if new_sale then
    if v->>'type'<>'charge' or (v->>'amount')::bigint is distinct from saved_order.total or v->>'sale_id' is distinct from f->>'saleId' or not account_row.allowed
     or account_row.currency<>outlet_row.currency or exists(select 1 from public.customers c where c.id=order_mutation.customer_id and c.archived_at is not null)
     or balance+saved_order.total>account_row.credit_limit and (v->>'over_limit')::jsonb is distinct from jsonb_build_object('balance',balance,'limit',account_row.credit_limit)
     or v->>'reversal_of' is not null or v->>'returns_charge_id' is not null or v->>'refund_id' is not null then raise invalid_parameter_value using message='Review the exact live credit balance and limit.';end if;
   elsif cancel_sale then
    if charge.id is null or balance<0 or v->>'type'<>'adjustment' or (v->>'amount')::bigint is distinct from -least(balance,before_sale.amount)
     or v->>'returns_charge_id' is distinct from charge.id::text or v->>'reversal_of' is not null or v->>'refund_id' is not null then raise invalid_parameter_value using message='Keep the original order credit return.';end if;
   elsif restore_sale then
    if returned.id is null or v->>'type'<>'adjustment' or (v->>'amount')::bigint is distinct from -returned.amount or v->>'reversal_of' is distinct from returned.id::text or v->>'refund_id' is not null then raise invalid_parameter_value using message='Keep the original cancellation reversal.';end if;
   elsif t.type='order.payment-undo' then
    if charge.id is null or balance<charge.amount or v->>'type'<>'adjustment' or (v->>'amount')::bigint is distinct from -charge.amount or v->>'reversal_of' is distinct from charge.id::text or v->>'refund_id' is not null then raise invalid_parameter_value using message='Do not erase partly collected order debt.';end if;
   elsif t.type='order.refund' then
    if v->>'type'<>'refund' or (v->>'amount')::bigint is distinct from (t.plan->'bindings'->>'refundAmount')::bigint or v->>'refund_id' is distinct from f->>'refundId' or v->>'reversal_of' is not null then raise invalid_parameter_value using message='Keep the order refund entry.';end if;
   elsif t.type='order.refund-undo' then
    if v->>'type'<>'adjustment' or (v->>'amount')::bigint<>0 or v->>'refund_id' is distinct from before_refund.id::text or v->>'reversal_of' is distinct from before_refund.credit_entry_id::text then raise invalid_parameter_value using message='Keep the original refund reversal.';end if;
   else raise invalid_parameter_value using message='Invalid order credit action.';end if;
  elsif table_name='events' then
   expected_event:=null;expected_undo:=null;expected_customer:=null;
   if v->>'id'=t.command_id::text then expected_event:=primary_command;
   elsif v->>'id'=t.plan->>'settlementId' then expected_event:='order.payment';
   elsif v->>'id'=f->>'saleEventId' then expected_event:=case when new_sale then 'sale.record' when cancel_sale then 'sale.order-cancel' when restore_sale then 'sale.order-cancel-undo' when t.type='order.payment-undo' then 'sale.undo' end;
   elsif v->>'id'=f->>'creditEventId' then expected_event:=case when new_sale then 'khata.charge' when cancel_sale then 'khata.order-return' when restore_sale then 'khata.order-return-undo' when t.type='order.payment-undo' then 'khata.undo' when t.type='order.refund' then 'khata.order-refund' when t.type='order.refund-undo' then 'khata.order-refund-undo' end;
   elsif v->>'id'=f->>'refundEventId' then expected_event:=case when t.type='order.refund' then 'refund.record' when t.type='order.refund-undo' then 'refund.undo' end;end if;
   if v->>'id'=t.command_id::text and t.type='order.status-undo' then expected_undo:=before_order.status_event_id::text;
   elsif v->>'id'=f->>'saleEventId' then expected_customer:=saved_order.customer_id::text;expected_undo:=case when restore_sale then before_order.status_event_id::text when t.type='order.payment-undo' then before_sale.event_id::text else null end;
   elsif v->>'id'=f->>'creditEventId' then expected_customer:=customer_id::text;expected_undo:=case when restore_sale then returned.event_id::text when t.type='order.payment-undo' then charge.event_id::text when t.type='order.refund-undo' then reversed.event_id::text else null end;
   elsif v->>'id'=f->>'refundEventId' and t.type='order.refund-undo' then expected_undo:=before_refund.event_id::text;end if;
   if expected_event is null or v->>'command' is distinct from expected_event or v->>'actor_type'<>'member' or v->>'actor_id' is distinct from t.actor_id::text or (v->>'at')::bigint is distinct from t.created_at
    or v->>'undo_of' is distinct from expected_undo or v->>'customer_id' is distinct from expected_customer
    or v->>'order_id' is distinct from t.plan->>'orderId' or (v->>'order_revision')::bigint is distinct from (case when t.type='order.warning-settings' then null when v->>'id'=t.command_id::text then coalesce(before_order.revision,0)+1 when v->>'id'=t.plan->>'settlementId' then revision_value else null end)
    or exists(select 1 from unnest(array['stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid order audit.';end if;
  end if;
  -- Reversals preserve every original field except their explicit void/update markers.
  if table_name='outlets' or table_name='orders' and t.type not in ('order.create','order.update') or table_name='sales' and not new_sale or table_name='order_refunds' and t.type='order.refund-undo' then
   select string_agg(format('(($1->>%L)::%s)::text is not distinct from source.%I::text',a.key,format_type(att.atttypid,att.atttypmod),a.key),' and ' order by a.key) into immutable
    from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped
    where a.key not in ('updated_at','voided_at','void_reason') and (table_name<>'outlets' or a.key<>'order_warning_minutes')
     and (table_name<>'orders' or a.key not in ('event_id','revision') and (a.key<>'payment' or not finance_allowed) and (t.type not in ('order.status','order.status-undo') or a.key not in ('status','status_changed_at','status_event_id')));
   execute format('select (%s) from public.%I source where source.id=$2',immutable,table_name) into unchanged using v,(v->>'id')::public.ulid;
   if unchanged is distinct from true then raise invalid_parameter_value using message='Keep the original financial record or outlet configuration.';end if;
  end if;
  select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key),
   string_agg(format('%I=excluded.%I',a.key,a.key),',' order by a.key) filter(where a.key not in ('id','business_id','outlet_id','created_at')) into keys,casts,updates
   from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
  execute format('insert into public.%I(%s) select %s%s',table_name,keys,casts,case when insert_only then '' else ' on conflict(id) do update set '||updates end) using v;
  if table_name='orders' then select * into saved_order from public.orders x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'orderId';
  elsif table_name='sales' then select * into saved_sale from public.sales x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=v->>'id';
  elsif table_name='credit_entries' then select * into new_entry from public.credit_entries x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=v->>'id';
  elsif table_name='order_refunds' then select * into saved_refund from public.order_refunds x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=v->>'id';end if;
 end loop;
 if (select count(*) from jsonb_array_elements(records) x where x->>'table'='events')<>(1+(case when t.plan->>'settlementId' is not null then 1 else 0 end)+(case when saved_sale.id is not null then 1 else 0 end)+(case when new_entry.id is not null then 1 else 0 end)+(case when saved_refund.id is not null then 1 else 0 end))
  or t.plan->>'settlementId' is not null and not exists(select 1 from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=t.plan->>'settlementId')
  or new_sale and saved_order.total>0 and saved_sale.id is null or account_id is not null and finance_allowed and not(new_sale and saved_order.total=0) and new_entry.id is null
  or t.type='order.warning-settings' and jsonb_array_length(records)<>2 then raise invalid_parameter_value using message='Keep all companion financial records and audits together.';end if;
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'orderId',saved_order.id,'occurredAt',t.occurred_at,'at',t.created_at,
  'revision',saved_order.revision,'sequence',saved_order.sequence,'number',saved_order.number,'total',saved_order.total,
  'updatedAt',case when t.type='order.warning-settings' then greatest(t.created_at,t.occurred_at,outlet_row.created_at) else saved_order.updated_at end,
  'saleId',saved_sale.id,'entryId',new_entry.id,'refundId',saved_refund.id,'noteId',t.plan->>'noteId','communicationId',t.plan->>'communicationId',
  'undoOf',case when t.type='order.refund-undo' then t.plan->>'refundId' when t.type in ('order.payment-undo','order.status-undo') then t.plan->>'orderId' else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.order_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;

create or replace function private.finish_order_review(review_id public.ulid,secret text,outcome text,replacement_ticket public.ulid,replacement_secret text,replacement_hash text,replacement_records jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t private.order_review_tickets;n private.order_write_tickets;old private.shop_command_receipts;before_order public.orders;after_order public.orders;at_ms public.utc_ms;metadata jsonb;applied jsonb;lock_id text;review_setting text;
begin
 if outcome is null or outcome not in ('withdrawn','replaced') then raise invalid_parameter_value using message='Choose the reviewed outcome.';end if;
 select * into t from private.order_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current shop values again.';end if;
 -- Acquire both intent identities before the outlet lock, in a stable order.
 for lock_id in select x from unnest(array[t.command_id::text,t.replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for share;
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 select * into old from private.shop_command_receipts r where r.id=t.command_id;
 if found then
  if old.business_id<>t.business_id or old.outlet_id<>t.outlet_id or old.actor_id<>t.actor_id or old.auth_user_id<>t.auth_user_id or old.type<>t.type or old.request_hash<>t.original_hash then raise sqlstate 'PT409' using message='Keep the original action receipt.';end if;
  return old.receipt;
 end if;
 select * into t from private.order_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Review the current shop values again.';end if;
 if sha256(convert_to(private.order_write_context(t.business_id,t.outlet_id,t.type,t.plan)::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed shop values changed. Review them again.';end if;
 if exists(select 1 from private.command_receipts r where r.id=t.command_id) or exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Review the original action identity.';end if;
 select * into before_order from public.orders o where o.business_id=t.business_id and o.outlet_id=t.outlet_id and o.id=t.plan->>'orderId';
 if outcome='withdrawn' then
  if replacement_ticket is not null or replacement_secret is not null or replacement_hash is not null or (replacement_records is not null and replacement_records<>'null'::jsonb) then raise invalid_parameter_value using message='Withdrawal cannot record a replacement payment.';end if;
  after_order:=before_order;
  if before_order.id is not null then
   if greatest(before_order.revision,(t.plan->>'revision')::bigint)>=9007199254740991 then raise sqlstate 'PT409' using message='Review the original revision boundary.';end if;
   after_order.revision:=greatest(before_order.revision,(t.plan->>'revision')::bigint)+1;after_order.event_id:=t.command_id;after_order.updated_at:=greatest(before_order.updated_at,before_order.created_at,at_ms);
  end if;
 else
  select * into n from private.order_write_tickets r where r.id=replacement_ticket and r.token_hash=sha256(convert_to(replacement_secret,'UTF8'));
  if not found or n.command_id<>t.replacement_id or n.business_id<>t.business_id or n.outlet_id<>t.outlet_id or n.actor_id<>t.actor_id or n.auth_user_id<>t.auth_user_id or n.type<>t.type or n.occurred_at<>t.occurred_at or n.request_hash<>replacement_hash or n.snapshot_hash<>t.snapshot_hash or (n.plan-'revision')<>(t.plan-'revision') then raise invalid_parameter_value using message='Keep the exact reviewed replacement and financial identities.';end if;
  -- This transaction-local capability is set only after the selected review,
  -- live membership, exact source/context and replacement ticket are checked.
  review_setting:=current_setting('mise.order_review_completion',true);
  perform set_config('mise.order_review_completion',t.id::text||':'||encode(t.token_hash,'hex'),true);
  applied:=private.finish_order_write(replacement_ticket,replacement_secret,replacement_records);
  perform set_config('mise.order_review_completion',coalesce(review_setting,''),true);
  select * into after_order from public.orders o where o.business_id=t.business_id and o.outlet_id=t.outlet_id and o.id=t.plan->>'orderId';
 end if;
 metadata:=jsonb_build_object('id',t.id,'type','command.resolved','commandId',t.command_id,'commandType',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'commandHash',t.original_hash,'sourceHash',t.source_hash,'at',at_ms,'outcome',outcome,'replacement',case when outcome='withdrawn' then null else jsonb_build_object('id',t.replacement_id,'revision',n.plan->'revision','commandHash',n.request_hash,'receipt',applied) end);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,order_id,order_revision) values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,'sync.resolve',json_build_object('resolutionId',t.id,'commandId',t.command_id,'commandType',t.type,'commandHash',t.original_hash,'sourceHash',t.source_hash,'originalCommandJson',t.original_intent,'sourceJson',t.source_json,'orderBeforeJson',case when before_order.id is null then null else row_to_json(before_order)::text end),json_build_object('resolutionId',t.id,'outcome',outcome,'receipt',metadata,'replacementId',case when outcome='replaced' then t.replacement_id else null end,'orderAfterJson',case when after_order.id is null then null else row_to_json(after_order)::text end),at_ms,after_order.id,after_order.revision);
 if outcome='withdrawn' and after_order.id is not null then update public.orders o set revision=after_order.revision,event_id=after_order.event_id,updated_at=after_order.updated_at where o.business_id=t.business_id and o.outlet_id=t.outlet_id and o.id=after_order.id;end if;
 insert into private.order_command_resolutions values(t.id,t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.original_hash,t.source_hash,t.original_intent,t.source_json,outcome,case when outcome='replaced' then t.replacement_id else null end,metadata,at_ms);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.original_hash,metadata);
 delete from private.order_review_tickets r where r.id=t.id;
 return metadata;
end $$;
