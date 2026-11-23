-- Arrival estimates are independently versioned, owner-issued metadata. They
-- never update orders, preparation acknowledgements, money or their revisions.
create table private.order_estimate_actions (
 id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,order_id public.ulid not null,
 actor_id public.ulid not null,source jsonb not null,state text not null check(state in ('closed','applied')),
 receipt jsonb not null,previous jsonb,at public.utc_ms not null,
 foreign key(business_id,outlet_id,order_id) references public.orders(business_id,outlet_id,id) on delete cascade
);
create index order_estimate_actions_order on private.order_estimate_actions(business_id,outlet_id,order_id,id);
create table private.order_estimates (
 order_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 revision bigint not null check(revision between 1 and 9007199254740991),
 window_start public.utc_ms,window_end public.utc_ms,first_end public.utc_ms,note text not null,
 updated_at public.utc_ms not null,action_id public.ulid not null references private.order_estimate_actions(id),
 foreign key(business_id,outlet_id,order_id) references public.orders(business_id,outlet_id,id) on delete cascade,
 check((window_start is null)=(window_end is null)),
 check(window_start is null or window_end>=window_start and window_end-window_start<=86400000 and first_end is not null),
 check(length(note)<=300)
);
alter table private.order_estimate_actions enable row level security;
create index order_estimates_scope on private.order_estimates(business_id,outlet_id,order_id);
create index order_estimates_action on private.order_estimates(action_id);
alter table private.order_estimate_actions force row level security;
alter table private.order_estimates enable row level security;
alter table private.order_estimates force row level security;
revoke all on private.order_estimates,private.order_estimate_actions from public,anon,authenticated,service_role;

create function private.public_order_estimate(business public.ulid,outlet public.ulid,order_id public.ulid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('revision',e.revision,'start',e.window_start,'end',e.window_end,'firstEnd',e.first_end,'note',e.note,'updatedAt',e.updated_at)
 from private.order_estimates e where e.business_id=business and e.outlet_id=outlet and e.order_id=public_order_estimate.order_id
$$;
revoke all on function private.public_order_estimate(public.ulid,public.ulid,public.ulid) from public,anon,authenticated,service_role;

create function private.read_order_estimate(order_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.orders;actor public.ulid;role_name text;latest public.ulid;
begin
 select * into o from public.orders where id=order_id;
 if not found then raise insufficient_privilege using message='Use the current order owner or assigned manager.';end if;
 actor:=private.public_shop_actor(o.outlet_id);
 select role into role_name from public.members where id=actor and business_id=o.business_id;
 select action_id into latest from private.order_estimates where order_estimates.order_id=o.id;
 return jsonb_build_object('v',1,'businessId',o.business_id,'outletId',o.outlet_id,'orderId',o.id,'actorId',actor,'actorRole',role_name,
  'orderRevision',o.revision,'status',o.status,'type',o.type,'estimate',private.public_order_estimate(o.business_id,o.outlet_id,o.id),
  'lastActionId',latest,'serverAt',floor(extract(epoch from clock_timestamp())*1000)::bigint);
end $$;
revoke all on function private.read_order_estimate(public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.read_order_estimate(public.ulid) to authenticated;
create function public.read_order_estimate(p_order_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$ select private.read_order_estimate(p_order_id) $$;
revoke all on function public.read_order_estimate(public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.read_order_estimate(public.ulid) to authenticated;

create function private.change_order_estimate(order_id public.ulid,action_id public.ulid,order_revision bigint,estimate_revision bigint,change jsonb,operation text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare o public.orders;actor public.ulid;original jsonb;prior jsonb;next_value jsonb;result jsonb;
 a private.order_estimate_actions;e private.order_estimates;target private.order_estimate_actions;
 start_at public.utc_ms;end_at public.utc_ms;first_at public.utc_ms;public_note text;kind text;undo_id public.ulid;
 stamp public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if action_id is null or order_id is null or action_id=order_id or order_revision is null or order_revision not between 1 and 9007199254740990
  or estimate_revision is null or estimate_revision not between 0 and 9007199254740990 or operation is null or operation not in ('submit','inspect','close')
  or change is null or jsonb_typeof(change)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(change) k)<>array['end','kind','note','start','undoOf']::text[] then
  raise invalid_parameter_value using message='Keep the original estimate action.';
 end if;
 kind:=change->>'kind';public_note:=change->>'note';
 if kind is null or kind not in ('set','clear','undo') or jsonb_typeof(change->'note')<>'string' or length(public_note)>300 or public_note<>btrim(public_note)
  or public_note~'[\x01-\x08\x0b\x0c\x0e-\x1f]' then raise invalid_parameter_value using message='Review the public estimate text.';end if;
 if kind='set' then
  if jsonb_typeof(change->'start')<>'number' or jsonb_typeof(change->'end')<>'number' or change->>'start'!~'^[0-9]{1,16}$' or change->>'end'!~'^[0-9]{1,16}$' or change->'undoOf'<>'null'::jsonb then
   raise invalid_parameter_value using message='Choose the estimate window.';end if;
  start_at:=(change->>'start')::bigint;end_at:=(change->>'end')::bigint;
  if start_at>8640000000000000 or end_at>8640000000000000 or end_at<start_at or end_at-start_at>86400000 then raise invalid_parameter_value using message='Choose one bounded estimate window.';end if;
 else
  if change->'start'<>'null'::jsonb or change->'end'<>'null'::jsonb or (kind='clear' and change->'undoOf'<>'null'::jsonb)
   or (kind='undo' and (public_note<>'' or jsonb_typeof(change->'undoOf')<>'string' or change->>'undoOf'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')) then
   raise invalid_parameter_value using message='Keep the original withdrawal or undo.';end if;
  if kind='undo' then undo_id:=(change->>'undoOf')::public.ulid;end if;
 end if;
 select * into o from public.orders where id=order_id for update;
 if not found then raise insufficient_privilege using message='Use the current order owner or assigned manager.';end if;
 actor:=private.public_shop_actor(o.outlet_id);
 original:=jsonb_build_object('v',1,'id',action_id,'orderId',order_id,'orderRevision',order_revision,'revision',estimate_revision,'change',change);
 select * into a from private.order_estimate_actions where id=action_id;
 if found then
  if a.business_id<>o.business_id or a.outlet_id<>o.outlet_id or a.order_id<>o.id or a.actor_id<>actor then raise insufficient_privilege using message='Keep the original estimate account.';end if;
  if a.source<>original then raise unique_violation using message='Keep the exact original estimate action.';end if;
  return a.receipt;
 end if;
 if operation='inspect' then return jsonb_build_object('v',1,'action',original,'state','pending','at',null,'estimate',null);end if;
 if operation='close' then
  result:=jsonb_build_object('v',1,'action',original,'state','closed','at',stamp,'estimate',null);
  insert into private.order_estimate_actions values(action_id,o.business_id,o.outlet_id,o.id,actor,original,'closed',result,null,stamp);
  return result;
 end if;
 select * into e from private.order_estimates where order_estimates.order_id=o.id;
 if o.revision<>order_revision or coalesce(e.revision,0)<>estimate_revision or o.status in ('cancelled','delivered','returned','collected','done') then
  raise sqlstate 'PT409' using message='Review the current order and estimate.';end if;
 prior:=private.public_order_estimate(o.business_id,o.outlet_id,o.id);first_at:=e.first_end;
 if kind='undo' then
  if e.action_id is distinct from undo_id then raise sqlstate 'PT409' using message='Only the latest estimate can be undone.';end if;
  select h.* into target from private.order_estimate_actions h where h.id=undo_id and h.business_id=o.business_id and h.outlet_id=o.outlet_id and h.order_id=o.id and h.state='applied';
  if not found then raise sqlstate 'PT409' using message='The estimate history is unavailable.';end if;
  start_at:=(target.previous->>'start')::bigint;end_at:=(target.previous->>'end')::bigint;public_note:=coalesce(target.previous->>'note','');
 elsif kind='set' and (end_at<=stamp or end_at>stamp+604800000) then raise sqlstate 'PT409' using message='Review this expired or distant estimate.';end if;
 first_at:=coalesce(first_at,end_at);
 next_value:=jsonb_build_object('revision',estimate_revision+1,'start',start_at,'end',end_at,'firstEnd',first_at,'note',public_note,'updatedAt',stamp);
 result:=jsonb_build_object('v',1,'action',original,'state','applied','at',stamp,'estimate',next_value);
 insert into private.order_estimate_actions values(action_id,o.business_id,o.outlet_id,o.id,actor,original,'applied',result,prior,stamp);
 insert into private.order_estimates values(o.id,o.business_id,o.outlet_id,estimate_revision+1,start_at,end_at,first_at,public_note,stamp,action_id)
  on conflict on constraint order_estimates_pkey do update set revision=excluded.revision,window_start=excluded.window_start,window_end=excluded.window_end,
   first_end=excluded.first_end,note=excluded.note,updated_at=excluded.updated_at,action_id=excluded.action_id;
 return result;
end $$;
revoke all on function private.change_order_estimate(public.ulid,public.ulid,bigint,bigint,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function private.change_order_estimate(public.ulid,public.ulid,bigint,bigint,jsonb,text) to authenticated;
create function public.change_order_estimate(p_order_id public.ulid,p_action_id public.ulid,p_order_revision bigint,p_estimate_revision bigint,p_change jsonb,p_operation text)
returns jsonb language sql security invoker set search_path='' as $$
 select private.change_order_estimate(p_order_id,p_action_id,p_order_revision,p_estimate_revision,p_change,p_operation)
$$;
revoke all on function public.change_order_estimate(public.ulid,public.ulid,bigint,bigint,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.change_order_estimate(public.ulid,public.ulid,bigint,bigint,jsonb,text) to authenticated;
create or replace function private.read_public_link(secret text,link_kind text,after_sequence bigint,page_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare cap private.public_links; result jsonb; entries jsonb; balance numeric;
  last_sequence bigint; more boolean;
  at_ms public.utc_ms:=floor(extract(epoch from statement_timestamp())*1000)::bigint;
begin
  if after_sequence is null or after_sequence<0 or after_sequence>9007199254740991 or page_size is null or page_size<1 or page_size>100 then
    raise invalid_parameter_value using message='Choose a valid page of up to 100 entries.';
  end if;
  if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' or link_kind not in ('order','khata') then return null; end if;
  select * into cap from private.public_links c where c.token_hash=sha256(convert_to(secret,'UTF8'))
    and c.kind=link_kind and c.revoked_at is null and c.expires_at>at_ms;
  if not found then return null; end if;
  if link_kind='order' then
    select jsonb_build_object('v',1,'kind','order','shopNameJson',b.name::text,'outletNameJson',s.name::text,'shopLink',s.shop_link,'marketCode',b.market_code,
      'order',jsonb_build_object('id',o.id,'number',o.number,'businessType',o.business_type,'type',o.type,'status',o.status,
        'statusChangedAt',o.status_changed_at,'scheduledFor',o.scheduled_for,'currency',o.currency,'subtotal',o.subtotal,
        'deliveryFee',o.delivery_fee,'discount',o.discount,'total',o.total,'linesJson',o.lines::text,'timezone',o.timezone,
        'tableJson',case when o.type='dine_in' and btrim(o.table_label#>>'{}')<>'' then o.table_label::text else null end,'estimate',private.public_order_estimate(o.business_id,o.outlet_id,o.id),'estimateObservedAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,'paymentStatus',o.payment->>'status')) into result
      from public.orders o join public.outlets s on s.business_id=o.business_id and s.id=o.outlet_id
      join public.businesses b on b.id=o.business_id
      where o.business_id=cap.business_id and o.outlet_id=cap.outlet_id and o.id=cap.order_id;
    return result;
  end if;
  select coalesce(sum(case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end),0)
    into balance from public.credit_entries e where e.business_id=cap.business_id and e.outlet_id=cap.outlet_id and e.account_id=cap.account_id;
  if balance not between -9007199254740991 and 9007199254740991 then
    raise numeric_value_out_of_range using message='This khata needs the shop to review its balance.';
  end if;
  select coalesce(jsonb_agg(part.entry order by part.sequence),'[]'::jsonb),max(part.sequence) into entries,last_sequence from (
    select e.sequence,jsonb_build_object('id',e.id,'sequence',e.sequence,'type',e.type,'amount',e.amount,
      'delta',case when e.type='payment' then -e.amount when e.type in ('charge','adjustment') then e.amount else 0 end,
      'at',coalesce(e.occurred_at,e.created_at),'reversalOf',e.reversal_of,
      'methodNameJson',case when e.type in ('payment','refund') then e.method_name::text end) as entry
    from public.credit_entries e where e.business_id=cap.business_id and e.outlet_id=cap.outlet_id and e.account_id=cap.account_id
      and e.type<>'reminder' and e.sequence>after_sequence order by e.sequence limit page_size
  ) part;
  last_sequence:=coalesce(last_sequence,after_sequence);
  select exists(select 1 from public.credit_entries e where e.business_id=cap.business_id and e.outlet_id=cap.outlet_id
    and e.account_id=cap.account_id and e.type<>'reminder' and e.sequence>last_sequence) into more;
  select jsonb_build_object('v',1,'kind','khata','shopNameJson',b.name::text,'outletNameJson',s.name::text,'shopLink',s.shop_link,'marketCode',b.market_code,
    'account',jsonb_build_object('id',a.id,'customerNameJson',c.name::text,'currency',a.currency,'balance',balance,
      'entries',entries,'nextSequence',last_sequence,'hasMore',more,'timezone',s.timezone)) into result
    from public.credit_accounts a join public.customers c on c.business_id=a.business_id and c.id=a.customer_id
    join public.outlets s on s.business_id=a.business_id and s.id=a.outlet_id join public.businesses b on b.id=a.business_id
    where a.business_id=cap.business_id and a.outlet_id=cap.outlet_id and a.id=cap.account_id;
  return result;
end $$;
notify pgrst,'reload schema';
