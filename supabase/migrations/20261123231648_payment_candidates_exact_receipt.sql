-- Only the sale actually referenced by the current paid order can appear.
-- Retained or inconsistent older sales cannot duplicate or bypass that receipt.
create or replace function private.read_payment_candidates(outlet public.ulid,payment public.ulid,expected_fingerprint text,
 after_at public.utc_ms default null,after_kind text default null,after_id public.ulid default null,page_size integer default 20) returns json
language plpgsql stable security definer set search_path='' as $$
declare scope jsonb;source json;rows json;cursor json;more boolean;business public.ulid;
begin
 scope:=private.owner_task_access(outlet);business:=(scope->>'businessId')::public.ulid;
 if expected_fingerprint is null or expected_fingerprint!~'^[a-f0-9]{64}$' or page_size is null or page_size not between 1 and 50
  or not coalesce((after_at is null and after_kind is null and after_id is null or after_at is not null and after_kind in('order','sale','credit') and after_id is not null),false)
 then raise invalid_parameter_value using message='Read a complete current receipt page.';end if;
 if not exists(select 1 from private.payment_sources d where d.payment_id=payment and d.business_id=business and d.outlet_id=outlet)
 then raise insufficient_privilege using message='This payment source is unavailable.';end if;
 source:=private.payment_source_projection(payment);
 if source->>'fingerprint' is distinct from expected_fingerprint then raise sqlstate 'PT409' using message='Check the current payment source before choosing a receipt.';end if;
 with recorded as materialized ((
  select s.created_at as at,s.id as financial_id,case when s.order_id is null then 'sale' else 'order' end kind,
   c.target
  from public.sales s cross join lateral(select private.payment_match_target(business,outlet,case when s.order_id is null then 'sale' else 'order' end,coalesce(s.order_id,s.id)) target offset 0) c
  where s.business_id=business and s.outlet_id=outlet and s.amount=(source->>'amount')::bigint and s.currency=source->>'currency'
   and s.method=source->>'method' and s.voided_at is null and s.method<>'credit' and s.closing_id is null
   and private.confirmation_json_equal(s.method_name,(source->>'methodNameJson')::json)
   and (after_at is null or(s.created_at,case when s.order_id is null then 'sale' else 'order' end,s.id)<(after_at,after_kind,after_id))
   and not exists(select 1 from private.payment_source_states m where m.financial_kind='sale' and m.financial_id=s.id and m.payment_id<>payment)
   and c.target is not null and c.target->>'financialId'=s.id::text order by s.created_at desc,kind desc,s.id desc limit page_size+1)
  union all
  (select e.created_at,e.id,'credit',c.target from public.credit_entries e
   cross join lateral(select private.payment_match_target(business,outlet,'credit',e.id) target offset 0) c
  where e.business_id=business and e.outlet_id=outlet and e.amount=(source->>'amount')::bigint and e.currency=source->>'currency'
   and e.type='payment' and e.reversal_of is null and private.confirmation_json_equal(e.method_name,(source->>'methodNameJson')::json)
   and(case when private.confirmation_json_equal(e.method_name,'"Cash"'::json) then 'cash' when private.confirmation_json_equal(e.method_name,'"Card"'::json) then 'card' else 'wallet' end)=source->>'method'
   and (after_at is null or(e.created_at,'credit',e.id)<(after_at,after_kind,after_id))
   and not exists(select 1 from private.payment_source_states m where m.financial_kind='credit' and m.financial_id=e.id and m.payment_id<>payment)
   and c.target is not null order by e.created_at desc,e.id desc limit page_size+1)
 ), candidates as materialized (
  select * from recorded order by at desc,kind desc,financial_id desc limit page_size+1
 ), page as materialized(select * from candidates order by at desc,kind desc,financial_id desc limit page_size)
 select (select coalesce(json_agg(p.target order by p.at desc,p.kind desc,p.financial_id desc),'[]'::json) from page p),
  (select json_build_object('at',p.at,'kind',p.kind,'id',p.financial_id) from page p order by p.at,p.kind,p.financial_id limit 1),
  (select count(*) from candidates)>page_size into rows,cursor,more;
 return json_build_object('v',1,'access',scope,'at',floor(extract(epoch from clock_timestamp())*1000)::bigint,'source',source,'targets',rows,'next',case when more then cursor else null end);
end $$;
