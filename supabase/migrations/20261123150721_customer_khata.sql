-- Customer questions are literal requests for a person, never financial commands.
create table private.customer_khata_actions (
 link_id public.ulid not null references private.public_links(id) on delete cascade,id public.ulid not null,
 intent_json text not null check(octet_length(intent_json)<=32768),outcome json not null,
 primary key(link_id,id)
);
alter table private.customer_khata_actions enable row level security;
alter table private.customer_khata_actions force row level security;
revoke all on private.customer_khata_actions from public,anon,authenticated,service_role;

create function private.visit_customer_khata(secret text,operation text,source_json text,after_sequence bigint,global_limit integer,link_limit integer) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare budget private.public_read_budget;cap private.public_links;saved private.customer_khata_actions;
 input json;control jsonb;field text;message_json json;stats integer[];source_id public.ulid;event_id public.ulid;task_id public.ulid;entry_id public.ulid;kind text;
 at_ms bigint;window_ms bigint;entries json;next_sequence bigint;result json;balance numeric;task_row public.tasks;target_customer public.ulid;
begin
 if operation is null or operation not in('read','submit','inspect','close') or after_sequence is null or after_sequence not between 0 and 9007199254740991
  or global_limit is null or global_limit not between 1 and 60000 or link_limit is null or link_limit not between 1 and 60000
  or operation='read' and source_json is not null or operation<>'read' and (source_json is null or after_sequence<>0) then raise invalid_parameter_value using message='Use the complete khata request.';end if;
 select * into budget from private.public_read_budget b where b.id for update;
 if not found then raise exception 'Customer links unavailable';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;window_ms:=(at_ms/60000)*60000;
 if budget.window_at=window_ms and budget.requests>=global_limit then return json_build_object('v',1,'state','limited','retryAfter',greatest(1,ceil((window_ms+60000-at_ms)/1000.0)::integer));end if;
 update private.public_read_budget set window_at=window_ms,requests=case when budget.window_at=window_ms then budget.requests+1 else 1 end where id;
 if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then return json_build_object('v',1,'state','missing');end if;
 select * into cap from private.public_links c where c.token_hash=sha256(convert_to(secret,'UTF8')) and c.kind='khata' for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;window_ms:=(at_ms/60000)*60000;
 if not found then return json_build_object('v',1,'state','missing');end if;
 if cap.read_window_at=window_ms and cap.read_count>=link_limit then return json_build_object('v',1,'state','limited','retryAfter',greatest(1,ceil((window_ms+60000-at_ms)/1000.0)::integer));end if;
 update private.public_links set read_window_at=window_ms,read_count=case when cap.read_window_at=window_ms then cap.read_count+1 else 1 end where id=cap.id;
 if operation<>'read' then
  begin
   if octet_length(source_json)>32768 then raise invalid_parameter_value;end if;input:=source_json::json;
   if not private.staff_exact(input,array['accountId','at','entryId','eventId','id','kind','linkId','message','taskId','v']) then raise invalid_parameter_value;end if;
   control:='{}'::jsonb;foreach field in array array['accountId','at','entryId','eventId','id','kind','linkId','taskId','v'] loop control:=control||jsonb_build_object(field,private.confirmation_json_field(input,field)::jsonb);end loop;
   if control->>'v'<>'1' or jsonb_typeof(control->'v')<>'number' or control->>'linkId'<>cap.id or control->>'accountId'<>cap.account_id then raise invalid_parameter_value;end if;
   foreach kind in array array['id','eventId','taskId','linkId','accountId'] loop
    if jsonb_typeof(control->kind)<>'string' or control->>kind!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' then raise invalid_parameter_value;end if;
   end loop;
   source_id:=(control->>'id')::public.ulid;event_id:=(control->>'eventId')::public.ulid;task_id:=(control->>'taskId')::public.ulid;
   kind:=control->>'kind';message_json:=private.confirmation_json_field(input,'message');stats:=private.inbox_literal_stats(message_json);
   if jsonb_typeof(control->'kind')<>'string' or kind not in('more-time','question') or stats[1]>2000 or stats[2]<>1 or jsonb_typeof(control->'at')<>'number'
    or (control->>'at')::numeric<>trunc((control->>'at')::numeric) or (control->>'at')::numeric not between 0 and 8640000000000000
    or source_id=event_id or source_id=task_id or event_id=task_id then raise invalid_parameter_value;end if;
   if kind='question' then
    if jsonb_typeof(control->'entryId')<>'string' or control->>'entryId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' then raise invalid_parameter_value;end if;entry_id:=(control->>'entryId')::public.ulid;
   elsif jsonb_typeof(control->'entryId')<>'null' then raise invalid_parameter_value;end if;
  exception when others then return json_build_object('v',1,'state','changed');end;
  select * into saved from private.customer_khata_actions a where a.link_id=cap.id and a.id=source_id;
  if found then
   if saved.intent_json<>source_json then return json_build_object('v',1,'state','changed');end if;return saved.outcome;
  end if;
  if operation='inspect' then return json_build_object('v',1,'state','pending','intent',input,'at',null);end if;
  if (select count(*) from private.customer_khata_actions a where a.link_id=cap.id)>=200 then return json_build_object('v',1,'state','limited','retryAfter',60);end if;
  if operation='close' then
   result:=json_build_object('v',1,'state','closed','intent',input,'at',at_ms);
   insert into private.customer_khata_actions values(cap.id,source_id,source_json,result);return result;
  end if;
 end if;
 if cap.revoked_at is not null or cap.expires_at<=at_ms then return json_build_object('v',1,'state','missing');end if;
 select a.customer_id into target_customer from public.credit_accounts a where a.business_id=cap.business_id and a.outlet_id=cap.outlet_id and a.id=cap.account_id;
 if not found then return json_build_object('v',1,'state','missing');end if;
 if operation='submit' then
  if (control->>'at')::numeric>at_ms+30000 or kind='question' and not exists(select 1 from public.credit_entries e where e.business_id=cap.business_id and e.outlet_id=cap.outlet_id and e.account_id=cap.account_id and e.customer_id=target_customer and e.id=entry_id) then return json_build_object('v',1,'state','changed');end if;
  begin
   insert into public.tasks(id,business_id,outlet_id,kind,title,body,actions,assignee,status,due_at,created_at,updated_at)
   values(task_id,cap.business_id,cap.outlet_id,'question',to_json(case when kind='more-time' then 'Khata: asks for more time' else 'Khata: question about an entry' end)::public.literal_text,message_json::public.literal_text,
    json_build_array(json_build_object('kind','open-customer','customerId',target_customer,'accountId',cap.account_id,'entryId',entry_id))::public.record_array,'owner','open',null,at_ms,at_ms) returning * into task_row;
   insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,customer_id)
    values(event_id,cap.business_id,cap.outlet_id,'system','customer-link:'||cap.id,'customer.khata.'||kind,'null'::json,json_build_object('taskId',task_id,'accountId',cap.account_id,'entryId',entry_id,'message',message_json),at_ms,target_customer);
   if cap.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then raise sqlstate 'PT401';end if;
   result:=json_build_object('v',1,'state','created','intent',input,'at',at_ms);insert into private.customer_khata_actions values(cap.id,source_id,source_json,result);return result;
  exception when sqlstate 'PT401' then return json_build_object('v',1,'state','missing');when unique_violation then return json_build_object('v',1,'state','changed');end;
 end if;
 select coalesce(sum(case when e.type='payment' then -e.amount when e.type in('charge','adjustment') then e.amount else 0 end),0) into balance
  from public.credit_entries e where e.business_id=cap.business_id and e.outlet_id=cap.outlet_id and e.account_id=cap.account_id and e.customer_id=target_customer;
 if balance not between -9007199254740991 and 9007199254740991 then return json_build_object('v',1,'state','unavailable');end if;
 with page as(select e.* from public.credit_entries e where e.business_id=cap.business_id and e.outlet_id=cap.outlet_id and e.account_id=cap.account_id and e.customer_id=target_customer and e.sequence>after_sequence order by e.sequence limit 50)
 select coalesce(json_agg(json_build_object('id',e.id,'sequence',e.sequence,'type',e.type,'amount',e.amount,
  'delta',case when e.type='payment' then -e.amount when e.type in('charge','adjustment') then e.amount else 0 end,
  'at',coalesce(e.occurred_at,e.created_at),'noteJson',e.note::text,'byJson',m.name::text,'methodJson',e.method_name::text,'orderNumberJson',case when o.id is null then null else to_json(o.number)::text end,'reversalOf',e.reversal_of) order by e.sequence),'[]'::json),max(e.sequence)
 into entries,next_sequence from page e left join public.members m on m.business_id=cap.business_id and m.id=e.created_by
 left join public.orders o on o.business_id=cap.business_id and o.outlet_id=cap.outlet_id and o.id=e.order_id and o.customer_id=target_customer;
 if not exists(select 1 from public.credit_entries e where e.business_id=cap.business_id and e.outlet_id=cap.outlet_id and e.account_id=cap.account_id and e.customer_id=target_customer and e.sequence>next_sequence) then next_sequence:=null;end if;
 select json_build_object('v',1,'state','view','serverAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,'linkId',cap.id,'accountId',a.id,
  'shopNameJson',b.name::text,'outletNameJson',s.name::text,'customerNameJson',c.name::text,'marketCode',b.market_code,'currency',a.currency,'timeZone',s.timezone,
  'balance',balance,'settingsRevision',coalesce(settings.revision,0),'wallets',case when a.currency=s.currency then coalesce(settings.wallets,'[]'::jsonb) else '[]'::jsonb end,'entries',entries,'next',next_sequence)
 into result from public.credit_accounts a join public.customers c on c.business_id=a.business_id and c.id=a.customer_id
 join public.outlets s on s.business_id=a.business_id and s.id=a.outlet_id join public.businesses b on b.id=a.business_id
 left join private.outlet_checkout_settings settings on settings.business_id=a.business_id and settings.outlet_id=a.outlet_id
 where a.business_id=cap.business_id and a.outlet_id=cap.outlet_id and a.id=cap.account_id;
 if cap.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then return json_build_object('v',1,'state','missing');end if;
 return result;
end $$;
revoke all on function private.visit_customer_khata(text,text,text,bigint,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.visit_customer_khata(text,text,text,bigint,integer,integer) to service_role;
create function public.visit_customer_khata(p_token text,p_operation text,p_intent_json text,p_after_sequence bigint,p_global_limit integer,p_link_limit integer) returns json
language sql security invoker set search_path='' as $$select private.visit_customer_khata(p_token,p_operation,p_intent_json,p_after_sequence,p_global_limit,p_link_limit)$$;
revoke all on function public.visit_customer_khata(text,text,text,bigint,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.visit_customer_khata(text,text,text,bigint,integer,integer) to service_role;
