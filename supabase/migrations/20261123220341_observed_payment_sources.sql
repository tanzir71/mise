-- An observation is not a financial posting. Only an explicitly selected,
-- already recorded order/sale/khata payment can resolve its source task here.
create table private.payment_sources (
 payment_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 task_id public.ulid not null unique,created_by public.ulid not null,author public.literal_text not null,
 method_name public.literal_text not null,source_text public.literal_text not null,
 foreign key(business_id,outlet_id,payment_id) references public.payments(business_id,outlet_id,id),
 foreign key(business_id,outlet_id,task_id) references public.tasks(business_id,outlet_id,id),
 foreign key(business_id,created_by) references public.members(business_id,id)
);
create index payment_sources_scope on private.payment_sources(business_id,outlet_id,payment_id);
create index payment_sources_task_scope on private.payment_sources(business_id,outlet_id,task_id);
create index payment_sources_author_scope on private.payment_sources(business_id,created_by);
create table private.payment_source_states (
 payment_id public.ulid primary key references private.payment_sources(payment_id),business_id public.ulid not null,outlet_id public.ulid not null,
 revision bigint not null check(revision between 0 and 9007199254740991),last_action_id public.ulid not null,
 reason public.literal_text,match_kind text check(match_kind in('order','sale','credit')),match_id public.ulid,
 financial_kind text check(financial_kind in('sale','credit')),financial_id public.ulid,target json,
 check((match_kind is null)=(match_id is null) and (match_kind is null)=(financial_id is null) and (match_kind is null)=(financial_kind is null) and (match_kind is null)=(target is null)),
 check(reason is null or match_kind is null),
 foreign key(business_id,outlet_id,payment_id) references public.payments(business_id,outlet_id,id)
);
create unique index payment_source_one_financial_record on private.payment_source_states(financial_kind,financial_id) where financial_id is not null;
create index payment_source_financial_scope on private.payment_source_states(business_id,outlet_id,financial_kind,financial_id) where financial_id is not null;
create index payment_source_state_scope on private.payment_source_states(business_id,outlet_id,payment_id);
create index payment_source_order_scope on private.payment_source_states(business_id,outlet_id,match_id) where match_kind='order';
create table private.payment_source_actions (
 auth_user_id uuid not null,id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 intent_json text not null check(octet_length(intent_json)<=196608),state text not null check(state in('applied','closed')),
 outcome json not null,created_at public.utc_ms not null,primary key(auth_user_id,id)
);
create index payment_source_actions_personal on private.payment_source_actions(auth_user_id,created_at);
create index payment_source_actions_origin on private.payment_source_actions(business_id,outlet_id,id) where state='applied';
create index payment_source_credit_reversals on public.credit_entries(business_id,outlet_id,reversal_of) where reversal_of is not null;
alter table private.payment_sources enable row level security;
alter table private.payment_sources force row level security;
alter table private.payment_source_states enable row level security;
alter table private.payment_source_states force row level security;
alter table private.payment_source_actions enable row level security;
alter table private.payment_source_actions force row level security;
revoke all on private.payment_sources,private.payment_source_states,private.payment_source_actions from public,anon,authenticated,service_role;

-- Plain json and encoded literal fields preserve every original code unit.
-- The caller must already be authorized for the outlet before invoking helpers.
create function private.payment_match_target(business public.ulid,outlet public.ulid,kind text,target_id public.ulid) returns json
language plpgsql stable security invoker set search_path='' as $$
declare s public.sales;o public.orders;e public.credit_entries;result json;stamp text;method text;
begin
 if kind='order' then
  select * into o from public.orders x where x.business_id=business and x.outlet_id=outlet and x.id=target_id;
  if not found or private.confirmation_json_field(o.payment,'status')::text is distinct from '"paid"' or o.status in('cancelled','returning','returned') then return null;end if;
  select * into s from public.sales x where x.business_id=business and x.outlet_id=outlet and x.id=(private.confirmation_json_field(o.payment,'saleId')::jsonb#>>'{}') and x.order_id=o.id;
  if not found or s.voided_at is not null or s.method='credit' or s.amount is distinct from o.total or s.currency<>o.currency then return null;end if;
 elsif kind='sale' then
  select * into s from public.sales x where x.business_id=business and x.outlet_id=outlet and x.id=target_id;
  if not found or s.voided_at is not null or s.method='credit' or s.order_id is not null or s.closing_id is not null then return null;end if;
 elsif kind='credit' then
  select * into e from public.credit_entries x where x.business_id=business and x.outlet_id=outlet and x.id=target_id;
  if not found or e.type<>'payment' or e.amount<=0 or e.reversal_of is not null or e.method_name is null
   or exists(select 1 from public.credit_entries r where r.business_id=business and r.outlet_id=outlet and r.reversal_of=e.id)
   or not exists(select 1 from public.credit_accounts a
    where a.business_id=business and a.outlet_id=outlet and a.id=e.account_id and a.customer_id=e.customer_id and a.currency=e.currency) then return null;end if;
 else raise invalid_parameter_value using message='Choose an actual recorded payment.';end if;
 if kind='credit' then
  method:=case when private.confirmation_json_equal(e.method_name,'"Cash"'::json) then 'cash' when private.confirmation_json_equal(e.method_name,'"Card"'::json) then 'card' else 'wallet' end;
  result:=json_build_object('kind',kind,'id',target_id,'financialId',e.id,'businessId',business,'outletId',outlet,'amount',e.amount,'currency',e.currency,'method',method,'methodNameJson',e.method_name::text,'at',e.created_at,'labelJson',to_json('Recorded khata payment'::text)::text);
  stamp:=row_to_json(e)::text;
 else
  result:=json_build_object('kind',kind,'id',target_id,'financialId',s.id,'businessId',business,'outletId',outlet,'amount',s.amount,'currency',s.currency,'method',s.method,'methodNameJson',s.method_name::text,'at',s.created_at,'labelJson',to_json(case when kind='order' then 'Recorded order payment' else 'Recorded counter receipt' end)::text);
  stamp:=row_to_json(s)::text||'|'||coalesce(row_to_json(o)::text,'');
 end if;
 return (result::jsonb||jsonb_build_object('fingerprint',encode(sha256(convert_to(stamp||'|'||result::text,'UTF8')),'hex')))::json;
end $$;
revoke all on function private.payment_match_target(public.ulid,public.ulid,text,public.ulid) from public,anon,authenticated,service_role;

create function private.payment_source_projection(payment public.ulid) returns json
language plpgsql stable security invoker set search_path='' as $$
declare p public.payments;d private.payment_sources;s private.payment_source_states;current_target json;matched json;valid boolean:=false;status text;result json;
begin
 select * into d from private.payment_sources x where x.payment_id=payment;if not found then return null;end if;
 select * into p from public.payments x where x.id=payment and x.business_id=d.business_id and x.outlet_id=d.outlet_id;
 select * into s from private.payment_source_states x where x.payment_id=payment and x.business_id=d.business_id and x.outlet_id=d.outlet_id;
 if p.id is null or s.payment_id is null then raise sqlstate 'PT409' using message='Keep the original observed payment.';end if;
 if p.order_id is distinct from(case when s.match_kind='order' then s.match_id end) or p.sale_id is distinct from(case when s.match_kind='sale' then s.match_id end)
  or p.credit_entry_id is distinct from(case when s.match_kind='credit' then s.match_id end) then raise sqlstate 'PT409' using message='The recorded source association needs review.';end if;
 if s.match_kind is not null then
  current_target:=private.payment_match_target(d.business_id,d.outlet_id,s.match_kind,s.match_id);
  valid:=current_target is not null and current_target->>'fingerprint'=s.target->>'fingerprint';
  matched:=json_build_object('target',s.target,'current',current_target,'valid',valid);
 end if;
 status:=case when s.reason is not null then 'dismissed' when s.match_kind is null then 'unmatched' when valid then 'matched' else 'review' end;
 result:=json_build_object('id',p.id,'businessId',p.business_id,'outletId',p.outlet_id,'taskId',d.task_id,'amount',p.amount,'currency',p.currency,'method',p.method,
  'methodNameJson',d.method_name::text,'referenceJson',p.reference::text,'sourceJson',d.source_text::text,'origin',p.source,'fromPhone',p.from_phone,'receivedAt',p.received_at,'createdAt',p.created_at,'updatedAt',p.updated_at,
  'authorJson',d.author::text,'revision',s.revision,'lastActionId',s.last_action_id,'status',status,'reasonJson',s.reason::text,'match',matched);
 return(result::jsonb||jsonb_build_object('fingerprint',encode(sha256(convert_to(row_to_json(p)::text||'|'||row_to_json(d)::text||'|'||row_to_json(s)::text||'|'||coalesce(current_target::text,''),'UTF8')),'hex')))::json;
end $$;
revoke all on function private.payment_source_projection(public.ulid) from public,anon,authenticated,service_role;

create function private.refresh_payment_source_task(payment public.ulid) returns void
language plpgsql security invoker set search_path='' as $$
declare source json;stamp public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 source:=private.payment_source_projection(payment);if source is null then return;end if;
 update public.tasks t set status=case when source->>'status' in('matched','dismissed') then 'resolved' else 'open' end,updated_at=greatest(t.updated_at,stamp)
 where t.id=source->>'taskId' and t.business_id=source->>'businessId' and t.outlet_id=source->>'outletId';
end $$;
revoke all on function private.refresh_payment_source_task(public.ulid) from public,anon,authenticated,service_role;
create function private.payment_source_financial_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare row_id public.ulid;related public.ulid;previous_related public.ulid;business public.ulid;outlet public.ulid;source record;
begin
 if tg_op='DELETE' then row_id:=old.id;business:=old.business_id;outlet:=old.outlet_id;else row_id:=new.id;business:=new.business_id;outlet:=new.outlet_id;end if;
 if tg_table_name='credit_entries' then
  if tg_op='DELETE' then related:=old.reversal_of;else related:=new.reversal_of;end if;
  if tg_op='UPDATE' then previous_related:=old.reversal_of;end if;
 end if;
 -- Separate indexed branches remain selective even with a cached generic plan.
 for source in
  select s.payment_id from private.payment_source_states s where tg_table_name='orders' and s.business_id=business and s.outlet_id=outlet and s.match_kind='order' and s.match_id=row_id
  union select s.payment_id from private.payment_source_states s where tg_table_name='sales' and s.business_id=business and s.outlet_id=outlet and s.financial_kind='sale' and s.financial_id=row_id
  union select s.payment_id from private.payment_source_states s where tg_table_name='credit_entries' and s.business_id=business and s.outlet_id=outlet and s.financial_kind='credit' and s.financial_id in(row_id,related,previous_related)
  union select s.payment_id from private.payment_source_states s join public.credit_entries e on e.business_id=s.business_id and e.outlet_id=s.outlet_id and e.id=s.financial_id
   where tg_table_name='credit_accounts' and s.business_id=business and s.outlet_id=outlet and s.financial_kind='credit' and e.account_id=row_id
  union select s.payment_id from private.payment_source_states s where tg_table_name='payments' and s.business_id=business and s.outlet_id=outlet and s.payment_id=row_id
  order by payment_id
 loop perform private.refresh_payment_source_task(source.payment_id);end loop;
 return null;
end $$;
revoke all on function private.payment_source_financial_changed() from public,anon,authenticated,service_role;
create trigger payment_source_sale_changed after update or delete on public.sales for each row execute function private.payment_source_financial_changed();
create trigger payment_source_order_changed after update or delete on public.orders for each row execute function private.payment_source_financial_changed();
create trigger payment_source_credit_changed after insert or update or delete on public.credit_entries for each row execute function private.payment_source_financial_changed();
create trigger payment_source_account_changed after update or delete on public.credit_accounts for each row execute function private.payment_source_financial_changed();
create trigger payment_source_record_changed after update on public.payments for each row execute function private.payment_source_financial_changed();

create function private.read_payment_source(outlet public.ulid,payment public.ulid,match_kind text default null,match_id public.ulid default null) returns json
language plpgsql security definer set search_path='' as $$
declare scope jsonb;source json;candidate json;eligible boolean:=false;stamp public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 scope:=private.owner_task_access(outlet);
 if not exists(select 1 from private.payment_sources s where s.payment_id=payment and s.business_id=scope->>'businessId' and s.outlet_id=outlet) then raise insufficient_privilege using message='This payment source is unavailable.';end if;
 source:=private.payment_source_projection(payment);
 if source is null or source->>'businessId' is distinct from scope->>'businessId' or source->>'outletId' is distinct from outlet::text then raise insufficient_privilege using message='This payment source is unavailable.';end if;
 if match_kind is null and match_id is null then return json_build_object('v',1,'access',scope,'at',stamp,'source',source);end if;
 if match_kind is null or match_id is null then raise invalid_parameter_value using message='Choose the actual target.';end if;
 candidate:=private.payment_match_target((scope->>'businessId')::public.ulid,outlet,match_kind,match_id);
 if candidate is not null and exists(select 1 from private.payment_source_states s where s.financial_kind=case when read_payment_source.match_kind='credit' then 'credit' else 'sale' end
  and s.financial_id=candidate->>'financialId' and s.payment_id<>payment) then candidate:=null;end if;
 eligible:=candidate is not null and candidate->>'amount'=source->>'amount' and candidate->>'currency'=source->>'currency' and candidate->>'method'=source->>'method'
  and private.confirmation_json_equal((candidate->>'methodNameJson')::json,(source->>'methodNameJson')::json);
 return json_build_object('v',1,'access',scope,'at',stamp,'source',source,'target',candidate,'eligible',eligible);
end $$;
revoke all on function private.read_payment_source(public.ulid,public.ulid,text,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.read_payment_source(public.ulid,public.ulid,text,public.ulid) to authenticated;
create function public.read_payment_source(p_outlet_id public.ulid,p_payment_id public.ulid) returns json
language sql security invoker set search_path='' as $$select private.read_payment_source(p_outlet_id,p_payment_id)$$;
create function public.read_payment_match(p_outlet_id public.ulid,p_payment_id public.ulid,p_kind text,p_target_id public.ulid) returns json
language sql security invoker set search_path='' as $$select private.read_payment_source(p_outlet_id,p_payment_id,p_kind,p_target_id)$$;
revoke all on function public.read_payment_source(public.ulid,public.ulid),public.read_payment_match(public.ulid,public.ulid,text,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.read_payment_source(public.ulid,public.ulid),public.read_payment_match(public.ulid,public.ulid,text,public.ulid) to authenticated;

create function private.act_payment_source(outlet public.ulid,operation text,source_json text) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
<<payment_action>>
declare account uuid;input json;control jsonb;scope jsonb;business public.ulid;actor public.ulid;action_id public.ulid;event_id public.ulid;payment public.ulid;task public.ulid;
 field text;stats integer[];stamp public.utc_ms;saved private.payment_source_actions;previous private.payment_source_actions;
 before_image json;after_image json;answer json;candidate json;state private.payment_source_states;restore json;reason public.literal_text;target_kind text;target_id public.ulid;financial_id public.ulid;author public.literal_text;
begin
 account:=private.owner_task_account();
 if operation is null or operation not in('submit','inspect','close') or source_json is null or octet_length(source_json)>196608 then raise invalid_parameter_value using message='Keep the complete original payment source.';end if;
 begin
  input:=source_json::json;control:=input::jsonb;
  if control->>'type'='capture' then
   if not private.staff_exact(input,array['amount','at','currency','eventId','fromPhone','id','method','methodNameJson','paymentId','receivedAt','referenceJson','scope','sourceJson','taskId','type','v']) then raise invalid_parameter_value;end if;
   foreach field in array array['methodNameJson','referenceJson','sourceJson'] loop
    if jsonb_typeof(control->field) is distinct from 'string' then raise invalid_parameter_value;end if;
    stats:=private.inbox_literal_stats((control->>field)::json);
    if stats[1]>(case field when 'methodNameJson' then 80 when 'referenceJson' then 4000 else 16000 end) or field<>'referenceJson' and stats[2]<>1 then raise invalid_parameter_value;end if;
   end loop;
   if jsonb_typeof(control->'amount') is distinct from 'number' or(control->>'amount')::numeric not between 1 and 9007199254740991 or trunc((control->>'amount')::numeric)<>(control->>'amount')::numeric
    or jsonb_typeof(control->'currency') is distinct from 'string' or control->>'currency'!~'^[A-Z]{3}$'
    or jsonb_typeof(control->'method') is distinct from 'string' or control->>'method' not in('cash','wallet','card')
    or(control->'fromPhone'<>'null'::jsonb and(jsonb_typeof(control->'fromPhone')<>'string' or control->>'fromPhone'!~'^\+[1-9][0-9]{6,14}$'))
    or jsonb_typeof(control->'receivedAt') is distinct from 'number' or(control->>'receivedAt')::numeric not between 0 and 8640000000000000 or trunc((control->>'receivedAt')::numeric)<>(control->>'receivedAt')::numeric
    or jsonb_typeof(control->'taskId') is distinct from 'string' then raise invalid_parameter_value;end if;
   task:=(control->>'taskId')::public.ulid;
  elsif control->>'type'='link' then
   if not private.staff_exact(input,array['at','confirmed','eventId','fingerprint','id','paymentId','scope','target','type','v']) or control->'confirmed' is distinct from 'true'::jsonb
    or not private.staff_exact(input->'target',array['amount','at','businessId','currency','financialId','fingerprint','id','kind','labelJson','method','methodNameJson','outletId']) then raise invalid_parameter_value;end if;
   foreach field in array array['id','financialId','businessId','outletId'] loop
    if jsonb_typeof(control->'target'->field) is distinct from 'string' then raise invalid_parameter_value;end if;
    perform(control->'target'->>field)::public.ulid;
   end loop;
   if jsonb_typeof(control->'target'->'kind') is distinct from 'string' or control->'target'->>'kind' not in('order','sale','credit')
    or jsonb_typeof(control->'target'->'amount') is distinct from 'number' or(control->'target'->>'amount')::numeric not between 1 and 9007199254740991 or trunc((control->'target'->>'amount')::numeric)<>(control->'target'->>'amount')::numeric
    or jsonb_typeof(control->'target'->'at') is distinct from 'number' or(control->'target'->>'at')::numeric not between 0 and 8640000000000000 or trunc((control->'target'->>'at')::numeric)<>(control->'target'->>'at')::numeric
    or jsonb_typeof(control->'target'->'currency') is distinct from 'string' or control->'target'->>'currency'!~'^[A-Z]{3}$'
    or jsonb_typeof(control->'target'->'method') is distinct from 'string' or control->'target'->>'method' not in('cash','wallet','card')
    or jsonb_typeof(control->'target'->'fingerprint') is distinct from 'string' or control->'target'->>'fingerprint'!~'^[a-f0-9]{64}$'
    or control->'target'->>'businessId' is distinct from control->'scope'->>'businessId' or control->'target'->>'outletId' is distinct from control->'scope'->>'outletId'
    or control->'target'->>'kind'<>'order' and control->'target'->>'financialId' is distinct from control->'target'->>'id' then raise invalid_parameter_value;end if;
   foreach field in array array['methodNameJson','labelJson'] loop
    if jsonb_typeof(control->'target'->field) is distinct from 'string' then raise invalid_parameter_value;end if;
    stats:=private.inbox_literal_stats((control->'target'->>field)::json);
    if stats[1]>(case field when 'methodNameJson' then 80 else 4000 end) or field='methodNameJson' and stats[2]<>1 then raise invalid_parameter_value;end if;
   end loop;
  elsif control->>'type'='dismiss' then
   if not private.staff_exact(input,array['at','eventId','fingerprint','id','paymentId','reasonJson','scope','type','v']) or jsonb_typeof(control->'reasonJson') is distinct from 'string' then raise invalid_parameter_value;end if;
   reason:=(control->>'reasonJson')::public.literal_text;stats:=private.inbox_literal_stats(reason);if stats[1]>4000 or stats[2]<>1 then raise invalid_parameter_value;end if;
  elsif control->>'type'='undo' then
   if not private.staff_exact(input,array['at','eventId','fingerprint','id','paymentId','scope','type','undoOf','v']) or jsonb_typeof(control->'undoOf') is distinct from 'string' then raise invalid_parameter_value;end if;
   perform(control->>'undoOf')::public.ulid;
  else raise invalid_parameter_value;end if;
  if control->'v' is distinct from '1'::jsonb or not private.staff_exact(input->'scope',array['businessId','memberId','outletId','role','v']) or control->'scope'->'v' is distinct from '1'::jsonb
   or control->'scope'->>'outletId' is distinct from outlet::text or control->'scope'->>'role' not in('owner','manager') or jsonb_typeof(control->'scope'->'role') is distinct from 'string' then raise invalid_parameter_value;end if;
  foreach field in array array['id','eventId','paymentId'] loop if jsonb_typeof(control->field) is distinct from 'string' then raise invalid_parameter_value;end if;end loop;
  foreach field in array array['businessId','outletId','memberId'] loop if jsonb_typeof(control->'scope'->field) is distinct from 'string' then raise invalid_parameter_value;end if;end loop;
  if jsonb_typeof(control->'at') is distinct from 'number' or(control->>'at')::numeric not between 0 and 8640000000000000 or trunc((control->>'at')::numeric)<>(control->>'at')::numeric then raise invalid_parameter_value;end if;
  business:=(control->'scope'->>'businessId')::public.ulid;actor:=(control->'scope'->>'memberId')::public.ulid;
  action_id:=(control->>'id')::public.ulid;event_id:=(control->>'eventId')::public.ulid;payment:=(control->>'paymentId')::public.ulid;
  if action_id=event_id or payment in(action_id,event_id) or task is not null and task in(action_id,event_id,payment)
   or control->>'type'<>'capture' and(jsonb_typeof(control->'fingerprint') is distinct from 'string' or control->>'fingerprint'!~'^[a-f0-9]{64}$')
   or control->>'type'='undo' and control->>'undoOf' in(action_id::text,event_id::text) then raise invalid_parameter_value;end if;
 exception when others then raise invalid_parameter_value using message='Keep the complete original payment source.';end;
 perform pg_advisory_xact_lock(hashtextextended('mise:payment-source:'||account::text||':'||action_id::text,0));
 select * into saved from private.payment_source_actions a where a.auth_user_id=account and a.id=action_id for update;
 if found then
  if saved.intent_json<>source_json or saved.business_id<>business or saved.outlet_id<>outlet or saved.actor_id<>actor then raise sqlstate 'PT409' using message='Keep the original payment-source choice.';end if;
  return saved.outcome;
 end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if operation='inspect' then return json_build_object('v',1,'intent',input,'state','pending','at',null,'before',null,'after',null);end if;
 if operation='close' then
  -- Different original IDs share one daily budget, including concurrent closes.
  perform pg_advisory_xact_lock(hashtextextended('mise:payment-source-closures:'||account::text,0));
  if(select count(*) from private.payment_source_actions a where a.auth_user_id=account and a.state='closed' and a.created_at>=stamp-stamp%86400000)>=1000 then raise sqlstate 'PT429' using message='Keep the original source and retry later.';end if;
  answer:=json_build_object('v',1,'intent',input,'state','closed','at',stamp,'before',null,'after',null);
  insert into private.payment_source_actions values(account,action_id,business,outlet,actor,source_json,'closed',answer,stamp);return answer;
 end if;
 scope:=private.owner_task_access(outlet);if not private.confirmation_json_equal(input->'scope',scope::json) then raise insufficient_privilege using message='Use the actual payment-source account and outlet.';end if;
 perform 1 from public.businesses b where b.id=business for update;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 if not private.confirmation_json_equal(input->'scope',private.owner_task_access(outlet)::json) then raise insufficient_privilege using message='Review the current payment-source membership.';end if;
 if(control->>'at')::numeric>stamp+30000 then raise sqlstate 'PT409' using message='Check the original source clock.';end if;
 if control->>'type'='capture' then
  if(control->>'receivedAt')::numeric>stamp+300000 then raise sqlstate 'PT409' using message='Check the observed payment time.';end if;
  select m.name into author from public.members m where m.business_id=business and m.id=actor;
  insert into public.payments(id,business_id,outlet_id,method,amount,currency,reference,from_phone,received_at,source,created_at,updated_at)
   values(payment,business,outlet,control->>'method',(control->>'amount')::public.minor_units,control->>'currency',(control->>'referenceJson')::public.literal_text,control->>'fromPhone',(control->>'receivedAt')::public.utc_ms,'manual',stamp,stamp);
  insert into public.tasks(id,business_id,outlet_id,kind,title,body,actions,assignee,status,due_at,created_at,updated_at)
   values(task,business,outlet,'failure','"Payment needs a match"',(control->>'sourceJson')::public.literal_text,'[]','owner','open',stamp,stamp,stamp);
  insert into private.payment_sources values(payment,business,outlet,task,actor,author,(control->>'methodNameJson')::public.literal_text,(control->>'sourceJson')::public.literal_text);
  insert into private.payment_source_states values(payment,business,outlet,0,action_id,null,null,null,null,null,null);
 else
  select * into state from private.payment_source_states x where x.payment_id=payment and x.business_id=business and x.outlet_id=outlet for update;
  if not found then raise insufficient_privilege using message='This source is unavailable.';end if;
  before_image:=private.payment_source_projection(payment);
  if before_image->>'fingerprint' is distinct from control->>'fingerprint' then raise sqlstate 'PT409' using message='Review the current source before matching.';end if;
  if state.revision>=9007199254740991 then raise sqlstate 'PT409' using message='Retain this source for manual review.';end if;
  stamp:=greatest(stamp,(before_image->>'updatedAt')::public.utc_ms);
  if control->>'type'='link' then
   target_kind:=control->'target'->>'kind';target_id:=(control->'target'->>'id')::public.ulid;
   candidate:=private.payment_match_target(business,outlet,target_kind,target_id);
   if candidate is null or not private.confirmation_json_equal(input->'target',candidate) or candidate->>'amount' is distinct from before_image->>'amount' or candidate->>'currency' is distinct from before_image->>'currency'
    or candidate->>'method' is distinct from before_image->>'method' or not private.confirmation_json_equal((candidate->>'methodNameJson')::json,(before_image->>'methodNameJson')::json) then raise sqlstate 'PT409' using message='Match the actual amount, currency and method to its recorded receipt.';end if;
   financial_id:=(candidate->>'financialId')::public.ulid;
  elsif control->>'type'='undo' then
   if state.last_action_id::text is distinct from control->>'undoOf' then raise sqlstate 'PT409' using message='Undo only the latest source choice.';end if;
   select * into previous from private.payment_source_actions a where a.business_id=business and a.outlet_id=outlet and a.id=state.last_action_id and a.state='applied' and a.outcome->'after'->>'id'=payment::text and(a.outcome->'after'->>'revision')::bigint=state.revision limit 1;
   if not found then raise sqlstate 'PT409' using message='Keep the original source choice.';end if;
   restore:=previous.outcome->'before';
   if restore is null or json_typeof(restore)='null' then reason:='"Observation withdrawn"';
   else
    reason:=(restore->>'reasonJson')::public.literal_text;
    if json_typeof(restore->'match') is distinct from 'null' and restore->'match' is not null then
     target_kind:=restore->'match'->'target'->>'kind';target_id:=(restore->'match'->'target'->>'id')::public.ulid;
     -- Restore only the prior association. Its live financial state is read
     -- again by the projection, which reopens a changed/voided receipt for
     -- review. Undoing metadata must never undo or resurrect money.
     candidate:=restore->'match'->'target';
     financial_id:=(candidate->>'financialId')::public.ulid;
    end if;
   end if;
  end if;
  if financial_id is not null and exists(select 1 from private.payment_source_states x where x.financial_kind=case when target_kind='credit' then 'credit' else 'sale' end and x.financial_id=payment_action.financial_id and x.payment_id<>payment) then raise sqlstate 'PT409' using message='This recorded receipt already has a source match.';end if;
  update private.payment_source_states x set revision=x.revision+1,last_action_id=action_id,reason=payment_action.reason,match_kind=target_kind,match_id=target_id,financial_kind=case when payment_action.financial_id is null then null when target_kind='credit' then 'credit' else 'sale' end,financial_id=payment_action.financial_id,target=candidate where x.payment_id=payment;
  update public.payments p set order_id=case when target_kind='order' then target_id end,sale_id=case when target_kind='sale' then target_id end,credit_entry_id=case when target_kind='credit' then target_id end,updated_at=stamp where p.id=payment and p.business_id=business and p.outlet_id=outlet;
 end if;
 perform private.refresh_payment_source_task(payment);
 after_image:=private.payment_source_projection(payment);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,undo_of)
  values(event_id,business,outlet,'member',actor,'payment-source.'||(control->>'type'),coalesce(before_image,'null'::json),after_image,stamp,case when control->>'type'='undo' then(previous.intent_json::json->>'eventId')::public.ulid end);
 answer:=json_build_object('v',1,'intent',input,'state','applied','at',stamp,'before',before_image,'after',after_image);
 insert into private.payment_source_actions values(account,action_id,business,outlet,actor,source_json,'applied',answer,stamp);
 return answer;
end $$;
revoke all on function private.act_payment_source(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.act_payment_source(public.ulid,text,text) to authenticated;
create function public.act_payment_source(p_outlet_id public.ulid,p_operation text,p_intent_json text) returns json
language sql security invoker set search_path='' as $$select private.act_payment_source(p_outlet_id,p_operation,p_intent_json)$$;
revoke all on function public.act_payment_source(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.act_payment_source(public.ulid,text,text) to authenticated;

-- Existing nonpayment projections retain exactly their original fingerprints.
create or replace function private.owner_task_projection(t public.tasks) returns json
language plpgsql stable security invoker set search_path='' as $$
declare pay json;d private.owner_task_definitions;s private.owner_task_states;a json;target json;source text:='unknown';mode text:='source';recipient text;
 prepared public.literal_text:='""';author public.literal_text;urgent boolean:=false;choices json;result json;stamp text;
begin
 select * into d from private.owner_task_definitions x where x.task_id=t.id and x.business_id=t.business_id and x.outlet_id=t.outlet_id;
 select * into s from private.owner_task_states x where x.task_id=t.id and x.business_id=t.business_id and x.outlet_id=t.outlet_id;
 if d.task_id is not null then
  source:='manual';mode:=d.mode;recipient:=d.recipient;prepared:=d.prepared;urgent:=d.urgent;
  select m.name into author from public.members m where m.business_id=t.business_id and m.id=d.created_by;
 elsif exists(select 1 from private.payment_sources p where p.task_id=t.id and p.business_id=t.business_id and p.outlet_id=t.outlet_id) then
  select private.payment_source_projection(p.payment_id) into pay from private.payment_sources p where p.task_id=t.id;
  source:='payment';urgent:=pay->>'status' not in('matched','dismissed');author:=(pay->>'authorJson')::public.literal_text;
  target:=json_build_object('kind','payment','paymentId',pay->>'id');
 elsif exists(select 1 from private.kitchen_alarm_tasks k where k.task_id=t.id and k.business_id=t.business_id and k.outlet_id=t.outlet_id) then
  source:='kitchen';urgent:=true;
  select json_build_object('kind','order','orderId',k.order_id) into target from private.kitchen_alarm_tasks k where k.task_id=t.id;
 elsif exists(select 1 from private.customer_khata_actions x where private.owner_khata_task_id(x.outcome) is not null and private.owner_khata_task_id(x.outcome)=t.id) then
  a:=t.actions->0;
  if private.staff_exact(a,array['accountId','customerId','entryId','kind']) and a->>'kind'='open-customer' then
   select c.phone into recipient from public.credit_accounts x join public.customers c on c.business_id=x.business_id and c.id=x.customer_id
    where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=a->>'accountId' and x.customer_id=a->>'customerId';
   if found then source:='khata';mode:='message';target:=json_build_object('kind','customer','customerId',a->>'customerId','accountId',a->>'accountId','entryId',a->>'entryId');end if;
  end if;
 end if;
 choices:=case when mode='source' then '[]'::json when t.status='resolved' then '["reopen"]'::json
  when mode='decision' and t.status='open' then '["allow","no","reply-myself"]'::json when mode='check' then '["fixed"]'::json else '["sent"]'::json end;
 if mode<>'source' and s.undoable then choices:=(choices::jsonb||'["undo"]'::jsonb)::json;end if;
 result:=json_build_object('id',t.id,'businessId',t.business_id,'outletId',t.outlet_id,'kind',t.kind,'titleJson',t.title::text,'bodyJson',t.body::text,
  'status',t.status,'dueAt',t.due_at,'createdAt',t.created_at,'updatedAt',t.updated_at,'source',source,'mode',mode,'recipient',recipient,
  'preparedJson',prepared::text,'authorJson',author::text,'target',target,'lastActionId',s.last_action_id,'undoable',coalesce(s.undoable,false),
  'decision',s.decision,'replyJson',s.reply::text,'urgent',urgent,'actions',choices);
 stamp:=encode(sha256(convert_to(row_to_json(t)::text||'|'||coalesce(row_to_json(s)::text,'')||'|'||result::text||case when pay is null then '' else '|payment:'||(pay->>'fingerprint') end,'UTF8')),'hex');
 return (result::jsonb||jsonb_build_object('fingerprint',stamp))::json;
end $$;
create or replace function private.read_owner_task_page(outlet public.ulid,task_filter text,after_at public.utc_ms,after_id public.ulid,expected_version bigint,page_size integer) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare scope jsonb;business public.ulid;version bigint;rows json;cursor json;more boolean;counts json;
begin
 scope:=private.owner_task_access(outlet);business:=(scope->>'businessId')::public.ulid;
 if task_filter is null or task_filter not in('active','resolved') or page_size is null or page_size not between 1 and 100 or (after_at is null)<>(after_id is null)
  or after_id is not null and expected_version is null or expected_version is not null and expected_version not between 0 and 9007199254740991 then raise invalid_parameter_value using message='Use the complete original task page.';end if;
 -- One SQL snapshot supplies rows, sources, counts and continuation version.
 with scoped as materialized(select t.id,t.kind,t.due_at from public.tasks t where t.business_id=business and t.outlet_id=outlet
  and(case when task_filter='active' then t.status in('open','waiting') else t.status='resolved' end)),
 candidates as materialized(select t.*,coalesce(t.due_at,8640000000000000) sort_at from scoped t
  where after_at is null or(coalesce(t.due_at,8640000000000000),t.id)>(after_at,after_id) order by coalesce(t.due_at,8640000000000000),t.id limit page_size+1),
 page as(select c.* from candidates c order by c.sort_at,c.id limit page_size)
 select (select coalesce(json_agg(private.owner_task_projection(t) order by p.sort_at,p.id),'[]'::json) from page p join public.tasks t on t.id=p.id),
  (select json_build_object('sortAt',p.sort_at,'id',p.id) from page p order by p.sort_at desc,p.id desc limit 1),
  (select count(*) from candidates)>(select count(*) from page),
  (select json_build_object('question',count(*) filter(where t.kind='question'),'failure',count(*) filter(where t.kind='failure'),
   'chat',count(*) filter(where t.kind='chat'),'check',count(*) filter(where t.kind='check'),'total',count(*),
   'urgent',count(*) filter(where coalesce(d.urgent,false) or k.task_id is not null or(p.payment_id is not null and task_filter='active')))
   from scoped t left join private.owner_task_definitions d on d.task_id=t.id left join private.kitchen_alarm_tasks k on k.task_id=t.id left join private.payment_sources p on p.task_id=t.id),
  coalesce((select v.version from private.inbox_task_versions v where v.business_id=business and v.outlet_id=outlet),0)
 into rows,cursor,more,counts,version;
 if expected_version is not null and expected_version<>version then raise sqlstate 'PT409' using message='Tasks changed. Read the current Inbox again.';end if;
 return json_build_object('v',1,'access',scope,'at',floor(extract(epoch from clock_timestamp())*1000)::bigint,'version',version,'filter',task_filter,'counts',counts,'tasks',rows,'next',case when more then cursor else null end);
end $$;
