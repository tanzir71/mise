-- Frozen shop-link publication is a server-time last-write-wins set. Undo is guarded.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
 'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch','supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo',
 'order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings','closing.record','closing.undo',
 'handoff.prepare','handoff.change','supplier-message.undo','inbox.capture','inbox.change','khata.wording','export.prepare','setup.update','shopLink.generate','shopLink.undo'));
create table private.shop_link_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('shopLink.generate','shopLink.undo')),
 plan jsonb not null check(jsonb_typeof(plan)='object'),occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.shop_link_write_tickets enable row level security;alter table private.shop_link_write_tickets force row level security;
revoke all on private.shop_link_write_tickets from public,anon,authenticated,service_role;
create index shop_link_write_tickets_actor_idx on private.shop_link_write_tickets(auth_user_id,expires_at);
create index shop_link_write_tickets_command_idx on private.shop_link_write_tickets(command_id);
create function private.shop_link_intent(command_id public.ulid,kind text,outlet public.ulid,owner public.ulid,occurred public.utc_ms,plan jsonb,fingerprint text) returns void
language plpgsql immutable security invoker set search_path='' as $$declare canonical text;
begin
 if command_id is null or kind is null or kind not in ('shopLink.generate','shopLink.undo') or outlet is null or owner is null or occurred is null
  or (select count(distinct x) from unnest(array[command_id,outlet,owner]) x)<>3 or jsonb_typeof(plan) is distinct from 'object'
  or (select array_agg(k order by k) from jsonb_object_keys(plan) k) is distinct from array['intentJson','reviewJson','sourceId','url']
  or jsonb_typeof(plan->'intentJson') is distinct from 'string' or octet_length(plan::text)>1048000 or octet_length(plan->>'intentJson')>256000
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or encode(sha256(convert_to(plan->>'intentJson','UTF8')),'hex')<>fingerprint then raise invalid_parameter_value using message='Keep the complete original shop-link action.';end if;
 canonical:='{"id":'||to_json(command_id)::text||',"outletId":'||to_json(outlet)::text||',"ownerId":'||to_json(owner)::text||',"occurredAt":'||occurred::text||',"type":'||to_json(kind)::text;
 if kind='shopLink.generate' then
  if plan->'sourceId' is distinct from 'null'::jsonb or jsonb_typeof(plan->'url') is distinct from 'string' or length(plan->>'url')>256000 or plan->>'url'!~'^https?://'
   or jsonb_typeof(plan->'reviewJson') is distinct from 'string' or length(plan->>'reviewJson')>256000 or json_typeof((plan->>'reviewJson')::json) is distinct from 'object' then raise invalid_parameter_value using message='Keep the original frozen publication and review.';end if;
  canonical:=canonical||',"review":'||(plan->>'reviewJson')||',"url":'||to_json(plan->>'url')::text||'}';
 else
  if plan->'url' is distinct from 'null'::jsonb or plan->'reviewJson' is distinct from 'null'::jsonb or jsonb_typeof(plan->'sourceId') is distinct from 'string' or plan->>'sourceId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or plan->>'sourceId'=any(array[command_id,outlet,owner]) then raise invalid_parameter_value using message='Keep the original generation identity.';end if;
  canonical:=canonical||',"sourceId":'||to_json(plan->>'sourceId')::text||'}';
 end if;
 if canonical is distinct from plan->>'intentJson' then raise invalid_parameter_value using message='Keep every original link field, identity and time.';end if;
end $$;
create function private.shop_link_source_time(business public.ulid,outlet public.ulid,source public.ulid) returns public.utc_ms
language sql volatile security invoker set search_path='' as $$
 select coalesce((select (r.receipt->>'occurredAt')::bigint from private.shop_command_receipts r where r.id=source and r.business_id=business and r.outlet_id=outlet and r.type='shopLink.generate'),(select e.at from public.events e where e.id=source and e.business_id=business and e.outlet_id=outlet))::public.utc_ms
$$;
create function private.shop_link_write_context(business public.ulid,outlet public.ulid,actor public.ulid,source public.ulid) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=business),'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'actor',(select row_to_json(m) from public.members m where m.business_id=business and m.id=actor),
  'source',(select row_to_json(e) from public.events e where e.business_id=business and e.outlet_id=outlet and e.id=source),'sourceOccurredAt',private.shop_link_source_time(business,outlet,source),
  'undone',exists(select 1 from public.events e where e.business_id=business and e.outlet_id=outlet and e.command='shopLink.undo' and e.undo_of=source))
$$;
create function private.admit_shop_link_write(outlet public.ulid) returns boolean
language plpgsql security definer set search_path='' as $$declare business public.ulid;begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Shop-link access required.';end if;
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='Shop-link access required.';end if;
 perform private.public_link_actor(business,outlet);return true;
end $$;
create function private.prepare_shop_link_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,owner public.ulid,plan jsonb,fingerprint text,occurred public.utc_ms) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;context json;secret text;at_ms public.utc_ms;source_id public.ulid;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Shop-link access required.';end if;
 if ticket_id is null or ticket_id in(command_id,outlet,owner) then raise invalid_parameter_value using message='Keep distinct original preparation and link IDs.';end if;
 perform private.shop_link_intent(command_id,kind,outlet,owner,occurred,plan,fingerprint);source_id:=(plan->>'sourceId')::public.ulid;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);perform private.customer_write_actor(old.business_id,old.outlet_id,actor,(select auth.uid()));
  if old.actor_id<>actor or actor<>owner or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This link action is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original link action.';end if;return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);if actor<>owner then raise insufficient_privilege using message='Use the original link actor.';end if;
 perform 1 from public.businesses b where b.id=business for share;perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));
 select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This link action is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original link action.';end if;return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 if exists(select 1 from public.events e where e.id=command_id) or exists(select 1 from private.command_receipts r where r.id=command_id) then raise insufficient_privilege using message='This action identity is unavailable.';end if;
 if kind='shopLink.undo' and not exists(select 1 from public.events e where e.id=source_id and e.business_id=business and e.outlet_id=outlet and e.actor_type='member' and e.actor_id=actor and e.command='shopLink.generate') then raise insufficient_privilege using message='Use your original generation in this outlet.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 delete from private.shop_link_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.shop_link_write_tickets t where t.command_id=prepare_shop_link_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>prepare_shop_link_write.plan or t.type<>kind or t.outlet_id<>outlet or t.actor_id<>owner or t.occurred_at<>occurred)) then raise unique_violation using message='Keep the original link action.';end if;
 delete from private.shop_link_write_tickets t where t.command_id=prepare_shop_link_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.shop_link_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending link actions first.';end if;
 context:=private.shop_link_write_context(business,outlet,actor,source_id);secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.shop_link_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,plan,occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;
create function private.finish_shop_link_write(ticket_id public.ulid,secret text,result_json text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.shop_link_write_tickets;o public.outlets;e public.events;source_id public.ulid;original_time public.utc_ms;next_url text;before_data json;after_data json;updated public.utc_ms;at_ms public.utc_ms;metadata jsonb;
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.shop_link_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This link preparation is unavailable.';end if;
 perform 1 from public.businesses b where b.id=t.business_id for share;select * into o from public.outlets x where x.business_id=t.business_id and x.id=t.outlet_id for update;
 select * into t from private.shop_link_write_tickets x where x.id=ticket_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This link proof is unavailable.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);source_id:=(t.plan->>'sourceId')::public.ulid;
 if t.snapshot_hash<>sha256(convert_to(private.shop_link_write_context(t.business_id,t.outlet_id,t.actor_id,source_id)::text,'UTF8')) or exists(select 1 from private.shop_command_receipts r where r.id=t.command_id) then raise sqlstate 'PT409' using message='The link source changed.',detail='shop_link_snapshot_changed';end if;
 if t.type='shopLink.generate' then next_url:=t.plan->>'url';
 else
  select * into e from public.events x where x.id=source_id and x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.actor_type='member' and x.actor_id=t.actor_id and x.command='shopLink.generate';
  original_time:=private.shop_link_source_time(t.business_id,t.outlet_id,source_id);
  if e.id is null or original_time is null or t.occurred_at<original_time or t.occurred_at-original_time>600000 or exists(select 1 from public.events x where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.command='shopLink.undo' and x.undo_of=source_id) then raise sqlstate 'PT409' using message='Undo your latest original link within ten minutes.';end if;
  if json_typeof(e.before_data) is distinct from 'object' or (select array_agg(k order by k) from json_object_keys(e.before_data) k) is distinct from array['url'] or json_typeof(e.after_data) is distinct from 'object' or (select array_agg(k order by k) from json_object_keys(e.after_data) k) is distinct from array['url'] or json_typeof(e.after_data->'url') is distinct from 'string' or json_typeof(e.before_data->'url') not in ('null','string') then raise invalid_parameter_value using message='Keep the complete original link history.';end if;
  if o.shop_link is distinct from (e.after_data->'url')#>>'{}' then raise sqlstate 'PT409' using message='Only the latest unchanged link can be undone.';end if;
  next_url:=(e.before_data->'url')#>>'{}';
 end if;
 if result_json is distinct from '{"url":'||coalesce(to_json(next_url)::text,'null')||'}' then raise invalid_parameter_value using message='Keep the exact frozen or restored URL.';end if;
 before_data:=json_build_object('url',o.shop_link);after_data:=json_build_object('url',next_url);updated:=greatest(o.created_at,o.updated_at,t.created_at,t.occurred_at);
 update public.outlets x set shop_link=next_url,updated_at=updated where x.business_id=t.business_id and x.id=t.outlet_id;
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,undo_of) values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,t.type,before_data,after_data,t.created_at,source_id);
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'outletId',t.outlet_id,'ownerId',t.actor_id,'occurredAt',t.occurred_at,'at',t.created_at,'outletUpdatedAt',updated);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.shop_link_write_tickets x where x.command_id=t.command_id;return metadata;
exception when untranslatable_character then raise invalid_parameter_value using message='The original URL needs manual recovery.';
end $$;
revoke all on function private.shop_link_intent(public.ulid,text,public.ulid,public.ulid,public.utc_ms,jsonb,text),private.shop_link_source_time(public.ulid,public.ulid,public.ulid),private.shop_link_write_context(public.ulid,public.ulid,public.ulid,public.ulid),private.admit_shop_link_write(public.ulid),
 private.prepare_shop_link_write(public.ulid,public.ulid,text,public.ulid,public.ulid,jsonb,text,public.utc_ms),private.finish_shop_link_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.admit_shop_link_write(public.ulid),private.prepare_shop_link_write(public.ulid,public.ulid,text,public.ulid,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_shop_link_write(public.ulid,text,text) to service_role;
create function public.admit_shop_link_write(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_shop_link_write(p_outlet_id)$$;
create function public.prepare_shop_link_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_owner_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_shop_link_write(p_id,p_ticket_id,p_type,p_outlet_id,p_owner_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_shop_link_write(p_ticket_id public.ulid,p_token text,p_result_json text) returns jsonb language sql security invoker set search_path='' as $$select private.finish_shop_link_write(p_ticket_id,p_token,p_result_json)$$;
revoke all on function public.admit_shop_link_write(public.ulid),public.prepare_shop_link_write(public.ulid,public.ulid,text,public.ulid,public.ulid,jsonb,text,public.utc_ms),public.finish_shop_link_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.admit_shop_link_write(public.ulid),public.prepare_shop_link_write(public.ulid,public.ulid,text,public.ulid,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_shop_link_write(public.ulid,text,text) to service_role;
notify pgrst,'reload schema';
