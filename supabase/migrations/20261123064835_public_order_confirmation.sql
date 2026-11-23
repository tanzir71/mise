-- Installation-owned public payment targets and explicitly granted order credit.
-- Customer phones never establish authority over an account. Only a tracker
-- created by an approved public-order admission may confirm that same order.
create table private.checkout_policy_actions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 source jsonb not null,receipt jsonb not null,previous jsonb,at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references public.members(business_id,id)
);
create index checkout_policy_actions_outlet on private.checkout_policy_actions(business_id,outlet_id,id);
create index checkout_policy_actions_actor on private.checkout_policy_actions(business_id,actor_id);
create table private.outlet_checkout_settings (
 outlet_id public.ulid primary key,business_id public.ulid not null,revision bigint not null check(revision between 1 and 9007199254740991),
 wallets jsonb not null check(jsonb_typeof(wallets)='array' and jsonb_array_length(wallets)<=8),
 action_id public.ulid not null references private.checkout_policy_actions(id),updated_at public.utc_ms not null,
 foreign key(business_id,outlet_id) references public.outlets(business_id,id) on delete cascade
);
create index outlet_checkout_settings_scope on private.outlet_checkout_settings(business_id,outlet_id);
create index outlet_checkout_settings_action on private.outlet_checkout_settings(action_id);
create table private.order_credit_permissions (
 order_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 revision bigint not null check(revision between 1 and 9007199254740991),order_revision bigint not null check(order_revision between 1 and 9007199254740991),
 customer_id public.ulid,account_id public.ulid,enabled boolean not null,maximum bigint not null check(maximum between 0 and 9007199254740991),
 actor_id public.ulid not null,action_id public.ulid not null references private.checkout_policy_actions(id),updated_at public.utc_ms not null,
 foreign key(business_id,outlet_id,order_id) references public.orders(business_id,outlet_id,id) on delete cascade,
 foreign key(business_id,customer_id) references public.customers(business_id,id),
 foreign key(business_id,outlet_id,account_id) references public.credit_accounts(business_id,outlet_id,id),
 foreign key(business_id,actor_id) references public.members(business_id,id),
 check(not enabled or customer_id is not null and account_id is not null)
);
create index order_credit_permissions_scope on private.order_credit_permissions(business_id,outlet_id,order_id);
create index order_credit_permissions_customer on private.order_credit_permissions(business_id,customer_id);
create index order_credit_permissions_account on private.order_credit_permissions(business_id,outlet_id,account_id);
create index order_credit_permissions_actor on private.order_credit_permissions(business_id,actor_id);
create index order_credit_permissions_action on private.order_credit_permissions(action_id);
create table private.order_confirmation_actions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,order_id public.ulid not null,link_id public.ulid not null references private.public_links(id),
 intent_json text not null check(octet_length(intent_json)<=65536),state text not null check(state in ('pending','closed','applied')),
 ticket_hash bytea check(ticket_hash is null or octet_length(ticket_hash)=32),prepared_at public.utc_ms,expires_at public.utc_ms,
 context_json text,snapshot_hash bytea check(snapshot_hash is null or octet_length(snapshot_hash)=32),receipt jsonb,created_at public.utc_ms not null,closed_at public.utc_ms,
 foreign key(business_id,outlet_id,order_id) references public.orders(business_id,outlet_id,id) on delete cascade,
 check((state='applied')=(receipt is not null)),check((state='closed')=(closed_at is not null))
);
create index order_confirmation_actions_order on private.order_confirmation_actions(business_id,outlet_id,order_id,id);
create index order_confirmation_actions_link on private.order_confirmation_actions(link_id,id);
create table private.order_confirmation_budget(id boolean primary key default true check(id),window_at bigint not null,requests integer not null check(requests between 0 and 60000));
insert into private.order_confirmation_budget values(true,0,0);
alter table private.public_links add column confirmation_window bigint not null default 0,add column confirmation_count integer not null default 0 check(confirmation_count between 0 and 60000);
alter table private.checkout_policy_actions enable row level security;alter table private.checkout_policy_actions force row level security;
alter table private.outlet_checkout_settings enable row level security;alter table private.outlet_checkout_settings force row level security;
alter table private.order_credit_permissions enable row level security;alter table private.order_credit_permissions force row level security;
alter table private.order_confirmation_actions enable row level security;alter table private.order_confirmation_actions force row level security;
alter table private.order_confirmation_budget enable row level security;alter table private.order_confirmation_budget force row level security;
revoke all on private.checkout_policy_actions,private.outlet_checkout_settings,private.order_credit_permissions,private.order_confirmation_actions,private.order_confirmation_budget from public,anon,authenticated,service_role;

create function private.checkout_wallets_valid(wallets jsonb,market text) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare w jsonb;names text[];
begin
 names:=case market when 'BD' then array['bKash','Nagad'] when 'ID' then array['GoPay','OVO','DANA'] when 'IN' then array['UPI'] when 'KE' then array['M-Pesa'] when 'ALL' then array['bKash','Nagad','GoPay','OVO','DANA','UPI','M-Pesa'] else array[]::text[] end;
 if wallets is null or jsonb_typeof(wallets)<>'array' or jsonb_array_length(wallets)>8 then return false;end if;
 if (select count(distinct ww->>'id') from jsonb_array_elements(wallets) ww)<>jsonb_array_length(wallets)
  or (select count(distinct ww->>'name') from jsonb_array_elements(wallets) ww)<>jsonb_array_length(wallets) then return false;end if;
 for w in select * from jsonb_array_elements(wallets) loop
  if jsonb_typeof(w)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(w) k) is distinct from array['id','name','phone','url']::text[]
   or jsonb_typeof(w->'id')<>'string' or w->>'id'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or jsonb_typeof(w->'name')<>'string' or not(w->>'name'=any(names))
   or jsonb_typeof(w->'phone')<>'string' or w->>'phone'!~'^\+[1-9][0-9]{6,14}$' or jsonb_typeof(w->'url')<>'string' or length(w->>'url') not between 1 and 2048
   or w->>'url'~'[[:space:][:cntrl:]]' or not(w->>'url'~'^https://[^/@?#]+([/?#]|$)' or w->>'name'='bKash' and w->>'url'~'^bkash://' or w->>'name'='Nagad' and w->>'url'~'^nagad://')
   or w->>'url'~'^[a-z]+://[^/?#]*@' then return false;end if;
 end loop;
 return true;
end $$;
revoke all on function private.checkout_wallets_valid(jsonb,text) from public,anon,authenticated,service_role;

create function private.checkout_owner_context(outlet public.ulid,order_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.ulid;business public.ulid;role_name text;market text;s private.outlet_checkout_settings;o public.orders;
 a public.credit_accounts;c public.customers;g private.order_credit_permissions;balance numeric;order_data jsonb;
begin
 actor:=private.public_shop_actor(outlet);
 select m.business_id,m.role,b.market_code into business,role_name,market from public.members m join public.businesses b on b.id=m.business_id where m.id=actor;
 select * into s from private.outlet_checkout_settings x where x.business_id=business and x.outlet_id=outlet;
 if order_id is not null then
  select * into o from public.orders x where x.business_id=business and x.outlet_id=outlet and x.id=order_id;
  if not found then raise insufficient_privilege using message='Choose the current order in this outlet.';end if;
  select * into c from public.customers x where x.business_id=business and x.id=o.customer_id and (role_name='owner' or exists(select 1 from public.customer_outlets co where co.business_id=business and co.outlet_id=outlet and co.customer_id=x.id));
  select * into a from public.credit_accounts x where x.business_id=business and x.outlet_id=outlet and x.customer_id=c.id and x.currency=o.currency;
  select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0) into balance
   from public.credit_entries e where e.business_id=business and e.outlet_id=outlet and e.account_id=a.id;
  select * into g from private.order_credit_permissions x where x.business_id=business and x.outlet_id=outlet and x.order_id=o.id;
  order_data:=jsonb_build_object('id',o.id,'revision',o.revision,'status',o.status,'currency',o.currency,'customerId',o.customer_id,
   'customerNameJson',coalesce(c.name,o.customer_name)::text,'ledger',case when a.id is null then null else jsonb_build_object('allowed',a.allowed and c.archived_at is null,'currency',a.currency,'balance',balance,'limit',a.credit_limit) end,
   'credit',jsonb_build_object('revision',coalesce(g.revision,0),'enabled',coalesce(g.enabled,false),'maximum',coalesce(g.maximum,0),'orderRevision',g.order_revision));
 end if;
 return jsonb_build_object('v',1,'serverAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,'businessId',business,'outletId',outlet,'orderId',order_id,'actorId',actor,'actorRole',role_name,'marketCode',market,
  'settings',jsonb_build_object('revision',coalesce(s.revision,0),'wallets',coalesce(s.wallets,'[]'::jsonb)),'order',order_data);
end $$;
revoke all on function private.checkout_owner_context(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.checkout_owner_context(public.ulid,public.ulid) to authenticated;
create function public.read_checkout_policy(p_outlet_id public.ulid,p_order_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$ select private.checkout_owner_context(p_outlet_id,p_order_id) $$;
revoke all on function public.read_checkout_policy(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.read_checkout_policy(public.ulid,public.ulid) to authenticated;

create function private.change_checkout_policy(outlet public.ulid,action jsonb,operation text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;market text;action_id public.ulid;kind text;rev bigint;target_order public.ulid;expected_order bigint;
 a private.checkout_policy_actions;s private.outlet_checkout_settings;g private.order_credit_permissions;o public.orders;account public.credit_accounts;
 previous jsonb;result jsonb;value jsonb;stamp public.utc_ms;maximum bigint;enabled boolean;
begin
 if action is null or jsonb_typeof(action)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(action) k) is distinct from array['enabled','id','kind','maximum','orderId','orderRevision','revision','v','wallets']::text[]
  or action->'v'<>'1'::jsonb or jsonb_typeof(action->'id')<>'string' or action->>'id'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
  or jsonb_typeof(action->'kind')<>'string' or action->>'kind' not in ('wallets','credit') or jsonb_typeof(action->'revision')<>'number' or action->>'revision'!~'^[0-9]{1,16}$'
  or (action->>'revision')::numeric>9007199254740990 or operation is null or operation not in ('submit','inspect','close') then raise invalid_parameter_value using message='Keep the complete original checkout setting.';end if;
 actor:=private.public_shop_actor(outlet);perform 1 from public.members m where m.id=actor for share;
 select x.business_id,b.market_code into business,market from public.outlets x join public.businesses b on b.id=x.business_id where x.id=outlet for update of x;
 actor:=private.public_shop_actor(outlet);
 action_id:=(action->>'id')::public.ulid;kind:=action->>'kind';rev:=(action->>'revision')::bigint;stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 select * into a from private.checkout_policy_actions x where x.id=action_id;
 if found then
  if a.business_id<>business or a.outlet_id<>outlet or a.actor_id<>actor then raise insufficient_privilege using message='Use the original checkout account.';end if;
  if a.source<>action then raise unique_violation using message='Keep the exact original checkout setting.';end if;
  return a.receipt;
 end if;
 if kind='wallets' then
  if action->'orderId'<>'null'::jsonb or action->'orderRevision'<>'null'::jsonb or action->'enabled'<>'null'::jsonb or action->'maximum'<>'null'::jsonb or not private.checkout_wallets_valid(action->'wallets',case when operation='submit' then market else 'ALL' end) then raise invalid_parameter_value using message='Use supported, explicitly public wallet targets.';end if;
 else
  if jsonb_typeof(action->'orderId')<>'string' or action->>'orderId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or jsonb_typeof(action->'orderRevision')<>'number' or action->>'orderRevision'!~'^[0-9]{1,16}$'
   or (action->>'orderRevision')::numeric not between 1 and 9007199254740991 or jsonb_typeof(action->'enabled')<>'boolean' or action->'wallets'<>'null'::jsonb
   or jsonb_typeof(action->'maximum')<>'number' or action->>'maximum'!~'^[0-9]{1,16}$' or (action->>'maximum')::numeric>9007199254740991 then raise invalid_parameter_value using message='Review this exact order and credit permission.';end if;
  target_order:=(action->>'orderId')::public.ulid;expected_order:=(action->>'orderRevision')::bigint;maximum:=(action->>'maximum')::bigint;enabled:=(action->>'enabled')::boolean;
  perform 1 from public.orders x where x.business_id=business and x.outlet_id=outlet and x.id=target_order;
  if not found then raise insufficient_privilege using message='Choose the current order in this outlet.';end if;
 end if;
 if operation='inspect' then return jsonb_build_object('v',1,'action',action,'state','pending','at',null,'value',null);end if;
 if operation='close' then
  result:=jsonb_build_object('v',1,'action',action,'state','closed','at',stamp,'value',null);
  insert into private.checkout_policy_actions values(action_id,business,outlet,actor,action,result,null,stamp);return result;
 end if;
 if kind='wallets' then
  select * into s from private.outlet_checkout_settings x where x.business_id=business and x.outlet_id=outlet;
  if coalesce(s.revision,0)<>rev then raise sqlstate 'PT409' using message='Refresh the current public wallet targets.';end if;
  previous:=jsonb_build_object('revision',coalesce(s.revision,0),'wallets',coalesce(s.wallets,'[]'::jsonb));
  value:=jsonb_build_object('revision',rev+1,'wallets',action->'wallets');
 else
  select * into o from public.orders x where x.business_id=business and x.outlet_id=outlet and x.id=target_order for update;
  select * into g from private.order_credit_permissions x where x.business_id=business and x.outlet_id=outlet and x.order_id=target_order;
  if coalesce(g.revision,0)<>rev or o.revision<>expected_order then raise sqlstate 'PT409' using message='Review the current order and khata permission.';end if;
  select * into account from public.credit_accounts x where x.business_id=business and x.outlet_id=outlet and x.customer_id=o.customer_id and x.currency=o.currency;
  if enabled and (o.business_type<>'corner_shop' or o.status not in ('requested','priced') or o.payment::jsonb->>'status'<>'pending'
   or account.id is null or not account.allowed or account.currency<>(select x.currency from public.outlets x where x.id=outlet)
   or not exists(select 1 from public.customers c where c.id=o.customer_id and c.business_id=business and c.archived_at is null and (exists(select 1 from public.members m where m.id=actor and m.role='owner') or exists(select 1 from public.customer_outlets co where co.business_id=business and co.outlet_id=outlet and co.customer_id=c.id)))) then raise sqlstate 'PT409' using message='Choose this order’s active customer and current-currency khata.';end if;
  previous:=jsonb_build_object('revision',coalesce(g.revision,0),'enabled',coalesce(g.enabled,false),'maximum',coalesce(g.maximum,0),'orderRevision',g.order_revision);
  value:=jsonb_build_object('revision',rev+1,'enabled',enabled,'maximum',maximum,'orderRevision',expected_order);
 end if;
 result:=jsonb_build_object('v',1,'action',action,'state','applied','at',stamp,'value',value);
 insert into private.checkout_policy_actions values(action_id,business,outlet,actor,action,result,previous,stamp);
 if kind='wallets' then
  insert into private.outlet_checkout_settings values(outlet,business,rev+1,action->'wallets',action_id,stamp)
   on conflict(outlet_id) do update set revision=excluded.revision,wallets=excluded.wallets,action_id=excluded.action_id,updated_at=excluded.updated_at;
 else
  insert into private.order_credit_permissions values(target_order,business,outlet,rev+1,expected_order,o.customer_id,account.id,enabled,maximum,actor,action_id,stamp)
   on conflict on constraint order_credit_permissions_pkey do update set revision=excluded.revision,order_revision=excluded.order_revision,customer_id=excluded.customer_id,account_id=excluded.account_id,
    enabled=excluded.enabled,maximum=excluded.maximum,actor_id=excluded.actor_id,action_id=excluded.action_id,updated_at=excluded.updated_at;
 end if;
 return result;
end $$;
revoke all on function private.change_checkout_policy(public.ulid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function private.change_checkout_policy(public.ulid,jsonb,text) to authenticated;
create function public.change_checkout_policy(p_outlet_id public.ulid,p_action jsonb,p_operation text) returns jsonb
language sql security invoker set search_path='' as $$ select private.change_checkout_policy(p_outlet_id,p_action,p_operation) $$;
revoke all on function public.change_checkout_policy(public.ulid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.change_checkout_policy(public.ulid,jsonb,text) to authenticated;

-- PostgreSQL's JSON inspection routines can decode an unrelated escaped NUL
-- or lone surrogate even when reading a numeric sibling. Split already-valid
-- JSON at structural ASCII bytes, preserving literal scalar source bytes. A
-- byte cursor also avoids quadratic UTF-8 substring scans on large notes.
create function private.confirmation_json_fields(input json) returns table(key text,value json)
language plpgsql immutable security invoker set search_path='' as $$
declare body bytea;pos integer:=0;n integer;root integer;code integer;start_at integer;end_at integer;key_start integer;key_end integer;ordinal integer:=0;depth integer;quoted boolean;escaped boolean;
begin
 if input is null then return;end if;
 body:=convert_to(input::text,'UTF8');n:=octet_length(body);
 while pos<n and get_byte(body,pos) in(9,10,13,32) loop pos:=pos+1;end loop;
 if pos>=n then return;end if;root:=get_byte(body,pos);if root not in(91,123) then return;end if;pos:=pos+1;
 loop
  while pos<n and get_byte(body,pos) in(9,10,13,32) loop pos:=pos+1;end loop;
  if pos>=n or get_byte(body,pos) in(93,125) then exit;end if;
  if root=123 then
   key_start:=pos;pos:=pos+1;escaped:=false;
   while pos<n loop
    code:=get_byte(body,pos);
    if escaped then escaped:=false;elsif code=92 then escaped:=true;elsif code=34 then exit;end if;
    pos:=pos+1;
   end loop;
   key_end:=pos;key:=(convert_from(substring(body from key_start+1 for key_end-key_start+1),'UTF8')::json)#>>'{}';pos:=pos+1;
   while pos<n and get_byte(body,pos) in(9,10,13,32) loop pos:=pos+1;end loop;
   pos:=pos+1;
  else key:=ordinal::text;end if;
  while pos<n and get_byte(body,pos) in(9,10,13,32) loop pos:=pos+1;end loop;
  start_at:=pos;depth:=0;quoted:=false;escaped:=false;
  while pos<n loop
   code:=get_byte(body,pos);
   if quoted then
    if escaped then escaped:=false;elsif code=92 then escaped:=true;elsif code=34 then quoted:=false;end if;
   elsif code=34 then quoted:=true;
   elsif code in(91,123) then depth:=depth+1;
   elsif code in(93,125) then if depth=0 then exit;end if;depth:=depth-1;
   elsif code=44 and depth=0 then exit;
   end if;
   pos:=pos+1;
  end loop;
  end_at:=pos;while end_at>start_at and get_byte(body,end_at-1) in(9,10,13,32) loop end_at:=end_at-1;end loop;
  value:=convert_from(substring(body from start_at+1 for end_at-start_at),'UTF8')::json;return next;ordinal:=ordinal+1;
  if pos>=n or get_byte(body,pos) in(93,125) then exit;end if;pos:=pos+1;
 end loop;
end $$;
revoke all on function private.confirmation_json_fields(json) from public,anon,authenticated,service_role;
create function private.confirmation_json_field(input json,field text) returns json
language sql immutable security invoker set search_path='' as $$ select f.value from private.confirmation_json_fields(input) f where f.key=field $$;
revoke all on function private.confirmation_json_field(json,text) from public,anon,authenticated,service_role;
create function private.confirmation_json_text(input json,field text) returns text
language sql immutable security invoker set search_path='' as $$ select private.confirmation_json_field(input,field)#>>'{}' $$;
revoke all on function private.confirmation_json_text(json,text) from public,anon,authenticated,service_role;
create function private.confirmation_json_elements(input json) returns setof json
language sql immutable security invoker set search_path='' as $$ select f.value from private.confirmation_json_fields(input) f order by f.key::integer $$;
revoke all on function private.confirmation_json_elements(json) from public,anon,authenticated,service_role;
create function private.confirmation_strip_nulls(input json) returns json
language sql immutable security invoker set search_path='' as $$ select coalesce(json_object_agg(f.key,f.value),'{}'::json) from private.confirmation_json_fields(input) f where f.value::text<>'null' $$;
revoke all on function private.confirmation_strip_nulls(json) from public,anon,authenticated,service_role;

create function private.order_checkout_quote(cap private.public_links) returns json
language plpgsql stable security invoker set search_path='' as $$
declare o public.orders;s private.outlet_checkout_settings;g private.order_credit_permissions;a public.credit_accounts;c public.customers;credit json;balance numeric;
begin
 if cap.kind<>'order' or cap.revoked_at is not null or cap.expires_at<=floor(extract(epoch from statement_timestamp())*1000)::bigint then return null;end if;
 select * into o from public.orders x where x.business_id=cap.business_id and x.outlet_id=cap.outlet_id and x.id=cap.order_id;
 if not found or o.business_type<>'corner_shop' or o.status not in ('requested','priced') or o.payment::jsonb->>'status'<>'pending' or o.payment::jsonb->>'saleId' is not null
  or not exists(select 1 from private.public_order_attempts p where p.business_id=cap.business_id and p.outlet_id=cap.outlet_id and p.tracking_hash=cap.token_hash and p.state='created' and p.receipt->>'orderId'=o.id and p.receipt->>'linkId'=cap.id)
  or not exists(select 1 from public.members m where m.business_id=cap.business_id and m.id=cap.issued_by and m.active and
   (m.role='owner' or m.role='manager' and exists(select 1 from public.member_outlets mo where mo.business_id=m.business_id and mo.member_id=m.id and mo.outlet_id=cap.outlet_id)))
  or exists(select 1 from private.confirmation_json_elements(o.lines) l where private.confirmation_json_text(l,'unavailable')='false' and private.confirmation_json_text(l,'unitPrice') is null) then return null;end if;
 select * into s from private.outlet_checkout_settings x where x.business_id=o.business_id and x.outlet_id=o.outlet_id;
 select * into g from private.order_credit_permissions x where x.business_id=o.business_id and x.outlet_id=o.outlet_id and x.order_id=o.id;
 if g.enabled and g.order_revision=o.revision and g.customer_id=o.customer_id
  and exists(select 1 from public.members m where m.business_id=o.business_id and m.id=g.actor_id and m.active and
   (m.role='owner' or m.role='manager' and exists(select 1 from public.member_outlets mo where mo.business_id=m.business_id and mo.member_id=m.id and mo.outlet_id=o.outlet_id))) then
  select * into c from public.customers x where x.business_id=o.business_id and x.id=o.customer_id and x.archived_at is null;
  select * into a from public.credit_accounts x where x.business_id=o.business_id and x.outlet_id=o.outlet_id and x.id=g.account_id and x.customer_id=o.customer_id and x.currency=o.currency and x.allowed
   and x.currency=(select y.currency from public.outlets y where y.id=o.outlet_id and y.business_id=o.business_id);
  if c.id is not null and a.id is not null then
   select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0) into balance
    from public.credit_entries e where e.business_id=o.business_id and e.outlet_id=o.outlet_id and e.account_id=a.id;
   credit:=json_build_object('revision',g.revision,'balance',balance,'limit',a.credit_limit,'maximum',g.maximum);
  end if;
 end if;
 return json_build_object('v',1,'orderId',o.id,'revision',o.revision,'status',o.status,'number',o.number,'currency',o.currency,
  'lines',o.lines,'deliveryFee',o.delivery_fee,'discount',o.discount,'settingsRevision',coalesce(s.revision,0),'wallets',case when private.checkout_wallets_valid(s.wallets,(select b.market_code from public.businesses b where b.id=o.business_id)) then s.wallets else '[]'::jsonb end,'credit',credit);
end $$;
revoke all on function private.order_checkout_quote(private.public_links) from public,anon,authenticated,service_role;

create function private.order_confirmation_context(cap private.public_links) returns json
language sql stable security invoker set search_path='' as $$
 select json_build_object('quoteJson',private.order_checkout_quote(cap)::text,
  'business',(select row_to_json(b) from public.businesses b where b.id=cap.business_id),
  'outlet',(select row_to_json(o) from public.outlets o where o.business_id=cap.business_id and o.id=cap.outlet_id),
  'actor',(select row_to_json(m) from public.members m where m.business_id=cap.business_id and m.id=cap.issued_by),
  'order',(select row_to_json(o) from public.orders o where o.business_id=cap.business_id and o.outlet_id=cap.outlet_id and o.id=cap.order_id),
  'customer',(select row_to_json(c) from public.customers c join public.orders o on o.customer_id=c.id and o.business_id=c.business_id where o.id=cap.order_id and o.business_id=cap.business_id and o.outlet_id=cap.outlet_id),
  'account',(select row_to_json(a) from public.credit_accounts a join private.order_credit_permissions g on g.account_id=a.id and g.customer_id=a.customer_id and g.business_id=a.business_id and g.outlet_id=a.outlet_id
   where g.order_id=cap.order_id and g.business_id=cap.business_id and g.outlet_id=cap.outlet_id and g.enabled),
  'entries',(select coalesce(json_agg(row_to_json(e) order by e.sequence),'[]') from public.credit_entries e join private.order_credit_permissions g on g.account_id=e.account_id and g.customer_id=e.customer_id and g.business_id=e.business_id and g.outlet_id=e.outlet_id
   where g.order_id=cap.order_id and g.business_id=cap.business_id and g.outlet_id=cap.outlet_id and g.enabled))
$$;
revoke all on function private.order_confirmation_context(private.public_links) from public,anon,authenticated,service_role;

create function private.order_confirmation_result(a private.order_confirmation_actions) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('v',1,'id',a.id,'intentJson',a.intent_json,'state',a.state,'closedAt',a.closed_at,'receipt',a.receipt,
  'quoteJson',case when a.context_json is null then null else private.confirmation_json_text(a.context_json::json,'quoteJson') end)
$$;
revoke all on function private.order_confirmation_result(private.order_confirmation_actions) from public,anon,authenticated,service_role;

create function private.prepare_order_confirmation(secret text,intent_json text,operation text,global_limit integer,link_limit integer) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare cap private.public_links;a private.order_confirmation_actions;budget private.order_confirmation_budget;source jsonb;stamp public.utc_ms;window_ms bigint;retry_seconds integer;
 action_id public.ulid;ticket text;context json;quote json;digest text;payment_order public.orders;payment_settings private.outlet_checkout_settings;payment_wallet jsonb;
begin
 if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' or operation is null or operation not in ('quote','submit','inspect','close','payment')
  or global_limit is null or global_limit not between 1 and 60000 or link_limit is null or link_limit not between 1 and 60000 then raise invalid_parameter_value using message='Use the scoped customer confirmation endpoint.';end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;window_ms:=stamp/60000*60000;retry_seconds:=greatest(1,ceil((window_ms+60000-stamp)/1000.0)::integer);
 select * into strict budget from private.order_confirmation_budget where id for update;
 if budget.window_at=window_ms and budget.requests>=global_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',retry_seconds);end if;
 update private.order_confirmation_budget set window_at=window_ms,requests=case when window_at=window_ms then requests+1 else 1 end where id;
 select * into cap from private.public_links c where c.kind='order' and c.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found or cap.revoked_at is not null or cap.expires_at<=stamp then return jsonb_build_object('v',1,'state','missing');end if;
 perform 1 from public.businesses b where b.id=cap.business_id for share;
 perform 1 from public.outlets o where o.id=cap.outlet_id and o.business_id=cap.business_id for update;
 select * into cap from private.public_links c where c.id=cap.id for update;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if cap.revoked_at is not null or cap.expires_at<=stamp then return jsonb_build_object('v',1,'state','missing');end if;
 if cap.confirmation_window=window_ms and cap.confirmation_count>=link_limit then return jsonb_build_object('v',1,'state','limited','retryAfter',retry_seconds);end if;
 update private.public_links set confirmation_window=window_ms,confirmation_count=case when confirmation_window=window_ms then confirmation_count+1 else 1 end where id=cap.id;
 if operation='quote' then
  if intent_json is not null then raise invalid_parameter_value using message='A quote needs only its order link.';end if;
  quote:=private.order_checkout_quote(cap);
  if quote is null then return jsonb_build_object('v',1,'state','unavailable');end if;
  return jsonb_build_object('v',1,'state','quote','quoteJson',quote::text,'quoteHash',encode(sha256(convert_to(quote::text,'UTF8')),'hex'));
 end if;
 if intent_json is null or octet_length(intent_json)>65536 then raise invalid_parameter_value using message='Keep the original confirmation.';end if;
 source:=intent_json::jsonb;
 if jsonb_typeof(source)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(source) k) is distinct from array['id','ids','payment','quoteHash','swaps','v']::text[]
  or source->'v'<>'1'::jsonb or jsonb_typeof(source->'id')<>'string' or source->>'id'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
  or jsonb_typeof(source->'quoteHash')<>'string' or source->>'quoteHash'!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Keep the original confirmation and quote.';end if;
 action_id:=(source->>'id')::public.ulid;
 perform pg_advisory_xact_lock(hashtextextended('order-confirmation:'||action_id::text,0));
 select * into a from private.order_confirmation_actions x where x.id=action_id for update;
 if found then
  if a.link_id<>cap.id or a.business_id<>cap.business_id or a.outlet_id<>cap.outlet_id or a.order_id<>cap.order_id then return jsonb_build_object('v',1,'state','missing');end if;
  if a.intent_json<>intent_json then return jsonb_build_object('v',1,'state','changed');end if;
  if operation='payment' then
   select * into payment_order from public.orders x where x.id=cap.order_id and x.business_id=cap.business_id and x.outlet_id=cap.outlet_id;
   select * into payment_settings from private.outlet_checkout_settings x where x.business_id=cap.business_id and x.outlet_id=cap.outlet_id;
   if a.state<>'applied' or source->'payment'->>'method'<>'wallet' or payment_order.status in ('requested','priced','cancelled','done')
    or payment_order.payment::jsonb->>'status'<>'pending' or payment_order.payment::jsonb->>'method'<>'wallet'
    or not private.checkout_wallets_valid(payment_settings.wallets,(select b.market_code from public.businesses b where b.id=cap.business_id))
    or not exists(select 1 from public.members m where m.id=cap.issued_by and m.business_id=cap.business_id and m.active and (m.role='owner' or m.role='manager' and exists(select 1 from public.member_outlets mo where mo.business_id=m.business_id and mo.member_id=m.id and mo.outlet_id=cap.outlet_id)))
    then return jsonb_build_object('v',1,'state','unavailable');end if;
   select w into payment_wallet from jsonb_array_elements(payment_settings.wallets) w where w->>'id'=source->'payment'->>'walletId' and w->>'name'=payment_order.payment::jsonb->>'wallet';
   if payment_wallet is null then return jsonb_build_object('v',1,'state','unavailable');end if;
   return jsonb_build_object('v',1,'state','payment','id',a.id,'orderId',payment_order.id,'settingsRevision',payment_settings.revision,'wallet',payment_wallet);
  end if;
  if a.state<>'pending' or operation='inspect' then return private.order_confirmation_result(a);end if;
 elsif operation='payment' then return jsonb_build_object('v',1,'state','unavailable');
 elsif operation='inspect' then return jsonb_build_object('v',1,'id',action_id,'intentJson',intent_json,'state','pending','closedAt',null,'receipt',null,'quoteJson',null);
 else
  -- Even closure cannot repurpose an old read-only tracker as a customer write.
  if not exists(select 1 from private.public_order_attempts p where p.business_id=cap.business_id and p.outlet_id=cap.outlet_id and p.tracking_hash=cap.token_hash and p.state='created' and p.receipt->>'orderId'=cap.order_id and p.receipt->>'linkId'=cap.id) then return jsonb_build_object('v',1,'state','unavailable');end if;
  insert into private.order_confirmation_actions(id,business_id,outlet_id,order_id,link_id,intent_json,state,created_at)
   values(action_id,cap.business_id,cap.outlet_id,cap.order_id,cap.id,intent_json,'pending',stamp) returning * into a;
 end if;
 if operation='close' then
  update private.order_confirmation_actions set state='closed',closed_at=stamp,ticket_hash=null,expires_at=null where id=a.id returning * into a;
  return private.order_confirmation_result(a);
 end if;
 context:=private.order_confirmation_context(cap);quote:=private.confirmation_json_text(context,'quoteJson')::json;
 if quote is null then return jsonb_build_object('v',1,'state','unavailable');end if;
 digest:=encode(sha256(convert_to(quote::text,'UTF8')),'hex');
 if digest<>source->>'quoteHash' then return jsonb_build_object('v',1,'state','changed');end if;
 ticket:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 update private.order_confirmation_actions set ticket_hash=sha256(convert_to(ticket,'UTF8')),prepared_at=stamp,expires_at=stamp+30000,
  context_json=context::text,snapshot_hash=sha256(convert_to(context::text,'UTF8')) where id=a.id;
 return jsonb_build_object('v',1,'state','prepared','id',a.id,'ticketToken',ticket,'businessId',cap.business_id,'outletId',cap.outlet_id,'actorId',cap.issued_by,'at',stamp,'contextJson',context::text);
end $$;
revoke all on function private.prepare_order_confirmation(text,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.prepare_order_confirmation(text,text,text,integer,integer) to service_role;
create function public.prepare_order_confirmation(p_token text,p_intent_json text,p_operation text,p_global_limit integer,p_link_limit integer) returns jsonb
language sql security invoker set search_path='' as $$ select private.prepare_order_confirmation(p_token,p_intent_json,p_operation,p_global_limit,p_link_limit) $$;
revoke all on function public.prepare_order_confirmation(text,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.prepare_order_confirmation(text,text,text,integer,integer) to service_role;

-- Compare canonical Core JSON images without coercing unrelated literal source
-- strings through jsonb (which cannot represent escaped NUL or lone surrogates).
create function private.confirmation_json_equal(l json,r json) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare item record;kind text;
begin
 if l is null or r is null then return l is null and r is null;end if;
 kind:=left(ltrim(l::text,E' \t\r\n'),1);if kind is distinct from left(ltrim(r::text,E' \t\r\n'),1) and not(kind~'[0-9-]' and left(ltrim(r::text,E' \t\r\n'),1)~'[0-9-]') then return false;end if;
 if kind in('{','[') then
  if (select count(*) from private.confirmation_json_fields(l))<>(select count(*) from private.confirmation_json_fields(r)) then return false;end if;
  for item in select lf.value as left_value,rf.value as right_value from private.confirmation_json_fields(l) lf full join private.confirmation_json_fields(r) rf on lf.key=rf.key loop
   if not private.confirmation_json_equal(item.left_value,item.right_value) then return false;end if;
  end loop;
  return true;
 elsif kind~'[0-9-]' then return l::text::numeric=r::text::numeric;
 else return btrim(l::text,E' \t\r\n')=btrim(r::text,E' \t\r\n');
 end if;
end $$;
revoke all on function private.confirmation_json_equal(json,json) from public,anon,authenticated,service_role;

create function private.confirmation_event_valid(v jsonb,business public.ulid,outlet public.ulid,order_id public.ulid,event_id text,command text,revision bigint,customer text,stamp public.utc_ms,before_image json,after_image json) returns boolean
language sql immutable security invoker set search_path='' as $$
 select v->>'id' is not distinct from event_id and v->>'business_id' is not distinct from business::text and v->>'outlet_id' is not distinct from outlet::text
  and v->>'actor_type'='system' and v->>'actor_id'='public-order-confirmation' and v->>'command' is not distinct from command
  and v->>'order_id' is not distinct from order_id::text and (v->>'order_revision')::bigint is not distinct from revision
  and v->>'customer_id' is not distinct from customer and (v->>'at')::bigint is not distinct from stamp
  and private.confirmation_json_equal((v->>'before_data')::json,before_image) and private.confirmation_json_equal((v->>'after_data')::json,after_image)
  and not exists(select 1 from unnest(array['undo_of','stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null)
$$;
revoke all on function private.confirmation_event_valid(jsonb,public.ulid,public.ulid,public.ulid,text,text,bigint,text,public.utc_ms,json,json) from public,anon,authenticated,service_role;

create function private.confirmation_money_image(table_name text,v jsonb) returns json
language sql immutable security invoker set search_path='' as $$
 select case when table_name='sales' then private.confirmation_strip_nulls(json_build_object('id',v->>'id','outletId',v->>'outlet_id','orderId',v->>'order_id','orderNumber',v->>'order_number',
  'expression',v->>'expression','amount',(v->>'amount')::bigint,'currency',v->>'currency','method',v->>'method','methodName',(v->>'method_name')::json,
  'who',(v->>'who')::json,'items',(v->>'items')::json,'shopName',(v->>'shop_name')::json,'shopLink',v->>'shop_link','timezone',v->>'timezone',
  'createdBy',v->>'created_by','eventId',v->>'event_id','createdAt',(v->>'created_at')::bigint,'updatedAt',(v->>'updated_at')::bigint,
  'customerId',v->>'customer_id','creditAccountId',v->>'credit_account_id','deliveryFee',(v->>'delivery_fee')::bigint,'discount',(v->>'discount')::bigint))
 else private.confirmation_strip_nulls(json_build_object('id',v->>'id','accountId',v->>'account_id','customerId',v->>'customer_id','outletId',v->>'outlet_id','currency',v->>'currency',
  'sequence',(v->>'sequence')::bigint,'type',v->>'type','amount',(v->>'amount')::bigint,'note',(v->>'note')::json,'saleId',v->>'sale_id','orderId',v->>'order_id',
  'createdBy',v->>'created_by','eventId',v->>'event_id','createdAt',(v->>'created_at')::bigint,'updatedAt',(v->>'updated_at')::bigint)) end
$$;
revoke all on function private.confirmation_money_image(text,jsonb) from public,anon,authenticated,service_role;

create function private.write_confirmation_record(table_name text,v jsonb,update_order boolean) returns void
language plpgsql security invoker set search_path='' as $$
declare allowed text[];columns text;casts text;updates text;
begin
 allowed:=case table_name
  when 'orders' then array['id','created_at','updated_at','outlet_id','created_by','event_id','revision','business_type','sequence','number','source','source_text','customer_id','customer_name','customer_phone','type','status','status_changed_at','status_event_id','lines','subtotal','delivery_fee','discount','total','currency','timezone','address','table_label','scheduled_for','payment','handled_by','business_id']
  when 'events' then array['id','outlet_id','actor_type','actor_id','command','before_data','after_data','at','undo_of','customer_id','order_id','order_revision','stock_item_id','stock_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision','business_id']
  when 'sales' then array['id','created_at','updated_at','outlet_id','created_by','event_id','voided_at','order_id','order_number','closing_id','delivery_fee','discount','expression','amount','currency','method','method_name','given','change','who','customer_id','credit_account_id','items','shop_name','shop_link','timezone','void_reason','business_id']
  when 'credit_entries' then array['id','created_at','updated_at','outlet_id','created_by','event_id','account_id','customer_id','currency','sequence','type','amount','note','sale_id','order_id','refund_id','returns_charge_id','method_name','occurred_at','reversal_of','purpose','over_limit','business_id'] else null end;
 if allowed is null or jsonb_typeof(v)<>'object' or not v ?& allowed or (select count(*) from jsonb_object_keys(v))<>array_length(allowed,1) or update_order is distinct from (table_name='orders') then raise invalid_parameter_value using message='Keep only complete prepared confirmation records.';end if;
 select string_agg(format('%I',k),',' order by k),string_agg(format('($1->>%L)::%s',k,format_type(a.atttypid,a.atttypmod)),',' order by k),
  string_agg(format('%I=($1->>%L)::%s',k,k,format_type(a.atttypid,a.atttypmod)),',' order by k) filter(where k<>'id')
  into columns,casts,updates from unnest(allowed) k join pg_attribute a on a.attrelid=to_regclass('public.'||table_name) and a.attname=k and a.attnum>0 and not a.attisdropped;
 if update_order then execute format('update public.orders set %s where id=$1->>''id''',updates) using v;
 else execute format('insert into public.%I(%s) select %s',table_name,columns,casts) using v;end if;
end $$;
revoke all on function private.write_confirmation_record(text,jsonb,boolean) from public,anon,authenticated,service_role;

create function private.finish_order_confirmation(action_id public.ulid,ticket text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare a private.order_confirmation_actions;cap private.public_links;current_order public.orders;next_order public.orders;previous_order public.orders;
 outlet_row public.outlets;business_row public.businesses;account public.credit_accounts;permission private.order_credit_permissions;
 source jsonb;ids jsonb;payment jsonb;decision jsonb;wallet jsonb;context json;quote json;l json;kept json[]:='{}';sale_items json[]:='{}';
 order_values jsonb;sale_values jsonb;entry_values jsonb;e jsonb;r jsonb;before_image json;after_image json;
 stamp public.utc_ms;subtotal numeric:=0;total numeric;balance numeric;sequence_value bigint;available_count integer:=0;proposal_count integer:=0;
 event_count integer;order_event_count integer;step integer;event_id text;event_command text;credit boolean;expected_credit boolean;order_count integer;sale_count integer;entry_count integer;
begin
 if action_id is null or ticket is null or ticket!~'^[A-Za-z0-9_-]{43}$' then return jsonb_build_object('v',1,'state','conflict');end if;
 select * into a from private.order_confirmation_actions x where x.id=action_id and x.ticket_hash=sha256(convert_to(ticket,'UTF8'));
 if not found then return jsonb_build_object('v',1,'state','conflict');end if;
 select * into business_row from public.businesses b where b.id=a.business_id for share;
 select * into outlet_row from public.outlets o where o.business_id=a.business_id and o.id=a.outlet_id for update;
 select * into cap from private.public_links c where c.id=a.link_id and c.business_id=a.business_id and c.outlet_id=a.outlet_id for update;
 perform pg_advisory_xact_lock(hashtextextended('order-confirmation:'||action_id::text,0));
 select * into a from private.order_confirmation_actions x where x.id=action_id and x.ticket_hash=sha256(convert_to(ticket,'UTF8')) for update;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if cap.id is null or cap.revoked_at is not null or cap.expires_at<=stamp then return jsonb_build_object('v',1,'state','missing');end if;
 if not found then return jsonb_build_object('v',1,'state','conflict');end if;
 if a.state='applied' then return private.order_confirmation_result(a);end if;
 if a.state<>'pending' or a.expires_at is null or a.expires_at<=stamp then return jsonb_build_object('v',1,'state','conflict');end if;
 perform 1 from public.members m where m.id=cap.issued_by and m.business_id=a.business_id and m.active for share;
 perform 1 from public.member_outlets m where m.member_id=cap.issued_by and m.business_id=a.business_id and m.outlet_id=a.outlet_id for share;
 context:=private.order_confirmation_context(cap);
 if private.confirmation_json_text(context,'quoteJson') is null or sha256(convert_to(context::text,'UTF8')) is distinct from a.snapshot_hash then return jsonb_build_object('v',1,'state','conflict');end if;
 select * into current_order from public.orders o where o.id=a.order_id and o.business_id=a.business_id and o.outlet_id=a.outlet_id for update;
 source:=a.intent_json::jsonb;ids:=source->'ids';payment:=source->'payment';quote:=private.confirmation_json_text(context,'quoteJson')::json;
 if jsonb_typeof(ids)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(ids) k) is distinct from array['acceptedEventId','creditEventId','entryId','paymentEventId','pricedEventId','saleEventId','saleId','updateEventId']::text[]
  or exists(select 1 from jsonb_each(ids) v where jsonb_typeof(v.value)<>'string' or v.value#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
  or (select count(distinct v) from jsonb_each_text(ids) x(k,v))<>8 or exists(select 1 from jsonb_each_text(ids) x(k,v) where v in(a.id::text,a.order_id::text))
  or jsonb_typeof(payment)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(payment) k) is distinct from array['method','walletId']::text[]
  or payment->>'method' is null or payment->>'method' not in ('cash','wallet','credit') or (case when payment->>'method'='wallet' then jsonb_typeof(payment->'walletId')<>'string' else payment->'walletId'<>'null'::jsonb end)
  or jsonb_typeof(source->'swaps')<>'array' or jsonb_array_length(source->'swaps')>200 then raise invalid_parameter_value using message='Keep the complete original choices and reserved identities.';end if;
 if (select count(distinct d->>'lineId') from jsonb_array_elements(source->'swaps') d)<>jsonb_array_length(source->'swaps')
  or exists(select 1 from jsonb_array_elements(source->'swaps') d where jsonb_typeof(d)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(d) k) is distinct from array['accepted','lineId']::text[] or jsonb_typeof(d->'accepted')<>'boolean') then raise invalid_parameter_value using message='Answer each offered swap explicitly.';end if;
 if exists(select 1 from private.confirmation_json_elements(current_order.lines) ll cross join jsonb_each_text(ids) x(k,v) where private.confirmation_json_text(ll,'id')=v or private.confirmation_json_text(ll,'id')=a.id::text) then raise invalid_parameter_value using message='Keep separate order, line and action identities.';end if;
 for l in select * from private.confirmation_json_elements(current_order.lines) loop
  if private.confirmation_json_text(l,'unavailable')='false' and private.confirmation_json_text(private.confirmation_json_field(l,'substitution'),'accepted')='false' then
   proposal_count:=proposal_count+1;select d into decision from jsonb_array_elements(source->'swaps') d where d->>'lineId'=private.confirmation_json_text(l,'id');
   if not found then raise invalid_parameter_value using message='Answer every offered swap.';end if;
   if decision->>'accepted'='false' then continue;end if;
   select json_object_agg(k,v) into l from(select k,v from private.confirmation_json_fields(l) x(k,v) where k<>'substitution'
    union all select 'substitution',json_build_object('from',private.confirmation_json_field(private.confirmation_json_field(l,'substitution'),'from'),'accepted',true,'acceptedAt',a.prepared_at)) x;
  end if;
  if private.confirmation_json_text(l,'unavailable')='false' then
   if private.confirmation_json_text(l,'unitPrice') is null or private.confirmation_json_text(l,'unitPrice')::numeric not between 0 and 9007199254740991 or trunc(private.confirmation_json_text(l,'unitPrice')::numeric)<>private.confirmation_json_text(l,'unitPrice')::numeric or private.confirmation_json_text(l,'qty')::numeric<=0 or private.confirmation_json_text(l,'qty')::numeric>999999
    or trunc(private.confirmation_json_text(l,'qty')::numeric,3)<>private.confirmation_json_text(l,'qty')::numeric or private.confirmation_json_text(l,'lineTotal')::numeric is distinct from round(private.confirmation_json_text(l,'unitPrice')::numeric*private.confirmation_json_text(l,'qty')::numeric) then raise invalid_parameter_value using message='Keep exact quoted prices and quantities.';end if;
   subtotal:=subtotal+private.confirmation_json_text(l,'lineTotal')::numeric;available_count:=available_count+1;
   sale_items:=array_append(sale_items,private.confirmation_strip_nulls(json_build_object('itemId',private.confirmation_json_field(l,'itemId'),'name',private.confirmation_json_field(l,'name'),'unit',private.confirmation_json_field(l,'unit'),'qty',private.confirmation_json_field(l,'qty'),'unitPrice',private.confirmation_json_field(l,'unitPrice'),'lineTotal',private.confirmation_json_field(l,'lineTotal'))));
  end if;
  kept:=array_append(kept,l);
 end loop;
 if proposal_count<>jsonb_array_length(source->'swaps') or available_count=0 then raise invalid_parameter_value using message='Keep one explicit decision per proposal and at least one priced item.';end if;
 total:=subtotal+current_order.delivery_fee-current_order.discount;
 if subtotal not between 0 and 9007199254740991 or total not between 0 and 9007199254740991 or current_order.revision>9007199254740987 then raise invalid_parameter_value using message='Keep supported integer totals and revisions.';end if;
 credit:=payment->>'method'='credit';expected_credit:=credit and total>0;
 if payment->>'method'='wallet' then
  select w::jsonb into wallet from json_array_elements(private.confirmation_json_field(quote,'wallets')) w where w->>'id'=payment->>'walletId';
  if not found then raise invalid_parameter_value using message='Choose a current shop wallet target.';end if;
 end if;
 if credit then
  select * into permission from private.order_credit_permissions g where g.business_id=a.business_id and g.outlet_id=a.outlet_id and g.order_id=a.order_id;
  select * into account from public.credit_accounts x where x.business_id=a.business_id and x.outlet_id=a.outlet_id and x.id=permission.account_id and x.customer_id=current_order.customer_id for update;
  select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0),coalesce(max(e.sequence),0)+1 into balance,sequence_value from public.credit_entries e where e.business_id=a.business_id and e.outlet_id=a.outlet_id and e.account_id=account.id;
  if private.confirmation_json_text(quote,'credit') is null or not coalesce(permission.enabled,false) or permission.order_revision<>current_order.revision or account.id is null or not account.allowed
   or account.currency<>current_order.currency or account.currency<>outlet_row.currency or total>permission.maximum or balance+total>account.credit_limit then raise sqlstate 'PT409' using message='Review the current khata permission and limit.';end if;
 end if;
 if records is null or jsonb_typeof(records)<>'array' or octet_length(records::text)>8388608
  or exists(select 1 from jsonb_array_elements(records) rr where jsonb_typeof(rr)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(rr) k) is distinct from array['table','values']::text[])
  then raise invalid_parameter_value using message='Keep only the complete prepared confirmation records.';end if;
 select count(*) filter(where rr->>'table'='orders'),count(*) filter(where rr->>'table'='events'),count(*) filter(where rr->>'table'='sales'),count(*) filter(where rr->>'table'='credit_entries')
  into order_count,event_count,sale_count,entry_count from jsonb_array_elements(records) rr;
 order_event_count:=case when current_order.status='requested' then 3 else 2 end+case when credit then 1 else 0 end;
 if order_count<>1 or event_count<>order_event_count+(case when expected_credit then 2 else 0 end) or sale_count<>(case when expected_credit then 1 else 0 end) or entry_count<>sale_count
  or jsonb_array_length(records)<>order_count+event_count+sale_count+entry_count or (select count(distinct (rr->>'table')||':'||(rr->'values'->>'id')) from jsonb_array_elements(records) rr)<>jsonb_array_length(records) then raise invalid_parameter_value using message='Keep the exact order, audit and financial record set.';end if;
 select rr->'values' into order_values from jsonb_array_elements(records) rr where rr->>'table'='orders';
 next_order:=current_order;next_order.revision:=next_order.revision+1;next_order.updated_at:=a.prepared_at;next_order.event_id:=(ids->>'updateEventId')::public.ulid;
 next_order.lines:=array_to_json(kept);next_order.subtotal:=subtotal::bigint;next_order.total:=total::bigint;
 next_order.payment:=case when payment->>'method'='wallet' then json_build_object('method','wallet','wallet',wallet->>'name','status','pending') else json_build_object('method',payment->>'method','status','pending') end;
 previous_order:=current_order;
 for step in 1..order_event_count loop
  if step=1 then event_id:=ids->>'updateEventId';event_command:='order.update';
  elsif next_order.status='requested' then
   next_order.status:='priced';next_order.revision:=next_order.revision+1;next_order.status_changed_at:=a.prepared_at;next_order.status_event_id:=(ids->>'pricedEventId')::public.ulid;next_order.event_id:=next_order.status_event_id;event_id:=ids->>'pricedEventId';event_command:='order.status';
  elsif next_order.status='priced' then
   next_order.status:='accepted';next_order.revision:=next_order.revision+1;next_order.status_changed_at:=a.prepared_at;next_order.status_event_id:=(ids->>'acceptedEventId')::public.ulid;next_order.event_id:=next_order.status_event_id;event_id:=ids->>'acceptedEventId';event_command:='order.status';
  else
   next_order.revision:=next_order.revision+1;next_order.event_id:=(ids->>'paymentEventId')::public.ulid;event_id:=ids->>'paymentEventId';event_command:='order.payment';
   next_order.payment:=case when expected_credit then json_build_object('method','credit','status','credited','saleId',ids->>'saleId','at',a.prepared_at) else json_build_object('method','cash','status','paid','at',a.prepared_at) end;
  end if;
  select rr->'values' into e from jsonb_array_elements(records) rr where rr->>'table'='events' and rr->'values'->>'id'=event_id;
  before_image:=private.kitchen_order_image(previous_order);after_image:=private.kitchen_order_image(next_order);
  if not coalesce(private.confirmation_event_valid(e,a.business_id,a.outlet_id,a.order_id,event_id,event_command,next_order.revision,null,a.prepared_at,before_image,after_image),false) then raise invalid_parameter_value using message='Keep the exact Core order and status audit images.';end if;
  previous_order:=next_order;
 end loop;
 -- Compare the final logical row to the actual Core image before any write.
 if not private.confirmation_json_equal((select (v->>'after_data')::json from jsonb_array_elements(records) rr cross join lateral(select rr->'values' v) x where rr->>'table'='events' and v->>'id'=next_order.event_id),private.kitchen_order_image(next_order)) then raise invalid_parameter_value using message='Keep the final accepted order.';end if;
 if order_values->>'id' is distinct from current_order.id::text or order_values->>'business_id' is distinct from a.business_id::text or order_values->>'outlet_id' is distinct from a.outlet_id::text
  or (select bool_or(order_values->>k is distinct from private.confirmation_json_text(row_to_json(next_order),k)) from unnest(array['id','business_id','outlet_id','created_by','created_at','updated_at','event_id','revision','business_type','sequence','number','source','customer_id','customer_phone','type','status','status_changed_at','status_event_id','subtotal','delivery_fee','discount','total','currency','timezone','scheduled_for','handled_by']) k)
  or not private.confirmation_json_equal((order_values->>'source_text')::json,next_order.source_text) or not private.confirmation_json_equal((order_values->>'customer_name')::json,next_order.customer_name)
  or not private.confirmation_json_equal((order_values->>'address')::json,next_order.address) or not private.confirmation_json_equal((order_values->>'table_label')::json,next_order.table_label)
  or not private.confirmation_json_equal((order_values->>'lines')::json,next_order.lines) or not private.confirmation_json_equal((order_values->>'payment')::json,next_order.payment) then raise invalid_parameter_value using message='Keep the original order identity and exact accepted values.';end if;
 if expected_credit then
  select rr->'values' into sale_values from jsonb_array_elements(records) rr where rr->>'table'='sales';select rr->'values' into entry_values from jsonb_array_elements(records) rr where rr->>'table'='credit_entries';
  if sale_values->>'id' is distinct from ids->>'saleId' or sale_values->>'event_id' is distinct from ids->>'saleEventId' or sale_values->>'created_by' is distinct from cap.issued_by::text
   or sale_values->>'order_id' is distinct from a.order_id::text or sale_values->>'order_number' is distinct from current_order.number or sale_values->>'customer_id' is distinct from current_order.customer_id::text
   or sale_values->>'credit_account_id' is distinct from account.id::text or sale_values->>'currency' is distinct from current_order.currency or sale_values->>'method'<>'credit'
   or sale_values->>'method_name' is distinct from to_json(case when business_row.market_code='BD' then 'Baki' else 'Credit' end)::text
   or (sale_values->>'amount')::bigint is distinct from total::bigint or (sale_values->>'delivery_fee')::bigint is distinct from current_order.delivery_fee or (sale_values->>'discount')::bigint is distinct from current_order.discount
   or sale_values->>'expression'!~'^[0-9]+([.][0-9]+)?$' or length(sale_values->>'expression')>40 or sale_values->>'timezone' is distinct from outlet_row.timezone
   or (sale_values->>'created_at')::bigint is distinct from a.prepared_at or (sale_values->>'updated_at')::bigint is distinct from a.prepared_at
   or exists(select 1 from unnest(array['voided_at','closing_id','given','change','void_reason']) k where sale_values->>k is not null)
   or not private.confirmation_json_equal((sale_values->>'who')::json,current_order.customer_name) or not private.confirmation_json_equal((sale_values->>'shop_name')::json,business_row.name)
   or sale_values->>'shop_link' is distinct from (case when outlet_row.shop_link~'^https://' then outlet_row.shop_link else null end)
   or not private.confirmation_json_equal((sale_values->>'items')::json,array_to_json(sale_items)) then raise invalid_parameter_value using message='Keep the actual credit sale and original financial identities.';end if;
  if entry_values->>'id' is distinct from ids->>'entryId' or entry_values->>'event_id' is distinct from ids->>'creditEventId' or entry_values->>'created_by' is distinct from cap.issued_by::text
   or entry_values->>'order_id' is distinct from a.order_id::text or entry_values->>'sale_id' is distinct from ids->>'saleId' or entry_values->>'customer_id' is distinct from current_order.customer_id::text
   or entry_values->>'account_id' is distinct from account.id::text or entry_values->>'currency' is distinct from current_order.currency or entry_values->>'type'<>'charge'
   or (entry_values->>'amount')::bigint is distinct from total::bigint or (entry_values->>'sequence')::bigint is distinct from sequence_value
   or (entry_values->>'created_at')::bigint is distinct from a.prepared_at or (entry_values->>'updated_at')::bigint is distinct from a.prepared_at
   or exists(select 1 from unnest(array['refund_id','returns_charge_id','method_name','occurred_at','reversal_of','purpose','over_limit']) k where entry_values->>k is not null) then raise invalid_parameter_value using message='Keep the actual in-limit khata charge.';end if;
  for event_id,event_command,r in select ids->>'creditEventId','khata.charge',entry_values union all select ids->>'saleEventId','sale.record',sale_values loop
   select x->'values' into e from jsonb_array_elements(records) x where x->>'table'='events' and x->'values'->>'id'=event_id;
   if not coalesce(private.confirmation_event_valid(e,a.business_id,a.outlet_id,a.order_id,event_id,event_command,null,current_order.customer_id::text,a.prepared_at,'null'::json,private.confirmation_money_image(case when event_command='khata.charge' then 'credit_entries' else 'sales' end,r)),false) then raise invalid_parameter_value using message='Keep the linked financial audit images.';end if;
  end loop;
 end if;
 for r in select * from jsonb_array_elements(records) loop
  if r->'values'->>'business_id' is distinct from a.business_id::text or r->'values'->>'outlet_id' is distinct from a.outlet_id::text then raise insufficient_privilege using message='Keep the actual confirmation outlet.';end if;
  perform private.write_confirmation_record(r->>'table',r->'values',r->>'table'='orders');
 end loop;
 update private.order_confirmation_actions set state='applied',expires_at=null,receipt=jsonb_build_object('orderId',a.order_id,'revision',next_order.revision,'total',next_order.total,'currency',next_order.currency,
  'paymentStatus',next_order.payment->>'status','at',a.prepared_at,'saleId',case when expected_credit then ids->>'saleId' else null end,'entryId',case when expected_credit then ids->>'entryId' else null end)
  where id=a.id returning * into a;
 return private.order_confirmation_result(a);
end $$;
revoke all on function private.finish_order_confirmation(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.finish_order_confirmation(public.ulid,text,jsonb) to service_role;
create function public.finish_order_confirmation(p_id public.ulid,p_ticket text,p_records jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.finish_order_confirmation(p_id,p_ticket,p_records) $$;
revoke all on function public.finish_order_confirmation(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_order_confirmation(public.ulid,text,jsonb) to service_role;
notify pgrst,'reload schema';
