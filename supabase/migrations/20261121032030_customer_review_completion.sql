-- Finish an explicitly reviewed customer action in the same transaction as its
-- ordinary mutation. The original command/source remain opaque, unchanged TEXT.
create function private.customer_review_access_subject(business public.ulid,outlet public.ulid,actor public.ulid,customer public.ulid,kind text,subject uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform private.customer_write_actor(business,outlet,actor,subject);
 if exists(select 1 from public.customers c where c.id=customer and c.business_id=business) then
  if not exists(select 1 from public.members m where m.id=actor and m.business_id=business and m.role='owner')
   and not exists(select 1 from public.customer_outlets a where a.business_id=business and a.outlet_id=outlet and a.customer_id=customer) then raise insufficient_privilege using message='This customer review is unavailable.';end if;
  perform private.customer_status_scope(business,outlet,actor,customer,kind);
 end if;
end $$;
create or replace function private.customer_review_access(business public.ulid,outlet public.ulid,actor public.ulid,customer public.ulid,kind text) returns void
language sql security invoker set search_path='' as $$select private.customer_review_access_subject(business,outlet,actor,customer,kind,(select auth.uid()))$$;

create function private.customer_review_replacement_hash(t private.customer_review_tickets) returns text
language plpgsql immutable security invoker set search_path='' as $$declare prefix text;
begin
 prefix:='{"id":"'||t.command_id::text||'",';
 if left(t.original_intent,length(prefix))<>prefix then raise invalid_parameter_value using message='Keep the original customer command encoding.';end if;
 -- Replace only the first primary ID; the same literal ID may appear in notes.
 return encode(sha256(convert_to('{"id":"'||t.replacement_id::text||'",'||substr(t.original_intent,length(prefix)+1),'UTF8')),'hex');
end $$;
create function private.customer_review_original_terms(t private.customer_review_tickets) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare ids_json text;opening_json text;suffix text;prefix text;part text;credit_match text[];terms jsonb;
begin
 ids_json:='{"accountId":"'||(t.ids->>'accountId')||'","accountEventId":"'||(t.ids->>'accountEventId')||'","openingEntryId":"'||(t.ids->>'openingEntryId')||'","openingEventId":"'||(t.ids->>'openingEventId')||'"}';
 suffix:=',"ids":'||ids_json||'}';
 if t.type='khata.settings' then
  prefix:='{"id":"'||t.command_id::text||'","customerId":"'||t.customer_id::text||'","outletId":"'||t.outlet_id::text||'","type":"khata.settings","accountId":'||case when t.account_id is null then 'null' else '"'||t.account_id::text||'"' end||',"input":';
  part:=substr(t.original_intent,length(prefix)+1,length(t.original_intent)-length(prefix)-length(suffix));
 else
  opening_json:=case when t.facts->'opening'='null' then 'null' else '{"amount":'||(t.facts->'opening'->>'amount')||',"occurredAt":'||(t.facts->'opening'->>'occurredAt')||'}' end;
  suffix:=',"opening":'||opening_json||suffix;
  prefix:=left(t.original_intent,length(t.original_intent)-length(suffix));
  credit_match:=regexp_match(prefix,',"credit":(null|\{"allowed":(?:true|false),"limit":(?:0|[1-9][0-9]{0,15}),"reminder":\{"enabled":(?:true|false),"dayOfMonth":[0-9]{1,2},"tone":"(?:gentle|direct)","channel":"whatsapp"\}\})$');
  if credit_match is null then raise invalid_parameter_value using message='Keep the exact original credit choices.';end if;
  part:=credit_match[1];
 end if;
 if part='null' then return '{"allowed":false,"limit":0,"reminder":{"enabled":false,"dayOfMonth":2,"tone":"gentle","channel":"whatsapp"}}'::jsonb;end if;
 -- Only this closed, text-free credit grammar may be decoded. Never parse the
 -- complete command: even json field access fails on unrelated NUL/surrogates.
 if part!~'^\{"allowed":(?:true|false),"limit":(?:0|[1-9][0-9]{0,15}),"reminder":\{"enabled":(?:true|false),"dayOfMonth":[0-9]{1,2},"tone":"(?:gentle|direct)","channel":"whatsapp"\}\}$' then raise invalid_parameter_value using message='Keep the exact original credit terms.';end if;
 terms:=part::jsonb;
 if (terms->>'limit')::numeric>9007199254740991 or (terms->'reminder'->>'dayOfMonth')::int not between 1 and 31 then raise invalid_parameter_value using message='Check the original credit terms.';end if;
 return terms;
end $$;

create function private.reject_resolved_customer_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Existing parents remain useful after replacement. Never reserve an existing
 -- account or an unused planned slot as if it had been created by the action.
 if tg_table_name='customers' then
  if exists(select 1 from public.customers c where c.id=new.id and c.business_id=new.business_id) then return new;end if;
 elsif tg_table_name='credit_accounts' then
  if exists(select 1 from public.credit_accounts a where a.id=new.id and a.business_id=new.business_id and a.outlet_id=new.outlet_id and a.customer_id=new.customer_id) then return new;end if;
 end if;
 if exists(select 1 from private.customer_command_resolutions r where r.reserved_ids@>array[new.id]) then raise sqlstate 'PT409' using message='Keep the original resolved customer identities.';end if;
 return new;
end $$;
create trigger resolved_customer_identity before insert on public.customers for each row execute function private.reject_resolved_customer_identity();
create trigger resolved_customer_account_identity before insert on public.credit_accounts for each row execute function private.reject_resolved_customer_identity();
create trigger resolved_customer_entry_identity before insert on public.credit_entries for each row execute function private.reject_resolved_customer_identity();
create trigger resolved_customer_audit_identity before insert on public.events for each row execute function private.reject_resolved_customer_identity();
create index customer_review_tickets_command_idx on private.customer_review_tickets(command_id);
create index customer_review_tickets_replacement_idx on private.customer_review_tickets(replacement_id);

create function private.finish_customer_review(review_id public.ulid,secret text,outcome text,replacement_ticket public.ulid,replacement_secret text,replacement_hash text,replacement_records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.customer_review_tickets;n private.customer_write_tickets;old private.shop_command_receipts;resolved private.customer_command_resolutions;
 state jsonb;after_state jsonb;applied jsonb;metadata jsonb;at_ms public.utc_ms;lock_id text;account_count int;entry_count int;event_count int;
 a jsonb;entry jsonb;v jsonb;terms jsonb;consent jsonb;current_customer public.customers;expected_account public.ulid;primary_account_event public.ulid;parent_created public.utc_ms;customer_link public.ulid;position_value bigint;
begin
 if review_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' or outcome is null or outcome not in('withdrawn','replaced') then raise invalid_parameter_value using message='Keep the selected customer review.';end if;
 select * into t from private.customer_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Read the original customer outcome or review again.';end if;
 for lock_id in select x from unnest(array[t.command_id::text,t.replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for update;
 perform 1 from public.outlets o where o.id=t.outlet_id and o.business_id=t.business_id for update;
 perform private.customer_review_access_subject(t.business_id,t.outlet_id,t.actor_id,t.customer_id,t.type,t.auth_user_id);
 -- Recover a genuine outcome before any expired or changed-state check.
 select * into old from private.shop_command_receipts r where r.id=t.command_id;
 if found then
  if old.business_id<>t.business_id or old.outlet_id<>t.outlet_id or old.actor_id<>t.actor_id or old.auth_user_id<>t.auth_user_id or old.type<>t.type or old.customer_id is distinct from t.customer_id or old.request_hash<>t.original_hash then raise sqlstate 'PT409' using message='Keep the original customer receipt.';end if;
  return old.receipt;
 end if;
 select * into resolved from private.customer_command_resolutions r where r.command_id=t.command_id;
 if found then
  if resolved.business_id<>t.business_id or resolved.outlet_id<>t.outlet_id or resolved.actor_id<>t.actor_id or resolved.auth_user_id<>t.auth_user_id or resolved.customer_id<>t.customer_id or resolved.type<>t.type or resolved.original_hash<>t.original_hash then raise sqlstate 'PT409' using message='Keep the original customer resolution.';end if;
  return resolved.receipt;
 end if;
 select * into t from private.customer_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Review the current customer values again.';end if;
 state:=private.customer_review_state(t.business_id,t.outlet_id,t.customer_id,t.type,t.command_id,t.ids,t.facts);
 if sha256(convert_to(state::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed customer values changed. Review them again.';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) or exists(select 1 from private.command_receipts r where r.id=t.command_id) then raise sqlstate 'PT409' using message='Keep the original customer identity.';end if;
 if outcome='withdrawn' then
  if replacement_ticket is not null or replacement_secret is not null or replacement_hash is not null or replacement_records is not null and replacement_records<>'null'::jsonb then raise invalid_parameter_value using message='A withdrawal cannot apply another customer action.';end if;
 else
  if (state->>'available')::boolean is not true or (state->>'phoneTaken')::boolean is true then raise sqlstate 'PT409' using message='The original customer proposal is unavailable.';end if;
  if replacement_ticket is null or replacement_secret is null or replacement_secret!~'^[A-Za-z0-9_-]{43}$' or replacement_hash is distinct from private.customer_review_replacement_hash(t) then raise invalid_parameter_value using message='Keep the exact distinct original customer proposal.';end if;
  select * into n from private.customer_write_tickets r where r.id=replacement_ticket and r.token_hash=sha256(convert_to(replacement_secret,'UTF8')) for update;
  if not found or n.command_id<>t.replacement_id or n.business_id<>t.business_id or n.outlet_id<>t.outlet_id or n.customer_id<>t.customer_id or n.actor_id<>t.actor_id or n.auth_user_id<>t.auth_user_id or n.type<>t.type or n.ids is distinct from t.ids or n.request_hash<>replacement_hash then raise invalid_parameter_value using message='Keep the original customer scope, account and planned records.';end if;
  if n.expires_at<=at_ms then raise sqlstate 'PT409' using message='Prepare the reviewed customer admission again.';end if;
  a:=t.facts->'account';entry:=t.facts->'opening';
  expected_account:=case when t.type in('customer.archive','customer.restore') or a->>'created'='true' then null else (t.ids->>'accountId')::public.ulid end;
  if n.account_id is distinct from expected_account or n.snapshot_hash<>private.customer_write_snapshot(t.business_id,t.outlet_id,t.customer_id,n.account_id,t.type) then raise sqlstate 'PT409' using message='The original customer account or snapshot changed.';end if;
  if a<>'null' and ((a->>'created')::boolean and exists(select 1 from public.credit_accounts x where x.id=a->>'id') or not(a->>'created')::boolean and not exists(select 1 from public.credit_accounts x where x.id=a->>'id' and x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.customer_id=t.customer_id and x.currency=a->>'currency')) then raise sqlstate 'PT409' using message='Keep the original financial parent and monetary unit.';end if;
  if replacement_records is null or jsonb_typeof(replacement_records) is distinct from 'array' or jsonb_array_length(replacement_records) not between 2 and 6 then raise invalid_parameter_value using message='Keep the complete reviewed customer mutation.';end if;
  select count(*) filter(where x->>'table'='credit_accounts'),count(*) filter(where x->>'table'='credit_entries'),count(*) filter(where x->>'table'='events') into account_count,entry_count,event_count from jsonb_array_elements(replacement_records) x;
  if account_count<>(case when a='null' then 0 else 1 end) or entry_count<>(case when entry='null' then 0 else 1 end) or event_count<>(case when t.type='khata.settings' then 1 else 1+account_count+entry_count end) then raise invalid_parameter_value using message='Keep exactly the original customer financial effects.';end if;
  if a<>'null' then
   terms:=private.customer_review_original_terms(t);
   select x->'values' into v from jsonb_array_elements(replacement_records) x where x->>'table'='credit_accounts';
   if v->>'id' is distinct from a->>'id' or v->>'currency' is distinct from a->>'currency' or (v->>'allowed')::boolean is distinct from (terms->>'allowed')::boolean or (v->>'credit_limit')::numeric is distinct from (terms->>'limit')::numeric or (v->>'reminder')::jsonb is distinct from terms->'reminder' then raise invalid_parameter_value using message='Keep the exact original account, credit and reminder choices.';end if;
   primary_account_event:=case when t.type='khata.settings' then t.replacement_id else (a->>'eventId')::public.ulid end;
   if not exists(select 1 from jsonb_array_elements(replacement_records) x where x->>'table'='events' and x->'values'->>'id'=primary_account_event::text and x->'values'->>'command'=case when (a->>'created')::boolean then 'khata.create' else 'khata.settings' end and ((x->'values'->>'before_data'='null')=(a->>'created')::boolean)) then raise invalid_parameter_value using message='Keep the actual original account creation or terms edit.';end if;
  end if;
  for v in select x->'values' from jsonb_array_elements(replacement_records) x where x->>'table'='customers' loop
   select * into current_customer from public.customers c where c.id=t.customer_id and c.business_id=t.business_id;parent_created:=current_customer.created_at;
   if (t.type in('customer.create','customer.update') and v->>'phone' is distinct from t.facts->>'phone') or (v->>'created_at')::bigint is distinct from coalesce(parent_created,n.created_at) or (v->>'updated_at')::bigint is distinct from greatest(n.created_at,coalesce(parent_created,n.created_at)) then raise invalid_parameter_value using message='Keep the saved customer phone and genuine admission clocks.';end if;
   if t.type in('customer.create','customer.update') then
    if v->>'name' is distinct from t.facts->'profile'->>'nameJson' or v->>'nickname' is distinct from t.facts->'profile'->>'nicknameJson' or v->>'address' is distinct from t.facts->'profile'->>'addressJson' or v->>'notes' is distinct from t.facts->'profile'->>'notesJson' or v->>'tags' is distinct from t.facts->'profile'->>'tagsJson' or (v->>'archived_at')::bigint is distinct from current_customer.archived_at then raise invalid_parameter_value using message='Keep every original customer input and current archive state.';end if;
    consent:=case when current_customer.id is not null and current_customer.phone is not distinct from t.facts->>'phone' then current_customer.consent::text::jsonb else jsonb_build_object('savedAt',n.created_at,'source','manual') end;
    if (v->>'consent')::jsonb is distinct from consent then raise invalid_parameter_value using message='Keep genuine customer phone consent.';end if;
   end if;
  end loop;
  if a<>'null' then
   select x.created_at into parent_created from public.credit_accounts x where x.id=a->>'id' and x.business_id=t.business_id;
   select x->'values' into v from jsonb_array_elements(replacement_records) x where x->>'table'='credit_accounts';
   if (v->>'created_at')::bigint is distinct from coalesce(parent_created,n.created_at) or (v->>'updated_at')::bigint is distinct from greatest(n.created_at,coalesce(parent_created,n.created_at)) then raise invalid_parameter_value using message='Keep the genuine account admission clocks.';end if;
  end if;
  if entry<>'null' then
   select x->'values' into v from jsonb_array_elements(replacement_records) x where x->>'table'='credit_entries';
   if v->>'id' is distinct from entry->>'id' or v->>'event_id' is distinct from entry->>'eventId' or v->>'account_id' is distinct from a->>'id' or v->>'currency' is distinct from a->>'currency' or (v->>'amount')::numeric is distinct from (entry->>'amount')::numeric or (v->>'occurred_at')::bigint is distinct from (entry->>'occurredAt')::bigint or v->>'note' is distinct from '"Opening balance"' or (v->>'created_at')::bigint is distinct from n.created_at or (v->>'updated_at')::bigint is distinct from n.created_at then raise invalid_parameter_value using message='Keep the exact original opening balance and physical date.';end if;
  end if;
  applied:=private.finish_customer_write(replacement_ticket,replacement_secret,replacement_records);
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if applied is not null and (applied->>'at')::bigint>at_ms then raise sqlstate 'PT409' using message='Review the actual customer admission clock again.';end if;
 metadata:=jsonb_build_object('id',t.id,'type','command.resolved','commandId',t.command_id,'commandType',t.type,'customerId',t.customer_id,'outletId',t.outlet_id,'commandHash',t.original_hash,'sourceHash',t.source_hash,'at',at_ms,'outcome',outcome,'replacement',case when outcome='withdrawn' then null else jsonb_build_object('id',t.replacement_id,'commandHash',n.request_hash,'receipt',applied) end);
 after_state:=private.customer_review_state(t.business_id,t.outlet_id,t.customer_id,t.type,t.command_id,t.ids,t.facts);
 position_value:=nextval('private.customer_command_resolutions_position_seq'::regclass);
 select c.id into customer_link from public.customers c where c.id=t.customer_id and c.business_id=t.business_id;
 insert into public.events(id,business_id,outlet_id,customer_id,actor_type,actor_id,command,before_data,after_data,at) values(t.command_id,t.business_id,t.outlet_id,customer_link,'member',t.actor_id,'sync.resolve',
  json_build_object('resolutionId',t.id,'commandId',t.command_id,'commandType',t.type,'commandHash',t.original_hash,'sourceHash',t.source_hash,'originalCommandJson',t.original_intent,'sourceJson',t.source_json,'customerBeforeJson',state->>'contextJson'),
  json_build_object('resolutionId',t.id,'outcome',outcome,'receipt',metadata,'replacementId',case when outcome='replaced' then t.replacement_id else null end,'customerAfterJson',after_state->>'contextJson','customerResolutionPosition',position_value::text),at_ms);
 insert into private.customer_command_resolutions(id,command_id,replacement_id,business_id,outlet_id,customer_id,actor_id,auth_user_id,type,original_hash,source_hash,original_intent,source_json,ids,facts,reserved_ids,outcome,receipt,created_at,position) overriding system value
 values(t.id,t.command_id,case when outcome='replaced' then t.replacement_id else null end,t.business_id,t.outlet_id,t.customer_id,t.actor_id,t.auth_user_id,t.type,t.original_hash,t.source_hash,t.original_intent,t.source_json,t.ids,t.facts,private.customer_review_new_ids(t.type,t.customer_id,t.command_id,t.ids,t.facts),outcome,metadata,at_ms,position_value);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.customer_id,t.original_hash,metadata);
 delete from private.customer_write_tickets r where r.command_id=t.command_id;
 return metadata;
end $$;

revoke all on function private.customer_review_access_subject(public.ulid,public.ulid,public.ulid,public.ulid,text,uuid),private.customer_review_replacement_hash(private.customer_review_tickets),private.customer_review_original_terms(private.customer_review_tickets),private.reject_resolved_customer_identity() from public,anon,authenticated,service_role;
revoke all on function private.finish_customer_review(public.ulid,text,text,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.finish_customer_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;
create function public.finish_customer_review(p_id public.ulid,p_token text,p_outcome text,p_replacement_ticket public.ulid,p_replacement_token text,p_replacement_hash text,p_replacement_records jsonb) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_customer_review(p_id,p_token,p_outcome,p_replacement_ticket,p_replacement_token,p_replacement_hash,p_replacement_records)$$;
revoke all on function public.finish_customer_review(public.ulid,text,text,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_customer_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;


-- Complete imported before-images can exceed the old 512 KB internal record
-- envelope. This service-only mutation keeps the existing 32 KB command limit,
-- exact row/column allowlists, live authorization and atomic audit validation.
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
  if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 1 and 6 or octet_length(records::text)>16000000 then
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
