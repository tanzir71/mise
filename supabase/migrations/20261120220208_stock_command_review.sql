-- Validate the same complete stock plans as ordinary delivery.
create function private.stock_review_plan_valid(kind text,ids jsonb,command_id public.ulid) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb;n int;created_ids int;
begin
 if command_id is null or kind is null or kind not in ('stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch')
  or jsonb_typeof(ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(ids))<>5
  or exists(select 1 from jsonb_object_keys(ids) k where k not in ('rows','batchId','undoMoveId','supplierId','nameKey'))
  or jsonb_typeof(ids->'rows') is distinct from 'array' or jsonb_array_length(ids->'rows') not between 1 and 1000
  or exists(select 1 from jsonb_each(ids) e where e.key not in ('rows','nameKey') and e.value<>'null' and (jsonb_typeof(e.value)<>'string' or e.value#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
  or (ids->>'nameKey' is not null and (jsonb_typeof(ids->'nameKey')<>'string' or octet_length(ids->>'nameKey')>16000)) then return false;end if;
 n:=jsonb_array_length(ids->'rows');
 if (kind<>'stock.batch' and n<>1) or ((kind='stock.undo')<>(ids->>'undoMoveId' is not null))
  or (kind<>'stock.batch' and ids->>'batchId' is not null) or (kind not in ('stock.create','stock.update') and (ids->>'nameKey' is not null or ids->>'supplierId' is not null))
  or ids->'rows'->0->>'eventId' is distinct from command_id::text then return false;end if;
 for r in select x from jsonb_array_elements(ids->'rows') x loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>7 or exists(select 1 from jsonb_object_keys(r) k where k not in ('itemId','revision','eventId','moveId','reason','quantity','source'))
   or exists(select 1 from unnest(array['itemId','eventId']) k where r->>k is null or jsonb_typeof(r->k)<>'string' or r->>k!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
   or (r->>'moveId' is not null and (jsonb_typeof(r->'moveId')<>'string' or r->>'moveId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
   or jsonb_typeof(r->'revision')<>'number' or (r->>'revision')::numeric<>trunc((r->>'revision')::numeric) or (r->>'revision')::numeric not between (case when kind='stock.create' then 0 else 1 end) and 9007199254740990
   or (kind='stock.create' and (r->>'revision')::numeric<>0)
   or (r->>'moveId' is null and (kind not in ('stock.update','stock.archive','stock.restore') or r->>'reason' is not null or r->>'quantity' is not null or r->>'source' is not null))
   or (r->>'moveId' is not null and (r->>'reason' is null or r->>'reason' not in ('count','used','received','waste','undo') or r->>'source' is null or r->>'source' not in ('manual','quick_update','count')))
   or (kind in ('stock.archive','stock.restore') and r->>'moveId' is not null)
   or (kind in ('stock.create','stock.update') and r->>'moveId' is not null and (r->>'reason'<>'count' or r->>'source'<>'manual'))
   or (kind='stock.undo' and (r->>'moveId' is null or r->>'reason'<>'undo' or r->>'source'<>'manual' or r->>'quantity' is not null))
   or (kind<>'stock.undo' and r->>'reason'='undo')
   or (kind in ('stock.adjust','stock.batch','stock.create') and r->>'moveId' is null)
   or (r->>'moveId' is not null and kind<>'stock.undo' and (jsonb_typeof(r->'quantity') is distinct from 'number' or (r->>'quantity')::public.stock_quantity<0 or (r->>'reason'<>'count' and (r->>'quantity')::numeric=0)))
   or (ids->>'batchId' is not null and (r->>'reason'<>'count' or r->>'source'<>'count')) then return false;end if;
 end loop;
 select count(*) into created_ids from (select x->>'eventId' id from jsonb_array_elements(ids->'rows') x union all select x->>'moveId' from jsonb_array_elements(ids->'rows') x where x->>'moveId' is not null union all select ids->>'batchId' where ids->>'batchId' is not null) a;
 if (select count(distinct x->>'itemId') from jsonb_array_elements(ids->'rows') x)<>n
  or created_ids<>(select count(distinct id) from (select x->>'eventId' id from jsonb_array_elements(ids->'rows') x union all select x->>'moveId' from jsonb_array_elements(ids->'rows') x where x->>'moveId' is not null union all select ids->>'batchId' where ids->>'batchId' is not null) a)
  or exists(select 1 from jsonb_array_elements(ids->'rows') a join jsonb_array_elements(ids->'rows') b on a->>'itemId' in (b->>'eventId',b->>'moveId'))
  or exists(select 1 from jsonb_array_elements(ids->'rows') a where a->>'itemId'=ids->>'batchId' or ids->>'undoMoveId' in(a->>'eventId',a->>'moveId')) then return false;end if;
 return true;
exception when invalid_text_representation or check_violation or numeric_value_out_of_range or invalid_parameter_value then return false;
end $$;

-- Explicit stock reviews retain the whole original action, recorded units,
-- original count/movement identities and physical time. No anonymous access.
create table private.stock_review_tickets (
 id public.ulid primary key,command_id public.ulid not null,replacement_id public.ulid not null,
 business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,auth_user_id uuid not null,
 type text not null check(type in ('stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch')),
 original_hash text not null check(original_hash~'^[0-9a-f]{64}$'),source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),
 plan jsonb not null,unit_facts jsonb not null,original_intent text not null,source_json text not null,occurred_at public.utc_ms not null,
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null,
 check(id<>command_id and id<>replacement_id and command_id<>replacement_id),check(octet_length(original_intent)<=8000000 and octet_length(source_json)<=4000000)
);
create index stock_review_tickets_actor_idx on private.stock_review_tickets(auth_user_id,expires_at);
create table private.stock_command_resolutions (
 id public.ulid primary key,command_id public.ulid not null unique,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,original_hash text not null,source_hash text not null,original_intent text not null,source_json text not null,
 plan jsonb not null,unit_facts jsonb not null,stock_item_ids public.ulid[] not null,
 outcome text not null check(outcome in ('withdrawn','replaced')),replacement_id public.ulid,reserved_ids public.ulid[] not null,receipt jsonb not null,created_at public.utc_ms not null,
 position bigint generated always as identity unique,check((outcome='withdrawn')=(replacement_id is null))
);
create index stock_command_resolutions_reserved_idx on private.stock_command_resolutions using gin(reserved_ids);
create index stock_command_resolutions_items_idx on private.stock_command_resolutions using gin(stock_item_ids);
alter table private.stock_review_tickets enable row level security;
alter table private.stock_review_tickets force row level security;
alter table private.stock_command_resolutions enable row level security;
alter table private.stock_command_resolutions force row level security;
revoke all on private.stock_review_tickets,private.stock_command_resolutions from public,anon,authenticated,service_role;
revoke all on sequence private.stock_command_resolutions_position_seq from public,anon,authenticated,service_role;

create function private.stock_review_new_ids(kind text,ids jsonb,command_id public.ulid) returns public.ulid[]
language sql immutable security invoker set search_path='' as $$
 select array_agg(distinct id::public.ulid) from (
  select command_id::text id union all select x->>'eventId' from jsonb_array_elements(ids->'rows') x
  union all select x->>'moveId' from jsonb_array_elements(ids->'rows') x where x->>'moveId' is not null
  union all select ids->>'batchId' where ids->>'batchId' is not null
  union all select ids->'rows'->0->>'itemId' where kind='stock.create') s
$$;
create function private.assert_stock_resolution_access(command_id public.ulid,kind text,ids jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from private.stock_command_resolutions r where r.command_id=assert_stock_resolution_access.command_id or r.reserved_ids&&private.stock_review_new_ids(kind,ids,assert_stock_resolution_access.command_id)) then
  raise sqlstate 'PT409' using message='Keep the original stock resolution and reserved identities.';end if;
end $$;
create function private.reject_resolved_stock_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Upserts of an existing scoped item remain available. Its event changes on
 -- every write; using a fixed birth event here would wrongly block updates.
 if tg_table_name='stock_items' and exists(select 1 from public.stock_items s where s.id=new.id and s.business_id=new.business_id and s.outlet_id=new.outlet_id) then return new;end if;
 if exists(select 1 from private.stock_command_resolutions r where r.reserved_ids@>array[new.id]) then raise sqlstate 'PT409' using message='Keep the original resolved stock identities.';end if;
 return new;
end $$;
create trigger resolved_stock_item_identity before insert on public.stock_items for each row execute function private.reject_resolved_stock_identity();
create trigger resolved_stock_move_identity before insert on public.stock_moves for each row execute function private.reject_resolved_stock_identity();
create trigger resolved_stock_event_identity before insert on public.events for each row execute function private.reject_resolved_stock_identity();

create function private.stock_review_last_movement_resolution(business public.ulid,outlet public.ulid,item public.ulid) returns bigint
language sql stable security invoker set search_path='' as $$
 select r.position from private.stock_command_resolutions r where r.business_id=business and r.outlet_id=outlet and r.stock_item_ids@>array[item]
  and exists(select 1 from jsonb_array_elements(r.plan->'rows') p where p->>'itemId'=item::text and p->>'moveId' is not null)
 order by r.position desc limit 1
$$;
create function private.stock_review_state(business public.ulid,outlet public.ulid,kind text,ids jsonb,command_id public.ulid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare valid boolean:=true;context json;active_keys jsonb;supplier_names text;
begin
 if kind='stock.create' then
  if exists(select 1 from public.stock_items s where s.id=ids->'rows'->0->>'itemId') then valid:=false;end if;
 elsif (select count(*) from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.id in(select p->>'itemId' from jsonb_array_elements(ids->'rows') p))<>jsonb_array_length(ids->'rows') then valid:=false;
 end if;
 if ids->>'supplierId' is not null and not exists(select 1 from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=ids->>'supplierId' and s.archived_at is null) then valid:=false;end if;
 if kind='stock.undo' and not exists(select 1 from public.stock_moves m where m.business_id=business and m.outlet_id=outlet and m.id=ids->>'undoMoveId' and m.stock_item_id=ids->'rows'->0->>'itemId') then valid:=false;end if;
 context:=private.stock_write_context(business,outlet,ids);
 -- Keep names as opaque JSON text: legitimate names can contain code units
 -- that JSONB cannot decode. Only the saved and actual current selections fit.
 supplier_names:=case when kind in('stock.create','stock.update') then (select coalesce(json_agg(json_build_object('id',s.id,'name',s.name,'archived',s.archived_at is not null) order by s.id),'[]')::text from public.suppliers s where s.business_id=business and s.outlet_id=outlet and (s.id=ids->>'supplierId' or s.id in(select item.supplier_id from public.stock_items item where item.business_id=business and item.outlet_id=outlet and item.id=ids->'rows'->0->>'itemId'))) else '[]' end;
 active_keys:=case when kind='stock.restore' then (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'key',s.active_key::text) order by s.id),'[]') from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.archived_at is null) else '[]'::jsonb end;
 return jsonb_build_object('contextJson',context::text,'suppliersJson',supplier_names,'activeKeys',active_keys,'selectionValid',valid,
  'reserved',exists(select 1 from private.stock_command_resolutions r where r.reserved_ids&&private.stock_review_new_ids(kind,ids,stock_review_state.command_id)),
  'resolutionState',(select jsonb_agg(jsonb_build_object('itemId',p.value->>'itemId','position',private.stock_review_last_movement_resolution(business,outlet,(p.value->>'itemId')::public.ulid)::text) order by p.ordinality) from jsonb_array_elements(ids->'rows') with ordinality p));
end $$;
create function private.stock_review_replacement_plan(kind text,ids jsonb,replacement_id public.ulid,business public.ulid,outlet public.ulid) returns jsonb
language sql volatile security invoker set search_path='' as $$
 select jsonb_set(ids,'{rows}',(select jsonb_agg(p.value||jsonb_build_object('revision',case when kind='stock.create' then 0 else s.revision end,'eventId',case when p.ordinality=1 then replacement_id::text else p.value->>'eventId' end) order by p.ordinality)
 from jsonb_array_elements(ids->'rows') with ordinality p left join public.stock_items s on s.business_id=business and s.outlet_id=outlet and s.id=p.value->>'itemId'))
$$;
create function private.assert_stock_movement_review(ticket_id public.ulid) returns void
language plpgsql security invoker set search_path='' as $$
declare t private.stock_write_tickets;at_ms public.utc_ms;
begin
 select * into t from private.stock_write_tickets s where s.id=ticket_id;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 -- A later offline count can coincidentally hold the same current revision.
 -- An unresolved withdrawal therefore requires a deliberate movement review,
 -- rather than incrementing revisions or inventing a physical count.
 if exists(select 1 from jsonb_array_elements(t.plan->'rows') p join private.stock_command_resolutions r on r.position=private.stock_review_last_movement_resolution(t.business_id,t.outlet_id,(p->>'itemId')::public.ulid) where p->>'moveId' is not null and r.outcome='withdrawn')
 and not exists(select 1 from private.stock_review_tickets review where review.replacement_id=t.command_id and review.business_id=t.business_id and review.outlet_id=t.outlet_id and review.actor_id=t.actor_id and review.auth_user_id=t.auth_user_id and review.type=t.type and review.expires_at>at_ms
  and private.stock_review_replacement_plan(review.type,review.plan,review.replacement_id,review.business_id,review.outlet_id)=t.plan
  and current_setting('mise.stock_review_completion',true)=review.id::text||':'||encode(review.token_hash,'hex')) then
  raise sqlstate 'PT409' using message='Review the withdrawn stock movement and current quantities.';end if;
end $$;

create function private.inspect_stock_outcome(command_id public.ulid,kind text,outlet public.ulid,fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;r private.shop_command_receipts;
begin
 if command_id is null or outlet is null or kind is null or kind not in ('stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch') or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Keep the original stock identity.';end if;
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);
 select * into r from private.shop_command_receipts x where x.id=command_id;
 if not found then return null;end if;
 if r.business_id<>business or r.outlet_id<>outlet or r.actor_id<>actor or r.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This stock action is unavailable.';end if;
 if r.type<>kind or r.request_hash<>fingerprint then raise sqlstate 'PT409' using message='Keep the original stock identity.';end if;
 return r.receipt;
end $$;
create function private.prepare_stock_review(review_id public.ulid,replacement_id public.ulid,command_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms,intent_json text,source_hash text,source_json text,unit_facts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old jsonb;t private.stock_review_tickets;state jsonb;secret text;at_ms public.utc_ms;lock_id text;
begin
 if (select auth.uid()) is null or review_id is null or replacement_id is null or command_id is null or outlet is null or occurred is null or review_id=command_id or review_id=replacement_id or command_id=replacement_id
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or source_hash is null or source_hash!~'^[0-9a-f]{64}$' or intent_json is null or octet_length(intent_json)>8000000 or source_json is null or octet_length(source_json)>4000000
  or review_id=outlet or replacement_id=outlet or private.stock_review_plan_valid(kind,ids,command_id) is not true or encode(sha256(convert_to(intent_json,'UTF8')),'hex')<>fingerprint
  or exists(select 1 from unnest(array[review_id,replacement_id]) x where x=any(private.stock_review_new_ids(kind,ids,command_id)) or x::text in(ids->>'supplierId',ids->>'undoMoveId') or exists(select 1 from jsonb_array_elements(ids->'rows') p where p->>'itemId'=x::text))
 then raise invalid_parameter_value using message='Keep the complete original stock action and source.';end if;
 if jsonb_typeof(unit_facts) is distinct from 'array' or jsonb_array_length(unit_facts)<>jsonb_array_length(ids->'rows') then raise invalid_parameter_value using message='Keep every original stock unit.';end if;
 if exists(select 1 from jsonb_array_elements(unit_facts) with ordinality f where jsonb_typeof(f.value)<>'object' or (select count(*) from jsonb_object_keys(f.value))<>5
  or exists(select 1 from jsonb_object_keys(f.value) k where k not in('itemId','unitKey','createdAt','undoEventId','undoDelta')) or f.value->>'itemId' is distinct from ids->'rows'->(f.ordinality::int-1)->>'itemId'
  or jsonb_typeof(f.value->'unitKey') is distinct from 'string' or octet_length(f.value->>'unitKey') not between 3 and 512
  or jsonb_typeof(f.value->'createdAt') is distinct from 'number' or (f.value->>'createdAt')::numeric not between 0 and 8640000000000000 or (f.value->>'createdAt')::numeric<>trunc((f.value->>'createdAt')::numeric)
  or kind='stock.create' and (f.value->>'createdAt')::bigint<>occurred
  or kind<>'stock.undo' and (f.value->>'undoEventId' is not null or f.value->>'undoDelta' is not null)
  or kind='stock.undo' and (f.value->>'undoEventId' is null or f.value->>'undoEventId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or jsonb_typeof(f.value->'undoDelta') is distinct from 'number' or abs((f.value->>'undoDelta')::numeric)>1000000000 or (f.value->>'undoDelta')::numeric*1000<>trunc((f.value->>'undoDelta')::numeric*1000))) then raise invalid_parameter_value using message='Keep the original stock unit and source identity.';end if;
 old:=private.inspect_stock_outcome(command_id,kind,outlet,fingerprint);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 select o.business_id into business from public.outlets o where o.id=outlet;actor:=private.public_link_actor(business,outlet);
 for lock_id in select x from unnest(array[command_id::text,replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform 1 from public.businesses b where b.id=business for share;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 old:=private.inspect_stock_outcome(command_id,kind,outlet,fingerprint);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 if exists(select 1 from private.command_receipts r where r.id=command_id) or exists(select 1 from public.events e where e.id=command_id or e.id=review_id or e.id=replacement_id) then raise sqlstate 'PT409' using message='Keep the original stock identity.';end if;
 select * into t from private.stock_review_tickets r where r.id=review_id;
 if found and (t.command_id<>command_id or t.replacement_id<>replacement_id or t.auth_user_id<>(select auth.uid()) or t.actor_id<>actor or t.original_hash<>fingerprint or t.source_hash<>source_hash or t.source_json<>source_json or t.plan<>ids or t.unit_facts<>unit_facts or t.original_intent<>intent_json or t.occurred_at<>occurred) then raise sqlstate 'PT409' using message='Keep the original selected stock review.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from private.stock_review_tickets r where r.auth_user_id=(select auth.uid()) and (r.expires_at<=at_ms or r.id=review_id);
 if (select count(*) from private.stock_review_tickets r where r.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Finish an existing stock review first.';end if;
 state:=private.stock_review_state(business,outlet,kind,ids,command_id);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.stock_review_tickets values(review_id,command_id,replacement_id,business,outlet,actor,(select auth.uid()),kind,fingerprint,source_hash,ids,unit_facts,intent_json,source_json,occurred,sha256(convert_to(state::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+120000);
 return jsonb_build_object('done',false,'id',review_id,'replacementId',replacement_id,'commandId',command_id,'type',kind,'occurredAt',occurred,'businessId',business,'outletId',outlet,'actorId',actor,'commandHash',fingerprint,'sourceHash',source_hash,'sourceJsonHash',encode(sha256(convert_to(source_json,'UTF8')),'hex'),'unitFacts',unit_facts,'plan',ids,'token',secret,'at',at_ms,'expiresAt',at_ms+120000,'stateJson',state::text);
end $$;
create function private.read_stock_review(review_id public.ulid,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.stock_review_tickets;old jsonb;state jsonb;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise insufficient_privilege using message='Review this stock action with its original account.';end if;
 select * into t from private.stock_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current stock values again.';end if;
 if t.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='Use the original phone account.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 old:=private.inspect_stock_outcome(t.command_id,t.type,t.outlet_id,t.original_hash);
 if old is not null then return jsonb_build_object('done',true,'receipt',old);end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 state:=private.stock_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 if t.expires_at<=at_ms or sha256(convert_to(state::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed stock values changed. Review them again.';end if;
 return jsonb_build_object('done',false,'id',t.id,'replacementId',t.replacement_id,'commandId',t.command_id,'type',t.type,'occurredAt',t.occurred_at,'businessId',t.business_id,'outletId',t.outlet_id,'actorId',t.actor_id,'commandHash',t.original_hash,'sourceHash',t.source_hash,'sourceJsonHash',encode(sha256(convert_to(t.source_json,'UTF8')),'hex'),'unitFacts',t.unit_facts,'plan',t.plan,'token',secret,'at',t.created_at,'expiresAt',t.expires_at,'stateJson',state::text);
end $$;

create function private.finish_stock_review(review_id public.ulid,secret text,outcome text,replacement_ticket public.ulid,replacement_secret text,replacement_hash text,replacement_records jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t private.stock_review_tickets;n private.stock_write_tickets;old private.shop_command_receipts;state jsonb;after_state jsonb;expected_plan jsonb;at_ms public.utc_ms;metadata jsonb;applied jsonb;lock_id text;revisions jsonb;resolution_position bigint;
begin
 if outcome is null or outcome not in ('withdrawn','replaced') or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise invalid_parameter_value using message='Choose the reviewed stock outcome.';end if;
 select * into t from private.stock_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Review the current stock values again.';end if;
 for lock_id in select x from unnest(array[t.command_id::text,t.replacement_id::text]) x order by x loop perform pg_advisory_xact_lock(hashtextextended(lock_id,0));end loop;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.businesses b where b.id=t.business_id for share;
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 select * into old from private.shop_command_receipts r where r.id=t.command_id;
 if found then
  if old.business_id<>t.business_id or old.outlet_id<>t.outlet_id or old.actor_id<>t.actor_id or old.auth_user_id<>t.auth_user_id or old.type<>t.type or old.request_hash<>t.original_hash then raise sqlstate 'PT409' using message='Keep the original stock receipt.';end if;
  return old.receipt;
 end if;
 select * into t from private.stock_review_tickets r where r.id=review_id and r.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Review the current stock values again.';end if;
 state:=private.stock_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 if sha256(convert_to(state::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The reviewed stock values changed. Review them again.';end if;
 if exists(select 1 from private.command_receipts r where r.id=t.command_id) or exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Keep the original stock identity.';end if;
 if outcome='withdrawn' then
  if replacement_ticket is not null or replacement_secret is not null or replacement_hash is not null or replacement_records is not null and replacement_records<>'null'::jsonb then raise invalid_parameter_value using message='A withdrawal cannot record a replacement stock movement.';end if;
 else
  if (state->>'selectionValid')::boolean is not true or (state->>'reserved')::boolean is true then raise sqlstate 'PT409' using message='Keep the original stock source and items.';end if;
  expected_plan:=private.stock_review_replacement_plan(t.type,t.plan,t.replacement_id,t.business_id,t.outlet_id);
  select * into n from private.stock_write_tickets r where r.id=replacement_ticket and r.token_hash=sha256(convert_to(replacement_secret,'UTF8'));
  if not found or n.command_id<>t.replacement_id or n.business_id<>t.business_id or n.outlet_id<>t.outlet_id or n.actor_id<>t.actor_id or n.auth_user_id<>t.auth_user_id or n.type<>t.type or n.occurred_at<>t.occurred_at or n.request_hash<>replacement_hash
   or n.snapshot_hash<>sha256(convert_to(state->>'contextJson','UTF8')) or n.plan<>expected_plan then raise invalid_parameter_value using message='Keep the exact reviewed stock identities and revisions.';end if;
  if exists(select 1 from jsonb_array_elements(t.unit_facts) f left join public.stock_items s on s.business_id=t.business_id and s.outlet_id=t.outlet_id and s.id=f->>'itemId'
   where t.type<>'stock.create' and (s.id is null or s.created_at is distinct from (f->>'createdAt')::bigint or s.unit::text is distinct from f->>'unitKey')) then raise sqlstate 'PT409' using message='Keep the original stock unit and item identity.';end if;
  if t.type='stock.undo' and not exists(select 1 from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.id=t.plan->>'undoMoveId' and m.stock_item_id=t.unit_facts->0->>'itemId' and m.unit::text=t.unit_facts->0->>'unitKey' and m.event_id::text=t.unit_facts->0->>'undoEventId' and m.delta=-(t.unit_facts->0->>'undoDelta')::numeric) then raise sqlstate 'PT409' using message='Keep the exact original movement being undone.';end if;
  if replacement_records is null or jsonb_typeof(replacement_records) is distinct from 'array'
   or (select count(*) from jsonb_array_elements(replacement_records) item where item->>'table'='stock_items')<>jsonb_array_length(t.plan->'rows')
   or exists(select 1 from jsonb_array_elements(replacement_records) item left join jsonb_array_elements(t.unit_facts) f on f->>'itemId'=item->'values'->>'id' where item->>'table'='stock_items' and (f is null or item->'values'->>'unit' is distinct from f->>'unitKey')) then raise sqlstate 'PT409' using message='Keep every original recorded stock unit.';end if;
  select jsonb_agg(jsonb_build_object('stockItemId',p.value->>'itemId','revision',(p.value->>'revision')::bigint) order by p.ordinality) into revisions from jsonb_array_elements(n.plan->'rows') with ordinality p;
  perform set_config('mise.stock_review_completion',t.id::text||':'||encode(t.token_hash,'hex'),true);
  applied:=private.finish_stock_write(replacement_ticket,replacement_secret,replacement_records);
  perform set_config('mise.stock_review_completion','',true);
 end if;
 metadata:=jsonb_build_object('id',t.id,'type','command.resolved','commandId',t.command_id,'commandType',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'commandHash',t.original_hash,'sourceHash',t.source_hash,'at',at_ms,'outcome',outcome,'replacement',case when outcome='withdrawn' then null else jsonb_build_object('id',t.replacement_id,'commandHash',n.request_hash,'revisions',revisions,'receipt',applied) end);
 after_state:=private.stock_review_state(t.business_id,t.outlet_id,t.type,t.plan,t.command_id);
 -- Publish the exact admitted ordering too, so offline canonical replay can
 -- enforce the same movement boundary when server clock milliseconds tie.
 resolution_position:=nextval('private.stock_command_resolutions_position_seq'::regclass);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,'sync.resolve',json_build_object('resolutionId',t.id,'commandId',t.command_id,'commandType',t.type,'commandHash',t.original_hash,'sourceHash',t.source_hash,'originalCommandJson',t.original_intent,'sourceJson',t.source_json,'stockBeforeJson',state->>'contextJson'),json_build_object('resolutionId',t.id,'outcome',outcome,'receipt',metadata,'replacementId',case when outcome='replaced' then t.replacement_id else null end,'stockAfterJson',after_state->>'contextJson','stockResolutionPosition',resolution_position::text),at_ms);
 insert into private.stock_command_resolutions(id,command_id,business_id,outlet_id,actor_id,auth_user_id,original_hash,source_hash,original_intent,source_json,plan,unit_facts,stock_item_ids,outcome,replacement_id,reserved_ids,receipt,created_at,position) overriding system value
 values(t.id,t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.original_hash,t.source_hash,t.original_intent,t.source_json,t.plan,t.unit_facts,array(select (p->>'itemId')::public.ulid from jsonb_array_elements(t.plan->'rows') p),outcome,case when outcome='replaced' then t.replacement_id else null end,private.stock_review_new_ids(t.type,t.plan,t.command_id),metadata,at_ms,resolution_position);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,t.original_hash,metadata);
 delete from private.stock_write_tickets r where r.command_id=t.command_id;
 return metadata;
end $$;

revoke all on function private.stock_review_plan_valid(text,jsonb,public.ulid),private.stock_review_new_ids(text,jsonb,public.ulid),private.assert_stock_resolution_access(public.ulid,text,jsonb),private.reject_resolved_stock_identity(),private.stock_review_last_movement_resolution(public.ulid,public.ulid,public.ulid),private.stock_review_state(public.ulid,public.ulid,text,jsonb,public.ulid),private.stock_review_replacement_plan(text,jsonb,public.ulid,public.ulid,public.ulid),private.assert_stock_movement_review(public.ulid) from public,anon,authenticated,service_role;
revoke all on function private.inspect_stock_outcome(public.ulid,text,public.ulid,text),private.prepare_stock_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,jsonb),private.read_stock_review(public.ulid,text),private.finish_stock_review(public.ulid,text,text,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.inspect_stock_outcome(public.ulid,text,public.ulid,text),private.prepare_stock_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,jsonb),private.read_stock_review(public.ulid,text) to authenticated;
grant execute on function private.finish_stock_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;
create function public.admit_stock_review(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_stock_batch(p_outlet_id)$$;
create function public.inspect_stock_outcome(p_command_id public.ulid,p_type text,p_outlet_id public.ulid,p_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.inspect_stock_outcome(p_command_id,p_type,p_outlet_id,p_hash)$$;
create function public.prepare_stock_review(p_id public.ulid,p_replacement_id public.ulid,p_command_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms,p_intent_json text,p_source_hash text,p_source_json text,p_unit_facts jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_stock_review(p_id,p_replacement_id,p_command_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at,p_intent_json,p_source_hash,p_source_json,p_unit_facts)$$;
create function public.read_stock_review(p_id public.ulid,p_token text) returns jsonb language sql security invoker set search_path='' as $$select private.read_stock_review(p_id,p_token)$$;
create function public.finish_stock_review(p_id public.ulid,p_token text,p_outcome text,p_replacement_ticket public.ulid,p_replacement_token text,p_replacement_hash text,p_replacement_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_stock_review(p_id,p_token,p_outcome,p_replacement_ticket,p_replacement_token,p_replacement_hash,p_replacement_records)$$;
revoke all on function public.admit_stock_review(public.ulid),public.inspect_stock_outcome(public.ulid,text,public.ulid,text),public.prepare_stock_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,jsonb),public.read_stock_review(public.ulid,text),public.finish_stock_review(public.ulid,text,text,public.ulid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admit_stock_review(public.ulid),public.inspect_stock_outcome(public.ulid,text,public.ulid,text),public.prepare_stock_review(public.ulid,public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,text,text,text,jsonb),public.read_stock_review(public.ulid,text) to authenticated;
grant execute on function public.finish_stock_review(public.ulid,text,text,public.ulid,text,text,jsonb) to service_role;


-- Keep the complete normal mutation and existing ACLs; add resolution guards.
create or replace function private.prepare_stock_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms)
returns jsonb language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;r jsonb;context json;secret text;at_ms public.utc_ms;n int;created_ids int;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This stock action is unavailable.';end if;
 if command_id is null or ticket_id is null or outlet is null or occurred is null or kind is null or kind not in ('stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch')
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or jsonb_typeof(ids) is distinct from 'object' or (select count(*) from jsonb_object_keys(ids))<>5
  or exists(select 1 from jsonb_object_keys(ids) k where k not in ('rows','batchId','undoMoveId','supplierId','nameKey'))
  or jsonb_typeof(ids->'rows') is distinct from 'array' or jsonb_array_length(ids->'rows') not between 1 and 1000
  or exists(select 1 from jsonb_each(ids) e where e.key not in ('rows','nameKey') and e.value<>'null' and (jsonb_typeof(e.value)<>'string' or e.value#>>'{}'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
  or (ids->>'nameKey' is not null and (jsonb_typeof(ids->'nameKey')<>'string' or octet_length(ids->>'nameKey')>16000)) then raise invalid_parameter_value using message='Check the stock intent.';end if;
 n:=jsonb_array_length(ids->'rows');
 if (kind<>'stock.batch' and n<>1) or ((kind='stock.undo')<>(ids->>'undoMoveId' is not null))
  or (kind<>'stock.batch' and ids->>'batchId' is not null) or (kind not in ('stock.create','stock.update') and (ids->>'nameKey' is not null or ids->>'supplierId' is not null))
  or ids->'rows'->0->>'eventId' is distinct from command_id::text then raise invalid_parameter_value using message='Check the stock plan.';end if;
 for r in select x from jsonb_array_elements(ids->'rows') x loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>7 or exists(select 1 from jsonb_object_keys(r) k where k not in ('itemId','revision','eventId','moveId','reason','quantity','source'))
   or exists(select 1 from unnest(array['itemId','eventId']) k where r->>k is null or jsonb_typeof(r->k)<>'string' or r->>k!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$')
   or (r->>'moveId' is not null and (jsonb_typeof(r->'moveId')<>'string' or r->>'moveId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'))
   or jsonb_typeof(r->'revision')<>'number' or (r->>'revision')::numeric<>trunc((r->>'revision')::numeric) or (r->>'revision')::numeric not between (case when kind='stock.create' then 0 else 1 end) and 9007199254740990
   or (kind='stock.create' and (r->>'revision')::numeric<>0)
   or (r->>'moveId' is null and (kind not in ('stock.update','stock.archive','stock.restore') or r->>'reason' is not null or r->>'quantity' is not null or r->>'source' is not null))
   or (r->>'moveId' is not null and (r->>'reason' is null or r->>'reason' not in ('count','used','received','waste','undo') or r->>'source' is null or r->>'source' not in ('manual','quick_update','count')))
   or (kind in ('stock.archive','stock.restore') and r->>'moveId' is not null)
   or (kind in ('stock.create','stock.update') and r->>'moveId' is not null and (r->>'reason'<>'count' or r->>'source'<>'manual'))
   or (kind='stock.undo' and (r->>'moveId' is null or r->>'reason'<>'undo' or r->>'source'<>'manual' or r->>'quantity' is not null))
   or (kind<>'stock.undo' and r->>'reason'='undo')
   or (kind in ('stock.adjust','stock.batch','stock.create') and r->>'moveId' is null)
   or (r->>'moveId' is not null and kind<>'stock.undo' and (jsonb_typeof(r->'quantity') is distinct from 'number' or (r->>'quantity')::public.stock_quantity<0 or (r->>'reason'<>'count' and (r->>'quantity')::numeric=0)))
   or (ids->>'batchId' is not null and (r->>'reason'<>'count' or r->>'source'<>'count')) then raise invalid_parameter_value using message='Check the stock row plan.';end if;
 end loop;
 select count(*) into created_ids from (select x->>'eventId' id from jsonb_array_elements(ids->'rows') x union all select x->>'moveId' from jsonb_array_elements(ids->'rows') x where x->>'moveId' is not null union all select ids->>'batchId' where ids->>'batchId' is not null) a;
 if (select count(distinct x->>'itemId') from jsonb_array_elements(ids->'rows') x)<>n
  or created_ids<>(select count(distinct id) from (select x->>'eventId' id from jsonb_array_elements(ids->'rows') x union all select x->>'moveId' from jsonb_array_elements(ids->'rows') x where x->>'moveId' is not null union all select ids->>'batchId' where ids->>'batchId' is not null) a)
  or exists(select 1 from jsonb_array_elements(ids->'rows') a join jsonb_array_elements(ids->'rows') b on a->>'itemId' in (b->>'eventId',b->>'moveId'))
  or exists(select 1 from jsonb_array_elements(ids->'rows') a where a->>'itemId'=ids->>'batchId' or ids->>'undoMoveId' in(a->>'eventId',a->>'moveId')) then raise invalid_parameter_value using message='Use distinct stock record IDs.';end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));
 select * into old from private.shop_command_receipts c where c.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This change is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='This command ID was already used.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select o.business_id into business from public.outlets o where o.id=outlet;
 if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 perform private.assert_stock_resolution_access(command_id,kind,ids);
 if exists(select 1 from public.events e where e.id=command_id) then raise unique_violation using message='This command ID was already used.';end if;
 if kind='stock.create' then
  if exists(select 1 from public.stock_items s where s.id=ids->'rows'->0->>'itemId') then raise unique_violation using message='This stock ID already exists.';end if;
 else
  if (select count(*) from public.stock_items s where s.business_id=business and s.outlet_id=outlet and s.id in(select x->>'itemId' from jsonb_array_elements(ids->'rows') x))<>n then raise insufficient_privilege using message='This stock is unavailable.';end if;
 end if;
 if ids->>'supplierId' is not null and not exists(select 1 from public.suppliers s where s.business_id=business and s.outlet_id=outlet and s.id=ids->>'supplierId') then raise insufficient_privilege using message='This supplier is unavailable.';end if;
 if kind='stock.undo' and not exists(select 1 from public.stock_moves m where m.business_id=business and m.outlet_id=outlet and m.stock_item_id=ids->'rows'->0->>'itemId' and m.id=ids->>'undoMoveId') then raise insufficient_privilege using message='This movement is unavailable.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 delete from private.stock_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.stock_write_tickets t where t.command_id=prepare_stock_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>ids)) then raise unique_violation using message='Keep the original stock intent.';end if;
 delete from private.stock_write_tickets t where t.command_id=prepare_stock_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.stock_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.stock_write_context(business,outlet,ids);
 secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.stock_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids,occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create or replace function private.finish_stock_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.stock_write_tickets;r jsonb;v jsonb;p jsonb;item_values jsonb;table_name text;allowed jsonb;keys text;casts text;updates text;
 old_items public.stock_items[];before public.stock_items;original public.stock_moves;at_ms public.utc_ms;expected_quantity numeric;expected_counted bigint;expected_command text;
 n int;item_count int;move_count int;event_count int;metadata jsonb;plans jsonb;item_records jsonb;count_barriers jsonb;
 specs jsonb:='{"stock_items":["id","created_at","updated_at","outlet_id","revision","name","name_local","active_key","unit","category","aliases","on_hand","target","pack_size","low_at","supplier_id","archived_at","last_counted_at","event_id","business_id"],"stock_moves":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","stock_item_id","name","unit","before_quantity","after_quantity","delta","reason","source","note","count_batch_id","undo_of","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if ticket_id is null or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then raise sqlstate 'PT409' using message='Prepare this stock change again.';end if;
 select * into t from private.stock_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8'));
 if not found then raise sqlstate 'PT409' using message='Prepare this stock change again.';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.command_id::text,0));perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 select * into t from private.stock_write_tickets x where x.id=ticket_id and x.token_hash=sha256(convert_to(secret,'UTF8')) for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not found or t.expires_at<=at_ms then raise sqlstate 'PT409' using message='Prepare this stock change again.';end if;
 perform private.assert_stock_resolution_access(t.command_id,t.type,t.plan);
 perform private.assert_stock_movement_review(ticket_id);
 if sha256(convert_to(private.stock_write_context(t.business_id,t.outlet_id,t.plan)::text,'UTF8'))<>t.snapshot_hash then raise sqlstate 'PT409' using message='The stock changed. Prepare again.',detail='stock_snapshot_changed';end if;
 if exists(select 1 from public.events e where e.id=t.command_id) then raise sqlstate 'PT409' using message='Read the accepted receipt again.';end if;
 select jsonb_object_agg(p.value->>'itemId',p.value||jsonb_build_object('_i',p.ordinality)) into plans from jsonb_array_elements(t.plan->'rows') with ordinality p;
 select array_agg(s order by p.ordinality) into old_items from jsonb_array_elements(t.plan->'rows') with ordinality p join public.stock_items s on s.business_id=t.business_id and s.outlet_id=t.outlet_id and s.id=p.value->>'itemId';
 select jsonb_object_agg(x.stock_item_id,x.revision) into count_barriers from
  (select m.stock_item_id,max(m.revision) revision from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.reason='count' and plans ? m.stock_item_id::text
   and not exists(select 1 from public.stock_moves u where u.business_id=t.business_id and u.outlet_id=t.outlet_id and u.undo_of=m.id) group by m.stock_item_id) x;
 if t.type='stock.undo' then
  select * into original from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.id=t.plan->>'undoMoveId';
  if original.id is null or original.undo_of is not null or at_ms<original.created_at or at_ms-original.created_at>86400000 or t.occurred_at<original.created_at
   or exists(select 1 from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.undo_of=original.id)
   or exists(select 1 from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.stock_item_id=original.stock_item_id and m.reason='count' and m.revision>original.revision
     and not exists(select 1 from public.stock_moves u where u.business_id=t.business_id and u.outlet_id=t.outlet_id and u.undo_of=m.id)) then raise sqlstate 'PT409' using message='Undo once within 24 hours, before a later physical count.';end if;
 end if;
 n:=jsonb_array_length(t.plan->'rows');
 if records is null or jsonb_typeof(records)<>'array' or jsonb_array_length(records) not between 2 and 3000 or octet_length(records::text)>64000000 then raise invalid_parameter_value using message='Invalid stock mutation.';end if;
 select count(*) filter(where x->>'table'='stock_items'),count(*) filter(where x->>'table'='stock_moves'),count(*) filter(where x->>'table'='events') into item_count,move_count,event_count from jsonb_array_elements(records) x;
 if item_count<>n or event_count<>n or move_count<>(select count(*) from jsonb_array_elements(t.plan->'rows') x where x->>'moveId' is not null)
  or item_count+move_count+event_count<>jsonb_array_length(records) then raise invalid_parameter_value using message='Invalid stock mutation shape.';end if;
 select jsonb_object_agg(x->'values'->>'id',x->'values') into item_records from jsonb_array_elements(records) x where x->>'table'='stock_items';
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if allowed is null or jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed)
   or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k)
   or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null'))
   or v->>'business_id' is distinct from t.business_id::text or v->>'outlet_id' is distinct from t.outlet_id::text then raise invalid_parameter_value using message='Invalid stock record fields.';end if;
  p:=plans->(case when table_name='stock_items' then v->>'id' else v->>'stock_item_id' end);
  if p is null then raise invalid_parameter_value using message='Keep the planned stock identity.';end if;
  before:=old_items[(p->>'_i')::int];
  if t.type<>'stock.create' and (before.id is null or before.archived_at is not null and not (t.type in ('stock.archive','stock.restore') or t.type='stock.update' and p->>'moveId' is null)) then raise sqlstate 'PT409' using message='Review this stock item.';end if;
  if t.type<>'stock.create' and ((p->>'revision')::bigint>before.revision or (p->>'reason'='count' and (p->>'revision')::bigint<>before.revision)) then raise sqlstate 'PT409' using message='Review the latest stock revision.';end if;
  if t.type not in ('stock.create','stock.update','stock.archive','stock.restore','stock.undo') and p->>'reason'<>'count' and coalesce((count_barriers->>(p->>'itemId'))::bigint,0)>(p->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the later physical count.';end if;
  expected_quantity:=case p->>'reason' when 'count' then (p->>'quantity')::numeric when 'received' then before.on_hand+(p->>'quantity')::numeric when 'used' then before.on_hand-(p->>'quantity')::numeric when 'waste' then before.on_hand-(p->>'quantity')::numeric when 'undo' then before.on_hand-original.delta else before.on_hand end;
  if expected_quantity is null or expected_quantity<0 or expected_quantity>1000000000 then raise sqlstate 'PT409' using message='Review the available stock quantity.';end if;
  expected_counted:=before.last_counted_at;
  if p->>'reason'='count' then expected_counted:=t.occurred_at;
  elsif t.type='stock.undo' then
   select m.created_at into expected_counted from public.stock_moves m where m.business_id=t.business_id and m.outlet_id=t.outlet_id and m.stock_item_id=p->>'itemId' and m.reason='count' and m.id<>original.id
     and not exists(select 1 from public.stock_moves u where u.business_id=t.business_id and u.outlet_id=t.outlet_id and u.undo_of=m.id) order by m.revision desc limit 1;
  end if;
  expected_command:=case t.type when 'stock.create' then 'stock.item-create' when 'stock.update' then 'stock.item-update' when 'stock.archive' then 'stock.archive' when 'stock.restore' then 'stock.restore' when 'stock.undo' then 'stock.undo' else 'stock.'||(p->>'reason') end;
  if table_name='stock_items' then
   if v->>'event_id' is distinct from p->>'eventId' or (v->>'revision')::bigint is distinct from coalesce(before.revision,0)+1
    or (v->>'created_at')::bigint is distinct from coalesce(before.created_at,t.occurred_at)
    or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at,coalesce(before.created_at,t.occurred_at))
    or (v->>'on_hand')::numeric is distinct from expected_quantity or (v->>'last_counted_at')::bigint is distinct from expected_counted
    or (v->>'archived_at')::bigint is distinct from (case when t.type='stock.archive' then t.occurred_at when t.type='stock.restore' then null else before.archived_at end)
    or (t.type='stock.archive' and v->>'active_key' is not null)
    or (t.type='stock.restore' and v->>'active_key' is null)
    or (t.type in ('stock.create','stock.update') and v->>'active_key' is distinct from (case when t.type='stock.update' and before.archived_at is not null then null else t.plan->>'nameKey' end))
    or (t.type='stock.update' and v->>'unit' is distinct from before.unit::text)
    or (t.type not in ('stock.create','stock.update') and (v->>'name' is distinct from before.name::text or v->>'name_local' is distinct from before.name_local::text or v->>'unit' is distinct from before.unit::text
      or v->>'category' is distinct from before.category::text or v->>'aliases' is distinct from before.aliases::text or (v->>'target')::numeric is distinct from before.target
      or (v->>'pack_size')::numeric is distinct from before.pack_size or (v->>'low_at')::numeric is distinct from before.low_at or v->>'supplier_id' is distinct from before.supplier_id::text))
    or (t.type not in ('stock.create','stock.update','stock.archive','stock.restore') and v->>'active_key' is distinct from before.active_key)
    or (t.type in ('stock.create','stock.update') and v->>'supplier_id' is distinct from t.plan->>'supplierId') then raise invalid_parameter_value using message='Invalid stock item mutation.';end if;
  elsif table_name='stock_moves' then
   item_values:=item_records->(p->>'itemId');
   if p->>'moveId' is null or v->>'id' is distinct from p->>'moveId' or v->>'event_id' is distinct from p->>'eventId' or (v->>'revision')::bigint is distinct from coalesce(before.revision,0)+1
    or v->>'created_by' is distinct from t.actor_id::text or (v->>'created_at')::bigint is distinct from t.occurred_at or (v->>'updated_at')::bigint is distinct from greatest(t.created_at,t.occurred_at)
    or v->>'name' is distinct from item_values->>'name' or v->>'unit' is distinct from item_values->>'unit' or v->>'reason' is distinct from p->>'reason' or v->>'source' is distinct from p->>'source'
    or (v->>'before_quantity')::numeric is distinct from coalesce(before.on_hand,0) or (v->>'after_quantity')::numeric is distinct from expected_quantity
    or (v->>'delta')::numeric is distinct from expected_quantity-coalesce(before.on_hand,0)
    or v->>'undo_of' is distinct from t.plan->>'undoMoveId'
    or v->>'count_batch_id' is distinct from (case when t.type='stock.undo' then original.count_batch_id::text else t.plan->>'batchId' end) then raise invalid_parameter_value using message='Invalid stock movement.';end if;
  else
   if v->>'id' is distinct from p->>'eventId' or v->>'actor_type'<>'member' or v->>'actor_id' is distinct from t.actor_id::text or v->>'command' is distinct from expected_command
    or (v->>'stock_revision')::bigint is distinct from coalesce(before.revision,0)+1 or (v->>'at')::bigint is distinct from t.created_at
    or v->>'undo_of' is distinct from (case when t.type='stock.undo' then original.event_id::text else null end)
    or exists(select 1 from unnest(array['customer_id','order_id','order_revision','supplier_id','closing_id','handoff_id','handoff_revision','handoff_topic','inbox_id','inbox_revision']) k where v->>k is not null) then raise invalid_parameter_value using message='Invalid stock audit.';end if;
  end if;
  select string_agg(format('%I',a.key),',' order by a.key),string_agg(format('($1->>%L)::%s',a.key,format_type(att.atttypid,att.atttypmod)),',' order by a.key),
   string_agg(format('%I=excluded.%I',a.key,a.key),',' order by a.key) filter(where a.key not in ('id','business_id','outlet_id','created_at')) into keys,casts,updates
   from jsonb_each(v) a join pg_attribute att on att.attrelid=to_regclass('public.'||table_name) and att.attname=a.key and att.attnum>0 and not att.attisdropped;
  execute format('insert into public.%I(%s) select %s%s',table_name,keys,casts,case when table_name='stock_items' then ' on conflict(id) do update set '||updates else '' end) using v;
 end loop;
 if not exists(select 1 from public.events e where e.id=t.command_id and e.business_id=t.business_id and e.outlet_id=t.outlet_id) then raise invalid_parameter_value using message='Missing stock audit.';end if;
 select jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'at',t.created_at,'batchId',t.plan->>'batchId','undoOf',t.plan->>'undoMoveId',
  'results',(select jsonb_agg(jsonb_build_object('stockItemId',s.id,'eventId',s.event_id,'moveId',p.value->>'moveId','revision',s.revision,'onHand',s.on_hand,'updatedAt',s.updated_at) order by p.ordinality)
   from jsonb_array_elements(t.plan->'rows') with ordinality p join public.stock_items s on s.id=p.value->>'itemId')) into metadata;
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.stock_write_tickets x where x.command_id=t.command_id;return metadata;
end $$;
