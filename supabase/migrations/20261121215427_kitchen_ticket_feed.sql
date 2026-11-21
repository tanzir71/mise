-- Device-scoped preparation reads and an IDs-only change cursor. The cursor
-- never grants access; both secrets and current outlet permission are checked
-- on every read. Raw lines travel only to the trusted projection function.
create table private.kitchen_changes (
  seq bigint generated always as identity primary key check(seq between 1 and 9007199254740991),
  business_id public.ulid not null, outlet_id public.ulid not null, order_id public.ulid not null
);
alter table private.kitchen_changes enable row level security;
alter table private.kitchen_changes force row level security;
revoke all on private.kitchen_changes,private.kitchen_changes_seq_seq from public,anon,authenticated,service_role;
create index kitchen_changes_scope_idx on private.kitchen_changes(business_id,outlet_id,seq);

create function private.note_kitchen_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare business public.ulid; outlet public.ulid; target public.ulid;
begin
  if tg_table_name='orders' then
    if tg_op='DELETE' then business:=old.business_id;outlet:=old.outlet_id;target:=old.id;
    else business:=new.business_id;outlet:=new.outlet_id;target:=new.id;end if;
  else business:=new.business_id;outlet:=new.outlet_id;target:=new.order_id;end if;
  -- Allocate a feed sequence only AFTER this outlet's transaction fence. A
  -- later transaction cannot commit a larger scoped sequence while an earlier
  -- one remains invisible. Other outlets keep independent write progress.
  -- Hold through commit/rollback; do not use a session-level advisory lock.
  perform pg_advisory_xact_lock(hashtextextended('mise:kitchen-feed:'||business::text||':'||outlet::text,0));
  insert into private.kitchen_changes(business_id,outlet_id,order_id) values(business,outlet,target);
  -- Broadcast is a small wake hint. A broker outage cannot roll back an order;
  -- the authoritative cursor retains the change for reconnect/manual refresh.
  begin
    perform realtime.send(jsonb_build_object('orderId',target),'kitchen_changed','kitchen:'||outlet::text,true);
  exception when others then null;end;
  return null;
end $$;
revoke all on function private.note_kitchen_change() from public,anon,authenticated,service_role;
create trigger kitchen_order_change after insert or update or delete on public.orders for each row execute function private.note_kitchen_change();
create trigger kitchen_receipt_change after insert on private.kitchen_action_receipts for each row execute function private.note_kitchen_change();
insert into private.kitchen_changes(business_id,outlet_id,order_id) select business_id,outlet_id,id from public.orders order by business_id,outlet_id,created_at,id;

create function private.kitchen_read_rows(business public.ulid,outlet public.ulid,ids public.ulid[]) returns jsonb
language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'outletId',o.outlet_id,'businessType',o.business_type,'number',o.number,
    'type',o.type,'source',o.source,'status',o.status,'statusChangedAt',o.status_changed_at,'createdAt',o.created_at,
    'updatedAt',o.updated_at,'revision',o.revision,'timezone',o.timezone,'scheduledFor',o.scheduled_for,
    'tableJson',o.table_label::text,'linesJson',o.lines::text,'priced',o.total is not null) order by o.created_at,o.id),'[]'::jsonb)
  from public.orders o where o.business_id=business and o.outlet_id=outlet and o.id=any(ids)
$$;
revoke all on function private.kitchen_read_rows(public.ulid,public.ulid,public.ulid[]) from public,anon,authenticated,service_role;

create function private.read_kitchen_page(device_secret text,session_secret text,after_time public.utc_ms,after_id public.ulid,page_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; selected public.ulid[]; cursor jsonb; more boolean; watermark bigint; business public.ulid; outlet public.ulid;
begin
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' then return null;end if;
  if page_size is null or page_size not between 1 and 100 or (after_time is null)<>(after_id is null) then raise invalid_parameter_value using message='Use a complete kitchen page.';end if;
  business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;
  select coalesce(max(c.seq),0) into watermark from private.kitchen_changes c where c.business_id=business and c.outlet_id=outlet;
  with candidates as materialized (
    select o.id,o.created_at,2*octet_length(o.lines::text)+2*octet_length(o.table_label::text)+2048 as weight
    from public.orders o where o.business_id=business and o.outlet_id=outlet and (after_time is null or (o.created_at,o.id)>(after_time,after_id))
    order by o.created_at,o.id limit page_size+1
  ), sized as (
    select *,row_number() over(order by created_at,id) as n,sum(weight) over(order by created_at,id) as bytes from candidates
  ), page as (
    select * from sized where n<=page_size and (n=1 or bytes<=4194304) order by created_at,id
  )
  select coalesce(array_agg(p.id order by p.created_at,p.id),'{}'::public.ulid[]),
    (select jsonb_build_object('createdAt',x.created_at,'id',x.id) from page x order by x.created_at desc,x.id desc limit 1),
    (select count(*) from candidates)>(select count(*) from page) into selected,cursor,more from page p;
  return jsonb_build_object('v',1,'access',actor,'outletNameJson',s.name::text,'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,
    'warningMinutes',2,'watermark',watermark,'orders',private.kitchen_read_rows(business,outlet,selected),'next',case when more then cursor else null end)
    from public.outlets s where s.business_id=business and s.id=outlet;
end $$;

create function private.read_kitchen_changes(device_secret text,session_secret text,after_seq bigint,until_seq bigint,page_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; business public.ulid; outlet public.ulid; high bigint; selected public.ulid[]; last_seq bigint; more boolean; removed jsonb;
begin
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' then return null;end if;
  business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;
  select coalesce(max(c.seq),0) into high from private.kitchen_changes c where c.business_id=business and c.outlet_id=outlet;
  if after_seq is null or after_seq<0 or after_seq>high or until_seq is not null and (until_seq<after_seq or until_seq>high) or
    page_size is null or page_size not between 1 and 100 then raise invalid_parameter_value using message='Use the original kitchen cursor.';end if;
  high:=coalesce(until_seq,high);
  with candidates as materialized (
    select c.seq,c.order_id,coalesce(2*octet_length(o.lines::text)+2*octet_length(o.table_label::text)+2048,128) as weight
    from private.kitchen_changes c left join public.orders o on o.business_id=c.business_id and o.outlet_id=c.outlet_id and o.id=c.order_id
    where c.business_id=business and c.outlet_id=outlet and c.seq>after_seq and c.seq<=high order by c.seq limit page_size+1
  ), sized as (
    select *,row_number() over(order by seq) as n,sum(weight) over(order by seq) as bytes from candidates
  ), page as (
    select * from sized where n<=page_size and (n=1 or bytes<=4194304) order by seq
  )
  select coalesce(array_agg(distinct p.order_id),'{}'::public.ulid[]),max(p.seq),
    (select count(*) from candidates)>(select count(*) from page) into selected,last_seq,more from page p;
  select coalesce(jsonb_agg(x order by x),'[]'::jsonb) into removed from unnest(selected) x where
    not exists(select 1 from public.orders o where o.business_id=business and o.outlet_id=outlet and o.id=x);
  return jsonb_build_object('v',1,'access',actor,'outletNameJson',s.name::text,'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,
    'warningMinutes',2,'watermark',high,'nextSeq',case when more then last_seq else high end,
    'orders',private.kitchen_read_rows(business,outlet,selected),'removed',removed)
    from public.outlets s where s.business_id=business and s.id=outlet;
end $$;

create index kitchen_ack_content_idx on private.kitchen_action_receipts(business_id,outlet_id,order_id,(action->>'contentHash'),accepted_at desc,id desc)
  where action->>'type'='kitchen.acknowledge';
create function private.read_kitchen_acknowledgements(device_secret text,session_secret text,sources jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; results jsonb;
begin
  actor:=private.read_device_session(device_secret,session_secret);
  if actor is null or not actor->'permissions' ? 'orders.read' then return null;end if;
  if jsonb_typeof(sources) is distinct from 'array' then raise invalid_parameter_value using message='Use complete original kitchen sources.';end if;
  if jsonb_array_length(sources)>100 or exists(select 1 from jsonb_array_elements(sources) s where
    jsonb_typeof(s) is distinct from 'object' or not s ?& array['orderId','contentHash','revision'] or s-array['orderId','contentHash','revision']<>'{}'::jsonb or
    jsonb_typeof(s->'orderId') is distinct from 'string' or s->>'orderId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or
    jsonb_typeof(s->'contentHash') is distinct from 'string' or s->>'contentHash'!~'^[0-9a-f]{64}$' or
    jsonb_typeof(s->'revision') is distinct from 'number' or (s->>'revision')::numeric not between 1 and 9007199254740991 or
    (s->>'revision')::numeric<>trunc((s->>'revision')::numeric)) or
    (select count(*)<>count(distinct s->>'orderId') from jsonb_array_elements(sources) s) then raise invalid_parameter_value using message='Use complete original kitchen sources.';end if;
  select coalesce(jsonb_agg(jsonb_build_object('orderId',s->>'orderId','contentHash',s->>'contentHash','receipt',r.receipt) order by s->>'orderId'),'[]'::jsonb)
    into results from jsonb_array_elements(sources) s left join lateral (
      select x.receipt from private.kitchen_action_receipts x where x.business_id=actor->>'businessId' and x.outlet_id=actor->>'outletId'
        and x.order_id=s->>'orderId' and x.action->>'type'='kitchen.acknowledge' and x.action->>'contentHash'=s->>'contentHash'
        and (x.receipt->>'revision')::bigint<=(s->>'revision')::bigint order by x.accepted_at desc,x.id desc limit 1
    ) r on true;
  return jsonb_build_object('v',1,'access',actor,'at',floor(extract(epoch from statement_timestamp())*1000)::bigint,'entries',results);
end $$;

revoke all on function private.read_kitchen_page(text,text,public.utc_ms,public.ulid,integer),private.read_kitchen_changes(text,text,bigint,bigint,integer),
  private.read_kitchen_acknowledgements(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.read_kitchen_page(text,text,public.utc_ms,public.ulid,integer),private.read_kitchen_changes(text,text,bigint,bigint,integer),
  private.read_kitchen_acknowledgements(text,text,jsonb) to service_role;

create function public.read_kitchen_page(p_device_token text,p_session_token text,p_after_time public.utc_ms default null,p_after_id public.ulid default null,p_limit integer default 50) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$begin
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]',true);
  return private.read_kitchen_page(p_device_token,p_session_token,p_after_time,p_after_id,p_limit);end $$;
create function public.read_kitchen_changes(p_device_token text,p_session_token text,p_after_seq bigint,p_until_seq bigint default null,p_limit integer default 50) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$begin
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]',true);
  return private.read_kitchen_changes(p_device_token,p_session_token,p_after_seq,p_until_seq,p_limit);end $$;
create function public.read_kitchen_acknowledgements(p_device_token text,p_session_token text,p_sources jsonb) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$begin
  perform set_config('response.headers','[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]',true);
  return private.read_kitchen_acknowledgements(p_device_token,p_session_token,p_sources);end $$;
revoke all on function public.read_kitchen_page(text,text,public.utc_ms,public.ulid,integer),public.read_kitchen_changes(text,text,bigint,bigint,integer),
  public.read_kitchen_acknowledgements(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_kitchen_page(text,text,public.utc_ms,public.ulid,integer),public.read_kitchen_changes(text,text,bigint,bigint,integer),
  public.read_kitchen_acknowledgements(text,text,jsonb) to service_role;
