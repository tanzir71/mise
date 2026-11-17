-- M30 customer capabilities: secrets are returned once and only their hashes persist.
create table private.public_links (
  id public.ulid primary key,
  business_id public.ulid not null, outlet_id public.ulid not null,
  kind text not null check (kind in ('order','khata')),
  order_id public.ulid, account_id public.ulid,
  token_hash bytea not null unique check (octet_length(token_hash)=32),
  issued_by public.ulid not null, created_at public.utc_ms not null,
  expires_at public.utc_ms not null check (expires_at>created_at and expires_at<=created_at+7776000000),
  revoked_at public.utc_ms check (revoked_at>=created_at),
  check ((kind='order' and order_id is not null and account_id is null)
    or (kind='khata' and account_id is not null and order_id is null)),
  foreign key (business_id,outlet_id) references public.outlets(business_id,id),
  foreign key (business_id,outlet_id,order_id) references public.orders(business_id,outlet_id,id),
  foreign key (business_id,outlet_id,account_id) references public.credit_accounts(business_id,outlet_id,id),
  foreign key (business_id,issued_by) references public.members(business_id,id)
);
alter table private.public_links enable row level security;
alter table private.public_links force row level security;
revoke all on private.public_links from public,anon,authenticated,service_role;
create index public_links_outlet_idx on private.public_links(business_id,outlet_id,created_at desc,id desc);
create index public_links_order_idx on private.public_links(business_id,outlet_id,order_id);
create index public_links_account_idx on private.public_links(business_id,outlet_id,account_id);
create index public_links_issuer_idx on private.public_links(business_id,issued_by);

create function private.public_link_metadata(link private.public_links) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',link.id,'kind',link.kind,'resourceId',coalesce(link.order_id,link.account_id),
    'createdAt',link.created_at,'expiresAt',link.expires_at,'revokedAt',link.revoked_at)
$$;
revoke all on function private.public_link_metadata(private.public_links) from public,anon,authenticated,service_role;

-- Called only inside the privileged mutation functions. Lock live authorization
-- rows so membership/assignment/phone revocation cannot race the grant transaction.
create function private.public_link_actor(business public.ulid,outlet public.ulid) returns public.ulid
language plpgsql security invoker set search_path='' as $$
declare actor public.ulid; actor_role text;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  select m.id,m.role into actor,actor_role from public.members m join auth.users u on u.id=m.auth_user_id
    where m.business_id=business and m.auth_user_id=(select auth.uid()) and m.active and m.role in ('owner','manager')
      and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>'' and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now()) for share of m,u;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  if actor_role='manager' then
    perform 1 from public.member_outlets mo where mo.business_id=business and mo.member_id=actor and mo.outlet_id=outlet for share;
    if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  end if;
  return actor;
end $$;
revoke all on function private.public_link_actor(public.ulid,public.ulid) from public,anon,authenticated,service_role;

create function private.create_public_link(link_id public.ulid,event_id public.ulid,link_kind text,resource_id public.ulid,expiry public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid; outlet public.ulid; actor public.ulid; secret text;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  expires public.utc_ms; saved private.public_links;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  if link_kind='order' then select o.business_id,o.outlet_id into business,outlet from public.orders o where o.id=resource_id;
  elsif link_kind='khata' then select a.business_id,a.outlet_id into business,outlet from public.credit_accounts a where a.id=resource_id;
  else raise invalid_parameter_value using message='Choose an order or khata link.'; end if;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  actor:=private.public_link_actor(business,outlet);
  if link_kind='order' then
    perform 1 from public.orders o where o.id=resource_id and o.business_id=business and o.outlet_id=outlet for key share;
  else
    perform 1 from public.credit_accounts a where a.id=resource_id and a.business_id=business and a.outlet_id=outlet for key share;
  end if;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  expires:=coalesce(expiry,at_ms+case when link_kind='order' then 604800000 else 2592000000 end);
  if expires<=at_ms or expires>at_ms+7776000000 then raise invalid_parameter_value using message='Choose an expiry within 90 days.'; end if;
  -- Three independent UUIDv4 values supply more than 256 bits of CSPRNG input.
  -- Hash to 32 bytes and encode URL-safe without padding; no extension is required.
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  insert into private.public_links(id,business_id,outlet_id,kind,order_id,account_id,token_hash,issued_by,created_at,expires_at)
    values(link_id,business,outlet,link_kind,case when link_kind='order' then resource_id end,
      case when link_kind='khata' then resource_id end,sha256(convert_to(secret,'UTF8')),actor,at_ms,expires) returning * into saved;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,order_id,customer_id)
    values(event_id,business,outlet,'member',actor,'public_link.create','null',private.public_link_metadata(saved)::json,at_ms,
      saved.order_id,case when link_kind='khata' then (select a.customer_id from public.credit_accounts a where a.id=saved.account_id) end);
  return private.public_link_metadata(saved)||jsonb_build_object('token',secret);
end $$;
revoke all on function private.create_public_link(public.ulid,public.ulid,text,public.ulid,public.utc_ms) from public,anon,authenticated,service_role;
grant execute on function private.create_public_link(public.ulid,public.ulid,text,public.ulid,public.utc_ms) to authenticated;

create function private.revoke_public_link(link_id public.ulid,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.public_links; previous jsonb; actor public.ulid;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  select * into saved from private.public_links c where c.id=link_id for update;
  if not found then raise insufficient_privilege using message='This link cannot be changed.'; end if;
  actor:=private.public_link_actor(saved.business_id,saved.outlet_id);
  if saved.revoked_at is not null then return private.public_link_metadata(saved); end if;
  previous:=private.public_link_metadata(saved);
  update private.public_links c set revoked_at=greatest(at_ms,c.created_at) where c.id=saved.id returning * into saved;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,order_id,customer_id)
    values(event_id,saved.business_id,saved.outlet_id,'member',actor,'public_link.revoke',previous::json,
      private.public_link_metadata(saved)::json,greatest(at_ms,saved.created_at),saved.order_id,
      case when saved.kind='khata' then (select a.customer_id from public.credit_accounts a where a.id=saved.account_id) end);
  return private.public_link_metadata(saved);
end $$;
revoke all on function private.revoke_public_link(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.revoke_public_link(public.ulid,public.ulid) to authenticated;

-- The capability is the customer identity: no account/sign-in is needed here.
-- Never accept a caller-selected business, outlet, order or account identifier.
create function private.read_public_link(secret text,link_kind text,after_sequence bigint,page_size integer) returns jsonb
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
        'paymentStatus',o.payment->>'status')) into result
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
revoke all on function private.read_public_link(text,text,bigint,integer) from public,anon,authenticated,service_role;
grant usage on schema private to anon;
grant execute on function private.read_public_link(text,text,bigint,integer) to anon,authenticated;

-- Exposed functions are invokers. Privileged code stays in the unexposed schema.
create function public.create_public_link(p_id public.ulid,p_event_id public.ulid,p_kind text,p_resource_id public.ulid,p_expires_at public.utc_ms default null)
returns jsonb language sql security invoker set search_path='' as $$
  select private.create_public_link(p_id,p_event_id,p_kind,p_resource_id,p_expires_at)
$$;
create function public.revoke_public_link(p_id public.ulid,p_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.revoke_public_link(p_id,p_event_id)$$;
create function public.read_order_link(p_token text) returns jsonb
language sql stable security invoker set search_path='' as $$select private.read_public_link(p_token,'order',0,50)$$;
create function public.read_khata_link(p_token text,p_after_sequence bigint default 0,p_page_size integer default 50) returns jsonb
language sql stable security invoker set search_path='' as $$select private.read_public_link(p_token,'khata',p_after_sequence,p_page_size)$$;
revoke all on function public.create_public_link(public.ulid,public.ulid,text,public.ulid,public.utc_ms),
  public.revoke_public_link(public.ulid,public.ulid),public.read_order_link(text),public.read_khata_link(text,bigint,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.create_public_link(public.ulid,public.ulid,text,public.ulid,public.utc_ms),
  public.revoke_public_link(public.ulid,public.ulid) to authenticated;
grant execute on function public.read_order_link(text),public.read_khata_link(text,bigint,integer) to anon,authenticated;
