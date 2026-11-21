-- An explicit closing choice and its ordinary closing/cash writes are atomic.
-- Original source/intent remain literal TEXT; only bounded scalar facts are read.
create function private.reject_resolved_closing_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Existing canonical parents remain usable by ordinary undo and later work.
 if tg_table_name='day_closings' and exists(select 1 from public.day_closings c where c.id=new.id and c.business_id=new.business_id and c.outlet_id=new.outlet_id) then return new;end if;
 if tg_table_name='sales' and exists(select 1 from public.sales s where s.id=new.id and s.business_id=new.business_id and s.outlet_id=new.outlet_id) then return new;end if;
 if exists(select 1 from private.closing_command_resolutions r where r.business_id=new.business_id and new.id=any(r.reserved_ids)) then raise sqlstate 'PT409' using message='Keep the original resolved closing identity.';end if;
 return new;
end $$;
create trigger resolved_closing_identity before insert on public.day_closings for each row execute function private.reject_resolved_closing_identity();
create trigger resolved_closing_cash_identity before insert on public.sales for each row execute function private.reject_resolved_closing_identity();
create trigger resolved_closing_audit_identity before insert on public.events for each row execute function private.reject_resolved_closing_identity();

create function private.finish_closing_review(review_id public.ulid,secret text,outcome text,replacement_ticket public.ulid,replacement_secret text,replacement_hash text,replacement_records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.closing_review_tickets;n private.closing_write_tickets;old private.shop_command_receipts;resolved private.closing_command_resolutions;
 state jsonb;after_state jsonb;applied jsonb;metadata jsonb;at_ms public.utc_ms;lock_id text;expected_intent text;review_json text;
 c public.day_closings;s public.sales;closing_link public.ulid;position_value bigint;
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 if review_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' or outcome is null or outcome not in('withdrawn','replaced') then raise invalid_parameter_value using message='Keep the selected closing review.';end if;
 select * into t from private.closing_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Read the original closing outcome or review again.';end if;
 for lock_id in select x from unnest(array[t.command_id::text,t.replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform private.closing_review_access_subject(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for update;
 perform 1 from public.outlets o where o.id=t.outlet_id and o.business_id=t.business_id for update;
 perform private.closing_review_access_subject(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 -- Real original outcomes survive expired or superseded comparisons.
 select * into old from private.shop_command_receipts r where r.id=t.command_id;
 if found then
  if old.business_id<>t.business_id or old.outlet_id<>t.outlet_id or old.actor_id<>t.actor_id or old.auth_user_id<>t.auth_user_id or old.type<>t.type or old.request_hash<>t.original_hash or old.receipt->>'closingId' is distinct from t.closing_id::text then raise sqlstate 'PT409' using message='Keep the original closing receipt.';end if;
  return old.receipt;
 end if;
 select * into resolved from private.closing_command_resolutions r where r.command_id=t.command_id;
 if found then
  if resolved.business_id<>t.business_id or resolved.outlet_id<>t.outlet_id or resolved.actor_id<>t.actor_id or resolved.auth_user_id<>t.auth_user_id or resolved.type<>t.type or resolved.closing_id<>t.closing_id or resolved.original_hash<>t.original_hash or resolved.source_hash<>t.source_hash then raise sqlstate 'PT409' using message='Keep the original closing resolution.';end if;
  return resolved.receipt;
 end if;
 select * into t from private.closing_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Review the current closing values again.';end if;
 state:=private.closing_review_state(t.business_id,t.outlet_id,t.actor_id,t.type,t.command_id,t.closing_id,t.sale_id,t.sale_event_id);
 if sha256(convert_to(state::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed closing values changed. Review them again.';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) or exists(select 1 from private.command_receipts r where r.id=t.command_id) then raise sqlstate 'PT409' using message='Keep the original closing identity.';end if;
 if outcome='withdrawn' then
  if replacement_ticket is not null or replacement_secret is not null or replacement_hash is not null or replacement_records is not null and replacement_records<>'null'::jsonb then raise invalid_parameter_value using message='A withdrawal cannot apply another closing or cash receipt.';end if;
 else
  if (state->>'available')::boolean is not true then raise sqlstate 'PT409' using message='The original closing proposal is unavailable.';end if;
  if replacement_ticket is null or replacement_secret is null or replacement_secret!~'^[A-Za-z0-9_-]{43}$' or replacement_hash is null or replacement_hash!~'^[a-f0-9]{64}$' then raise invalid_parameter_value using message='Keep the complete reviewed closing preparation.';end if;
  select * into n from private.closing_write_tickets r where r.id=replacement_ticket and r.token_hash=sha256(convert_to(replacement_secret,'UTF8')) for update;
  if not found or n.command_id<>t.replacement_id or n.business_id<>t.business_id or n.outlet_id<>t.outlet_id or n.actor_id<>t.actor_id or n.auth_user_id<>t.auth_user_id or n.type<>t.type or n.occurred_at<>t.occurred_at or n.request_hash<>replacement_hash
   or n.plan->>'closingId' is distinct from t.closing_id::text or n.plan->>'saleId' is distinct from t.sale_id::text or n.plan->>'saleEventId' is distinct from t.sale_event_id::text then raise invalid_parameter_value using message='Keep the original closing, cash, member and physical time.';end if;
  if n.expires_at<=at_ms or n.snapshot_hash<>sha256(convert_to(state->>'contextJson','UTF8')) then raise sqlstate 'PT409' using message='Prepare the checked closing against the same current state again.';end if;
  review_json:=case when t.type='closing.record' then n.plan->>'reviewJson' else null end;
  expected_intent:=private.closing_review_intent(t.type,t.replacement_id,t.outlet_id,t.closing_id,t.sale_id,t.sale_event_id,t.occurred_at,t.facts,review_json);
  if expected_intent is null or encode(sha256(convert_to(expected_intent,'UTF8')),'hex')<>replacement_hash then raise invalid_parameter_value using message='Keep the exact counted amount, note, surplus choice and reviewed comparison.';end if;
  if t.type='closing.record' then
   if n.plan->>'day' is distinct from t.facts->>'day' or n.plan->>'currency' is distinct from t.facts->>'currency' or n.plan->>'timezone' is distinct from t.facts->>'timezone'
    or (n.plan->>'countedCash')::numeric is distinct from (t.facts->>'countedCash')::numeric or (n.plan->>'addDifference')::boolean is distinct from (t.sale_id is not null) or n.plan->>'noteJson' is distinct from t.facts->>'noteJson' then raise invalid_parameter_value using message='Keep the original counted day, currency, count and explanation.';end if;
  else
   select * into c from public.day_closings x where x.id=t.closing_id and x.business_id=t.business_id and x.outlet_id=t.outlet_id for update;
   select * into s from public.sales x where x.id=t.sale_id and x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.closing_id=t.closing_id for update;
   if c.id is null or c.voided_at is not null or c.added_sale_id is distinct from t.sale_id or c.event_id::text is distinct from t.facts->>'closingEventId'
    or c.created_at::numeric is distinct from (t.facts->>'closingCreatedAt')::numeric or c.currency is distinct from t.facts->>'currency' or c.timezone is distinct from t.facts->>'timezone' or c.day::text is distinct from t.facts->>'day'
    or c.counted_cash::numeric is distinct from (t.facts->>'countedCash')::numeric or c.expected_cash::numeric is distinct from (t.facts->>'expectedCash')::numeric or c.difference::numeric is distinct from (t.facts->>'difference')::numeric or c.added_walk_in::numeric is distinct from (t.facts->>'addedWalkIn')::numeric
    or at_ms<c.created_at or (to_timestamp(at_ms::double precision/1000) at time zone c.timezone)::date<>c.day
    or t.sale_id is not null and (s.id is null or s.voided_at is not null or s.event_id::text is distinct from t.facts->>'saleEventId' or s.created_at::numeric is distinct from (t.facts->>'saleCreatedAt')::numeric or s.currency<>c.currency or s.amount<>c.added_walk_in) then raise sqlstate 'PT409' using message='Keep the original closing parent, cash and actual same-day undo deadline.';end if;
  end if;
  applied:=private.finish_closing_write(replacement_ticket,replacement_secret,replacement_records);
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if applied is not null and (applied->>'at')::bigint>at_ms then raise sqlstate 'PT409' using message='Review the actual closing admission clock again.';end if;
 if outcome='replaced' and t.type='closing.undo' and (to_timestamp(at_ms::double precision/1000) at time zone (t.facts->>'timezone'))::date::text<>t.facts->>'day' then raise sqlstate 'PT409' using message='The original closing undo day has ended.';end if;
 metadata:=jsonb_build_object('id',t.id,'type','command.resolved','commandId',t.command_id,'commandType',t.type,'closingId',t.closing_id,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'commandHash',t.original_hash,'sourceHash',t.source_hash,'at',at_ms,'outcome',outcome,
  'replacement',case when outcome='withdrawn' then null else jsonb_build_object('id',t.replacement_id,'commandHash',n.request_hash,'reviewJson',review_json,'receipt',applied) end);
 after_state:=private.closing_review_state(t.business_id,t.outlet_id,t.actor_id,t.type,t.command_id,t.closing_id,t.sale_id,t.sale_event_id);
 position_value:=nextval('private.closing_command_resolutions_position_seq'::regclass);
 select x.id into closing_link from public.day_closings x where x.id=t.closing_id and x.business_id=t.business_id and x.outlet_id=t.outlet_id;
 insert into public.events(id,business_id,outlet_id,closing_id,actor_type,actor_id,command,before_data,after_data,at) values(t.command_id,t.business_id,t.outlet_id,closing_link,'member',t.actor_id,'sync.resolve',
  json_build_object('resolutionId',t.id,'commandId',t.command_id,'commandType',t.type,'commandHash',t.original_hash,'sourceHash',t.source_hash,'originalCommandJson',t.original_intent,'sourceJson',t.source_json,'closingBeforeJson',state->>'contextJson'),
  json_build_object('resolutionId',t.id,'outcome',outcome,'receipt',metadata,'replacementId',case when outcome='replaced' then t.replacement_id else null end,'closingAfterJson',after_state->>'contextJson','closingResolutionPosition',position_value::text),at_ms);
 insert into private.closing_command_resolutions(id,command_id,replacement_id,business_id,outlet_id,actor_id,auth_user_id,type,closing_id,sale_id,sale_event_id,occurred_at,original_hash,source_hash,original_intent,source_json,facts,reserved_ids,outcome,receipt,created_at,position) overriding system value
 values(t.id,t.command_id,case when outcome='replaced' then t.replacement_id else null end,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.closing_id,t.sale_id,t.sale_event_id,t.occurred_at,t.original_hash,t.source_hash,t.original_intent,t.source_json,t.facts,private.closing_review_new_ids(t.type,t.command_id,t.closing_id,t.sale_id,t.sale_event_id),outcome,metadata,at_ms,position_value);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.original_hash,metadata);
 delete from private.closing_write_tickets r where r.command_id=t.command_id;
 if outcome='replaced' and t.type='closing.undo' and (clock_timestamp() at time zone (t.facts->>'timezone'))::date::text<>t.facts->>'day' then raise sqlstate 'PT409' using message='The original closing undo day has ended.';end if;
 return metadata;
end $$;
revoke all on function private.reject_resolved_closing_identity(),private.finish_closing_review(public.ulid,text,text,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.finish_closing_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;
create function public.finish_closing_review(p_id public.ulid,p_token text,p_outcome text,p_replacement_ticket public.ulid,p_replacement_token text,p_replacement_hash text,p_replacement_records jsonb) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_closing_review(p_id,p_token,p_outcome,p_replacement_ticket,p_replacement_token,p_replacement_hash,p_replacement_records)$$;
revoke all on function public.finish_closing_review(public.ulid,text,text,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_closing_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;

-- Preserve the ordinary command/body/plan bounds and all existing row/audit/
-- source/clock checks. Only internal normalized images grow for full imports.
create or replace function private.prepare_closing_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;o public.outlets;c public.day_closings;s public.sales;context json;secret text;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This closing is unavailable.';end if;
 if command_id is null or ticket_id is null or outlet is null or occurred is null or kind is null or kind not in ('closing.record','closing.undo')
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or jsonb_typeof(ids) is distinct from 'object' or octet_length(ids::text)>256000
  or (select count(*) from jsonb_object_keys(ids))<>13
  or exists(select 1 from jsonb_object_keys(ids) k where k not in ('closingId','saleId','saleEventId','day','currency','timezone','countedCash','expectedCash','addDifference','reviewJson','summaryJson','noteJson','intentJson'))
  or jsonb_typeof(ids->'intentJson') is distinct from 'string' or octet_length(ids->>'intentJson')>32000 or encode(sha256(convert_to(ids->>'intentJson','UTF8')),'hex')<>fingerprint
  or ids->>'closingId' is null or exists(select 1 from unnest(array['closingId','saleId','saleEventId']) k where ids->>k is not null and (jsonb_typeof(ids->k)<>'string' or (ids->>k)!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
  or ((ids->>'saleId' is null)<>(ids->>'saleEventId' is null)) or command_id::text in(ids->>'closingId',ids->>'saleId',ids->>'saleEventId')
  or ids->>'closingId' in(ids->>'saleId',ids->>'saleEventId') or ids->>'saleId'=ids->>'saleEventId' then raise invalid_parameter_value using message='Keep the exact closing intent and identities.';end if;
 if kind='closing.record' then
  if exists(select 1 from unnest(array['day','currency','timezone','reviewJson','summaryJson','noteJson']) k where jsonb_typeof(ids->k) is distinct from 'string')
   or (ids->>'day')!~'^\d{4}-\d{2}-\d{2}$' or (ids->>'currency')!~'^[A-Z]{3}$'
   or jsonb_typeof(ids->'addDifference') is distinct from 'boolean' or ((ids->>'addDifference')::boolean<>(ids->>'saleId' is not null))
   or exists(select 1 from unnest(array['countedCash','expectedCash']) k where jsonb_typeof(ids->k) is distinct from 'number' or (ids->>k)::numeric<>trunc((ids->>k)::numeric) or (ids->>k)::numeric not between -9007199254740991 and 9007199254740991)
   or (ids->>'countedCash')::numeric<0 or abs((ids->>'countedCash')::numeric-(ids->>'expectedCash')::numeric)>9007199254740991
   or (ids->>'addDifference')::boolean and (ids->>'countedCash')::numeric<=(ids->>'expectedCash')::numeric
   or not (ids->>'addDifference')::boolean and ids->>'summaryJson' is distinct from ids->>'reviewJson' then raise invalid_parameter_value using message='Check the complete closing review and difference.';end if;
 elsif exists(select 1 from unnest(array['day','currency','timezone','countedCash','expectedCash','addDifference','reviewJson','summaryJson','noteJson']) k where (ids->k) is distinct from 'null'::jsonb) then raise invalid_parameter_value using message='Keep the original closing for undo.';end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);perform private.closing_review_access_subject(old.business_id,old.outlet_id,actor,(select auth.uid()));
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This closing is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original closing intent.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select x.business_id into business from public.outlets x where x.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform 1 from public.businesses b where b.id=business for share;
 select * into o from public.outlets x where x.business_id=business and x.id=outlet for update;
 perform private.closing_review_access_subject(business,outlet,actor,(select auth.uid()));
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 if kind='closing.record' then
  if exists(select 1 from public.day_closings x where x.id=ids->>'closingId') then raise insufficient_privilege using message='This closing identity is unavailable.';end if;
  if o.currency is distinct from ids->>'currency' or o.timezone is distinct from ids->>'timezone' or (to_timestamp(occurred::double precision/1000) at time zone o.timezone)::date::text is distinct from ids->>'day' then raise sqlstate 'PT409' using message='Review the shop day, currency and timezone.';end if;
  if exists(select 1 from public.day_closings x where x.business_id=business and x.outlet_id=outlet and x.currency=o.currency and x.day=(ids->>'day')::date and x.voided_at is null) then raise sqlstate 'PT409' using message='This shop day is already closed.';end if;
  if exists(select 1 from public.sales x where x.id=ids->>'saleId') then raise unique_violation using message='This receipt identity is unavailable.';end if;
 else
  select * into c from public.day_closings x where x.business_id=business and x.outlet_id=outlet and x.id=ids->>'closingId' for update;
  if not found or c.added_sale_id::text is distinct from ids->>'saleId' then raise insufficient_privilege using message='This closing is unavailable.';end if;
  if c.voided_at is not null or at_ms<c.created_at or occurred<c.created_at or (to_timestamp(at_ms::double precision/1000) at time zone c.timezone)::date<>c.day or (to_timestamp(occurred::double precision/1000) at time zone c.timezone)::date<>c.day then raise sqlstate 'PT409' using message='A closing can be undone once on its original shop day.';end if;
 end if;
 delete from private.closing_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.closing_write_tickets t where t.command_id=prepare_closing_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>(ids-'intentJson'))) then raise unique_violation using message='Keep the original closing intent.';end if;
 delete from private.closing_write_tickets t where t.command_id=prepare_closing_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.closing_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.closing_write_context(business,outlet,actor,kind,ids);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.closing_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids-'intentJson',occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create or replace function private.finish_closing_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.closing_write_tickets;old private.shop_command_receipts;c public.day_closings;s public.sales;saved public.day_closings;saved_sale public.sales;o public.outlets;
 r jsonb;v jsonb;allowed jsonb;table_name text;keys text;casts text;immutable text;unchanged boolean;at_ms public.utc_ms;has_sale boolean;delta numeric;metadata jsonb;
 specs jsonb:='{"day_closings":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","active_key","day","timezone","currency","summary","counted_cash","expected_cash","difference","added_walk_in","added_sale_id","note","preview_fingerprint","created_by_name","business_id"],"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.closing_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This closing preparation is unavailable.';end if;
 if secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This closing proof is unavailable.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));
 perform 1 from public.businesses b where b.id=t.business_id for share;
 select * into o from public.outlets x where x.business_id=t.business_id and x.id=t.outlet_id for update;
 perform private.closing_review_access_subject(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 select * into old from private.shop_command_receipts r where r.id=t.command_id;
 if found then
  if old.business_id<>t.business_id or old.outlet_id<>t.outlet_id or old.actor_id<>t.actor_id or old.auth_user_id<>t.auth_user_id or old.type<>t.type or old.request_hash<>t.request_hash or old.receipt->>'closingId' is distinct from t.plan->>'closingId' then raise sqlstate 'PT409' using message='Keep the original closing receipt.';end if;
  return old.receipt;
 end if;
 select * into t from private.closing_write_tickets x where x.id=ticket_id for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This closing proof is unavailable.';end if;
 perform private.closing_review_access_subject(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 if t.snapshot_hash<>sha256(convert_to(private.closing_write_context(t.business_id,t.outlet_id,t.actor_id,t.type,t.plan)::text,'UTF8')) then raise sqlstate 'PT409' using message='The closing source changed.' ,detail='closing_snapshot_changed';end if;
 has_sale:=t.plan->>'saleId' is not null;
 select * into c from public.day_closings x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'closingId';
 select * into s from public.sales x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.closing_id=c.id and x.id=t.plan->>'saleId';
 if t.type='closing.undo' and (c.id is null or c.voided_at is not null or c.added_sale_id::text is distinct from t.plan->>'saleId' or at_ms<c.created_at or t.occurred_at<c.created_at
  or (to_timestamp(at_ms::double precision/1000) at time zone c.timezone)::date<>c.day or (to_timestamp(t.occurred_at::double precision/1000) at time zone c.timezone)::date<>c.day
  or has_sale and (s.id is null or s.voided_at is not null or s.method<>'cash' or s.currency<>c.currency or s.amount<>c.added_walk_in or s.order_id is not null or s.customer_id is not null)) then raise sqlstate 'PT409' using message='This closing or its original receipt cannot be undone.';end if;
 if records is null or jsonb_typeof(records)<>'array' or octet_length(records::text)>48000000 or jsonb_array_length(records)<>(case when has_sale then 4 else 2 end)
  or records->0->>'table' is distinct from 'day_closings' or (select count(*) from jsonb_array_elements(records) x where x->>'table'='day_closings')<>1
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='sales')<>(case when has_sale then 1 else 0 end)
  or (select count(*) from jsonb_array_elements(records) x where x->>'table'='events')<>(case when has_sale then 2 else 1 end)
  or exists(select 1 from jsonb_array_elements(records) x group by x->>'table',x->'values'->>'id' having count(*)>1) then raise invalid_parameter_value using message='Keep the complete closing transaction.';end if;
 perform private.assert_closing_audits(t,records);
 delta:=case when t.type='closing.record' then (t.plan->>'countedCash')::numeric-(t.plan->>'expectedCash')::numeric else c.difference end;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if jsonb_typeof(r) is distinct from 'object' or (select count(*) from jsonb_object_keys(r))<>2 or not r ? 'table' or not r ? 'values' or allowed is null or jsonb_typeof(v) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed) or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid closing fields or scope.';end if;
  if table_name='day_closings' then
   if v->>'id' is distinct from t.plan->>'closingId' or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(c.created_at,t.occurred_at)) then raise invalid_parameter_value using message='Invalid closing identity or clock.';end if;
   if t.type='closing.record' then
    if c.id is not null or v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.command_id::text or (v->>'created_at')::bigint is distinct from t.occurred_at
     or v->>'created_by_name' is distinct from (select m.name::text from public.members m where m.business_id=t.business_id and m.id=t.actor_id)
     or v->>'day' is distinct from t.plan->>'day' or v->>'currency' is distinct from o.currency or v->>'timezone' is distinct from o.timezone
     or v->>'active_key' is distinct from to_json(o.currency||':'||(t.plan->>'day'))::text or v->>'voided_at' is not null
     or (v->>'counted_cash')::numeric is distinct from (t.plan->>'countedCash')::numeric or (v->>'expected_cash')::numeric is distinct from (t.plan->>'expectedCash')::numeric
     or (v->>'difference')::numeric is distinct from delta or (v->>'added_walk_in')::numeric is distinct from (case when has_sale then delta else 0 end)
     or v->>'added_sale_id' is distinct from t.plan->>'saleId' or v->>'note' is distinct from t.plan->>'noteJson' or v->>'preview_fingerprint' is distinct from t.plan->>'reviewJson' or v->>'summary' is distinct from t.plan->>'summaryJson' then raise invalid_parameter_value using message='Keep the reviewed closing snapshot and count.';end if;
   elsif v->>'active_key' is not null or (v->>'voided_at')::bigint is distinct from t.occurred_at then raise invalid_parameter_value using message='Invalid closing undo.';end if;
  elsif table_name='sales' then
   if v->>'id' is distinct from t.plan->>'saleId' or v->>'closing_id' is distinct from t.plan->>'closingId' or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(s.created_at,t.occurred_at)) then raise invalid_parameter_value using message='Keep the linked closing receipt and clock.';end if;
   if t.type='closing.record' then
    if v->>'created_by' is distinct from t.actor_id::text or v->>'event_id' is distinct from t.plan->>'saleEventId' or (v->>'created_at')::bigint is distinct from t.occurred_at
     or v->>'voided_at' is not null or v->>'void_reason' is not null or v->>'method' is distinct from 'cash' or v->>'method_name' is distinct from '"Cash"' or v->>'who' is distinct from '"Walk-in"'
     or v->>'order_id' is not null or v->>'order_number' is not null or v->>'customer_id' is not null or v->>'credit_account_id' is not null or v->>'delivery_fee' is not null or v->>'discount' is not null
     or v->>'currency' is distinct from o.currency or v->>'timezone' is distinct from o.timezone or (v->>'amount')::numeric is distinct from delta or (v->>'given')::numeric is distinct from delta or (v->>'change')::numeric is distinct from 0
     or v->>'items' is distinct from '[]' or v->>'shop_name' is distinct from (select b.name::text from public.businesses b where b.id=t.business_id) then raise invalid_parameter_value using message='Keep the exact positive walk-in receipt.';end if;
   elsif (v->>'voided_at')::bigint is distinct from t.occurred_at or v->>'void_reason' is distinct from 'undo' then raise invalid_parameter_value using message='Invalid closing receipt undo.';end if;
  else
   if v->>'actor_type' is distinct from 'member' or v->>'actor_id' is distinct from t.actor_id::text or v->>'closing_id' is distinct from t.plan->>'closingId' or (v->>'at')::bigint is distinct from t.created_at
    or exists(select 1 from unnest(array['customer_id','order_id','order_revision','stock_item_id','stock_revision','supplier_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid closing audit identity or scope.';end if;
   if v->>'id'=t.command_id::text then
    if v->>'command' is distinct from t.type or v->>'undo_of' is distinct from (case when t.type='closing.undo' then c.event_id::text else null end) then raise invalid_parameter_value using message='Keep the closing audit and undo link.';end if;
   elsif not has_sale or v->>'id' is distinct from t.plan->>'saleEventId' or v->>'command' is distinct from (case when t.type='closing.record' then 'sale.record' else 'sale.closing-undo' end) or v->>'undo_of' is distinct from (case when t.type='closing.undo' then s.event_id::text else null end) then raise invalid_parameter_value using message='Keep the companion receipt audit.';end if;
  end if;
  if t.type='closing.undo' and table_name in ('day_closings','sales') then
   select string_agg(format('($1->>%L) is not distinct from source.%I::text',k,k),' and ') into immutable from jsonb_object_keys(v) k where k not in ('updated_at','voided_at',case when table_name='sales' then 'void_reason' else 'active_key' end);
   execute format('select %s from public.%I source where source.id=$2',immutable,table_name) into unchanged using v,(v->>'id')::public.ulid;
   if unchanged is distinct from true then raise invalid_parameter_value using message='Keep the complete original closing or receipt.';end if;
   if table_name='day_closings' then update public.day_closings x set active_key=null,voided_at=t.occurred_at,updated_at=(v->>'updated_at')::bigint where x.id=c.id;
   else update public.sales x set voided_at=t.occurred_at,void_reason='undo',updated_at=(v->>'updated_at')::bigint where x.id=s.id;end if;
  else
   select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key) into keys,casts
    from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
   execute format('insert into public.%I(%s) select %s',table_name,keys,casts) using v;
  end if;
 end loop;
 if not exists(select 1 from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=t.command_id::text) or has_sale and not exists(select 1 from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=t.plan->>'saleEventId') then raise invalid_parameter_value using message='Keep every closing audit.';end if;
 select * into saved from public.day_closings x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'closingId';
 select * into saved_sale from public.sales x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=t.plan->>'saleId';
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.type='closing.undo' and (to_timestamp(at_ms::double precision/1000) at time zone saved.timezone)::date<>saved.day then raise sqlstate 'PT409' using message='The original closing undo day has ended.';end if;
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'closingId',saved.id,'occurredAt',t.occurred_at,'at',t.created_at,'day',saved.day::text,'difference',saved.difference,'addedWalkIn',saved.added_walk_in,'closingUpdatedAt',saved.updated_at,'saleId',saved_sale.id,'saleUpdatedAt',saved_sale.updated_at,'undoOf',case when t.type='closing.undo' then saved.id else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.closing_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;

-- Compare full domain images without decoding unrelated literal JSON strings.
-- Quote raw value-string tokens before JSONB use. One regex scan and one
-- aggregate avoid repeatedly rescanning/copying multi-megabyte imports.
create function private.closing_audit_tokens(value json) returns jsonb
language sql immutable strict security invoker set search_path='' as $$
 select string_agg(case when m[1] is null then m[3] when m[2] is not null then m[1]||m[2] else to_json(m[1])::text end,'' order by position)::jsonb
 from regexp_matches(value::text,'("(?:[^"\\]|\\.)*")([[:space:]]*:)?|([^"]+)','g') with ordinality r(m,position)
$$;
create function private.closing_audit_image(table_name text,wire jsonb) returns json
language plpgsql immutable security invoker set search_path='' as $$
declare specs jsonb:='{"day_closings":{"id":"id","created_at":"n:createdAt","updated_at":"n:updatedAt","outlet_id":"outletId","created_by":"createdBy","event_id":"eventId","voided_at":"n:voidedAt","active_key":"e:activeKey","day":"day","timezone":"timezone","currency":"currency","summary":"j:summary","counted_cash":"n:countedCash","expected_cash":"n:expectedCash","difference":"n:difference","added_walk_in":"n:addedWalkIn","added_sale_id":"addedSaleId","note":"j:note","preview_fingerprint":"previewFingerprint","created_by_name":"j:createdByName"},"sales":{"id":"id","created_at":"n:createdAt","updated_at":"n:updatedAt","outlet_id":"outletId","created_by":"createdBy","event_id":"eventId","voided_at":"n:voidedAt","order_id":"orderId","order_number":"orderNumber","closing_id":"closingId","delivery_fee":"n:deliveryFee","discount":"n:discount","expression":"expression","amount":"n:amount","currency":"currency","method":"method","method_name":"j:methodName","given":"n:given","change":"n:change","who":"j:who","customer_id":"customerId","credit_account_id":"creditAccountId","items":"j:items","shop_name":"j:shopName","shop_link":"shopLink","timezone":"timezone","void_reason":"voidReason"}}';result json;
begin
 if specs->table_name is null or jsonb_typeof(wire) is distinct from 'object' then raise invalid_parameter_value using message='Keep the complete closing audit image.';end if;
 select json_object_agg(case when strpos(e.value,':')>0 then split_part(e.value,':',2) else e.value end,
  case when left(e.value,2) in('j:','e:') then (wire->>e.key)::json else (wire->e.key)::text::json end order by e.key)
 into result from jsonb_each_text(specs->table_name) e where wire->e.key is not null and wire->e.key<>'null'::jsonb;
 return result;
end $$;
create function private.closing_existing_audit_image(table_name text,business public.ulid,outlet public.ulid,row_id public.ulid) returns json
language plpgsql volatile security invoker set search_path='' as $$declare c public.day_closings;s public.sales;wire jsonb;
begin
 if table_name='day_closings' then
  select * into c from public.day_closings x where x.business_id=business and x.outlet_id=outlet and x.id=row_id;
  if not found then return 'null'::json;end if;
  wire:=jsonb_build_object('id',c.id,'created_at',c.created_at,'updated_at',c.updated_at,'outlet_id',c.outlet_id,'created_by',c.created_by,'event_id',c.event_id,'voided_at',c.voided_at,'active_key',c.active_key,'day',c.day::text,'timezone',c.timezone,'currency',c.currency,'summary',c.summary::text,'counted_cash',c.counted_cash,'expected_cash',c.expected_cash,'difference',c.difference,'added_walk_in',c.added_walk_in,'added_sale_id',c.added_sale_id,'note',c.note::text,'preview_fingerprint',c.preview_fingerprint,'created_by_name',c.created_by_name::text);
 elsif table_name='sales' then
  select * into s from public.sales x where x.business_id=business and x.outlet_id=outlet and x.id=row_id;
  if not found then return 'null'::json;end if;
  wire:=jsonb_build_object('id',s.id,'created_at',s.created_at,'updated_at',s.updated_at,'outlet_id',s.outlet_id,'created_by',s.created_by,'event_id',s.event_id,'voided_at',s.voided_at,'order_id',s.order_id,'order_number',s.order_number,'closing_id',s.closing_id,'delivery_fee',s.delivery_fee,'discount',s.discount,'expression',s.expression,'amount',s.amount,'currency',s.currency,'method',s.method,'method_name',s.method_name::text,'given',s.given,'change',s.change,'who',s.who::text,'customer_id',s.customer_id,'credit_account_id',s.credit_account_id,'items',s.items::text,'shop_name',s.shop_name::text,'shop_link',s.shop_link,'timezone',s.timezone,'void_reason',s.void_reason);
 else raise invalid_parameter_value using message='Choose a closing or its cash audit.';
 end if;
 return private.closing_audit_image(table_name,wire);
end $$;
create function private.assert_closing_audits(t private.closing_write_tickets,records jsonb) returns void
language plpgsql volatile security invoker set search_path='' as $$declare audit jsonb;target text;parent public.ulid;after_values jsonb;before_image json;after_image json;
begin
 for audit in select x->'values' from jsonb_array_elements(records) x where x->>'table'='events' loop
  if audit->>'id'=t.command_id::text then target:='day_closings';parent:=(t.plan->>'closingId')::public.ulid;
  elsif audit->>'id'=t.plan->>'saleEventId' then target:='sales';parent:=(t.plan->>'saleId')::public.ulid;
  else raise invalid_parameter_value using message='Keep the exact closing audit identities.';end if;
  select x->'values' into after_values from jsonb_array_elements(records) x where x->>'table'=target;
  before_image:=case when t.type='closing.record' then 'null'::json else private.closing_existing_audit_image(target,t.business_id,t.outlet_id,parent) end;
  after_image:=private.closing_audit_image(target,after_values);
  if private.closing_audit_tokens((audit->>'before_data')::json) is distinct from private.closing_audit_tokens(before_image) or private.closing_audit_tokens((audit->>'after_data')::json) is distinct from private.closing_audit_tokens(after_image) then raise invalid_parameter_value using message='Keep the complete actual closing before and after images.';end if;
 end loop;
end $$;
revoke all on function private.closing_audit_tokens(json),private.closing_audit_image(text,jsonb),private.closing_existing_audit_image(text,public.ulid,public.ulid,public.ulid),private.assert_closing_audits(private.closing_write_tickets,jsonb) from public,anon,authenticated,service_role;
