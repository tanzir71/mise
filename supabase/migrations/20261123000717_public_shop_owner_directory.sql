-- Metadata only: original public submission secrets never leave the issuing
-- browser through a list endpoint. Reuse live phone/outlet authorization.
create function private.read_public_shop_page(outlet public.ulid,after_id public.ulid,page_size integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare actor public.ulid;business public.ulid;role_name text;rows jsonb;next_id public.ulid;
begin
 if outlet is null or page_size is null or page_size not between 1 and 100 then
  raise invalid_parameter_value using message='Choose one outlet and a bounded publication page.';
 end if;
 actor:=private.public_shop_actor(outlet);
 select o.business_id into business from public.outlets o where o.id=outlet;
 select m.role into role_name from public.members m where m.id=actor and m.business_id=business;
 select coalesce(jsonb_agg(private.public_shop_metadata(p) order by p.id),'[]'::jsonb)
  into rows from (select g.* from private.public_shops g where g.business_id=business and g.outlet_id=outlet
   and (after_id is null or g.id>after_id) order by g.id limit page_size) p;
 if jsonb_array_length(rows)=page_size then
  next_id:=(rows->(page_size-1)->>'id')::public.ulid;
  if not exists(select 1 from private.public_shops g where g.business_id=business and g.outlet_id=outlet and g.id>next_id) then next_id:=null;end if;
 end if;
 return jsonb_build_object('v',1,'businessId',business,'outletId',outlet,'actorId',actor,'actorRole',role_name,'links',rows,'nextId',next_id);
end $$;
revoke all on function private.read_public_shop_page(public.ulid,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_public_shop_page(public.ulid,public.ulid,integer) to authenticated;
create function public.read_public_shop_page(p_outlet_id public.ulid,p_after_id public.ulid default null,p_page_size integer default 50)
returns jsonb language sql security invoker set search_path='' as $$
 select private.read_public_shop_page(p_outlet_id,p_after_id,p_page_size)
$$;
revoke all on function public.read_public_shop_page(public.ulid,public.ulid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_public_shop_page(public.ulid,public.ulid,integer) to authenticated;
-- Preserve the existing capability, scope, expiry, limits and grants. Expose
-- only its own recorded table label; no private customer address or phone.
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
        'tableJson',case when o.type='dine_in' and btrim(o.table_label#>>'{}')<>'' then o.table_label::text else null end,'paymentStatus',o.payment->>'status')) into result
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
