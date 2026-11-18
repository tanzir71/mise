-- Owner-only profile/market updates. Auth identity, permissions and assignments are never edited.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
 'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch','supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo',
 'order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings','closing.record','closing.undo',
 'handoff.prepare','handoff.change','supplier-message.undo','inbox.capture','inbox.change','khata.wording','export.prepare','setup.update'));
create table private.profile_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,input_json text not null check(octet_length(input_json)<=16000),plan_input jsonb not null check(jsonb_typeof(plan_input)='object'),occurred_at public.utc_ms not null,
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),
 token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.profile_write_tickets enable row level security;alter table private.profile_write_tickets force row level security;
revoke all on private.profile_write_tickets from public,anon,authenticated,service_role;
create index profile_write_tickets_actor_idx on private.profile_write_tickets(auth_user_id,expires_at);
create index profile_write_tickets_command_idx on private.profile_write_tickets(command_id);

create function private.profile_intent_input(command_id public.ulid,business public.ulid,outlet public.ulid,owner public.ulid,occurred public.utc_ms,plan jsonb,fingerprint text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare input jsonb;field text;stats integer[];input_text text;canonical text;
begin
 if command_id is null or business is null or outlet is null or owner is null or occurred is null
  or (select count(distinct x) from unnest(array[command_id,business,outlet,owner]) x)<>4
  or jsonb_typeof(plan) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(plan) k) is distinct from array['input','intentJson']
  or jsonb_typeof(plan->'input') is distinct from 'object' or jsonb_typeof(plan->'intentJson') is distinct from 'string' or octet_length(plan::text)>64000 or octet_length(plan->>'intentJson')>16000
  or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or encode(sha256(convert_to(plan->>'intentJson','UTF8')),'hex')<>fingerprint then raise invalid_parameter_value using message='Keep the complete original profile action.';end if;
 input:=plan->'input';
 if (select array_agg(k order by k) from jsonb_object_keys(input) k) is distinct from array['addressJson','businessType','currency','language','marketCode','nameJson','outletNameJson','phone','timezone']
  or exists(select 1 from jsonb_each(input) e where jsonb_typeof(e.value)<>'string')
  or input->>'businessType' not in ('restaurant','online_shop','food_stall','corner_shop') or input->>'marketCode' not in ('BD','IN','ID','KE','OTHER')
  or input->>'language' not in ('en','bn','both') or input->>'phone'!~'^\+[1-9][0-9]{6,14}$' or input->>'currency'!~'^[A-Z]{3}$'
  or length(input->>'timezone') not between 1 and 80 then raise invalid_parameter_value using message='Keep the exact normalized profile fields.';end if;
 foreach field in array array['nameJson','outletNameJson','addressJson'] loop
  stats:=private.inbox_literal_stats((input->>field)::json);
  if stats[1]>(case when field='addressJson' then 250 else 80 end) or field<>'addressJson' and stats[2]=0 then raise invalid_parameter_value using message='Keep profile text within the original limits.';end if;
 end loop;
 input_text:='{"businessType":'||to_json(input->>'businessType')::text||',"marketCode":'||to_json(input->>'marketCode')::text||',"name":'||(input->>'nameJson')||',"phone":'||to_json(input->>'phone')::text||',"outletName":'||(input->>'outletNameJson')||',"address":'||(input->>'addressJson')||',"language":'||to_json(input->>'language')::text||',"timezone":'||to_json(input->>'timezone')::text||',"currency":'||to_json(input->>'currency')::text||'}';
 canonical:='{"id":'||to_json(command_id)::text||',"type":"setup.update","businessId":'||to_json(business)::text||',"outletId":'||to_json(outlet)::text||',"ownerId":'||to_json(owner)::text||',"occurredAt":'||occurred::text||',"input":'||input_text||'}';
 if canonical is distinct from plan->>'intentJson' then raise invalid_parameter_value using message='Keep every original profile field, identity and time.';end if;return input_text;
end $$;

-- Business -> outlet -> owner/Auth. NOWAIT avoids waiting on the older outlet
-- command paths that hold membership SHARE locks before their business lock.
create function private.profile_owner_lock(business public.ulid,outlet public.ulid,owner public.ulid,subject uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if subject is null then raise insufficient_privilege using message='Owner profile access required.';end if;
 perform 1 from public.businesses b where b.id=business for update nowait;if not found then raise insufficient_privilege using message='Owner profile access required.';end if;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update nowait;if not found then raise insufficient_privilege using message='Owner profile access required.';end if;
 perform 1 from public.members m join auth.users u on u.id=m.auth_user_id where m.business_id=business and m.id=owner and m.auth_user_id=subject and m.role='owner' and m.active
  and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>'' and u.deleted_at is null and (u.banned_until is null or u.banned_until<=statement_timestamp()) for update of m nowait for share of u nowait;
 if not found then raise insufficient_privilege using message='Owner profile access required.';end if;
end $$;
create function private.profile_write_context(business public.ulid,outlet public.ulid,owner public.ulid) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=business),'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'owner',(select row_to_json(m) from public.members m where m.business_id=business and m.id=owner),'outletIds',coalesce((select json_agg(a.outlet_id order by a.outlet_id) from public.member_outlets a where a.business_id=business and a.member_id=owner),'[]'::json))
$$;
create function private.profile_portable_snapshot(business public.ulid,outlet public.ulid,owner public.ulid) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object('business',(select json_build_object('id',b.id,'createdAt',b.created_at,'updatedAt',b.updated_at,'name',b.name,'businessType',b.business_type,'marketCode',b.market_code,'languages',b.languages) from public.businesses b where b.id=business),
  'outlet',(select private.settings_outlet_snapshot(o) from public.outlets o where o.business_id=business and o.id=outlet),
  'owner',(select json_build_object('id',m.id,'createdAt',m.created_at,'updatedAt',m.updated_at,'businessId',m.business_id,'outletIds',coalesce((select json_agg(a.outlet_id order by a.outlet_id) from public.member_outlets a where a.business_id=business and a.member_id=owner),'[]'::json),'name',m.name,'phone',m.phone,'role',m.role,'active',m.active) from public.members m where m.business_id=business and m.id=owner))
$$;
create function private.prepare_profile_write(command_id public.ulid,ticket_id public.ulid,business public.ulid,outlet public.ulid,owner public.ulid,plan jsonb,fingerprint text,occurred public.utc_ms) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old private.shop_command_receipts;input_text text;context json;secret text;at_ms public.utc_ms;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='Owner profile access required.';end if;
 if ticket_id is null or ticket_id in(command_id,business,outlet,owner) then raise invalid_parameter_value using message='Keep distinct original preparation and profile IDs.';end if;
 input_text:=private.profile_intent_input(command_id,business,outlet,owner,occurred,plan,fingerprint);
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));perform private.profile_owner_lock(business,outlet,owner,(select auth.uid()));
 select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  if old.actor_id<>owner or old.auth_user_id<>(select auth.uid()) or old.business_id<>business or old.outlet_id<>outlet then raise insufficient_privilege using message='This profile action is unavailable.';end if;
  if old.type<>'setup.update' or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original profile action.';end if;return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 if exists(select 1 from public.events e where e.id=command_id) or exists(select 1 from private.command_receipts r where r.id=command_id) then raise insufficient_privilege using message='This action identity is unavailable.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;if occurred>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 delete from private.profile_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.profile_write_tickets t where t.command_id=prepare_profile_write.command_id and t.auth_user_id=(select auth.uid()) and (t.business_id<>business or t.outlet_id<>outlet or t.actor_id<>owner or t.input_json<>input_text or t.request_hash<>fingerprint or t.occurred_at<>occurred)) then raise unique_violation using message='Keep the original profile action.';end if;
 delete from private.profile_write_tickets t where t.command_id=prepare_profile_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.profile_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending profile changes first.';end if;
 context:=private.profile_write_context(business,outlet,owner);secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.profile_write_tickets values(ticket_id,command_id,business,outlet,owner,(select auth.uid()),input_text,plan->'input',occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',owner,'at',at_ms,'contextJson',context::text);
exception when lock_not_available then raise sqlstate 'PT409' using message='The profile source is busy.',detail='profile_snapshot_changed';
end $$;
create function private.finish_profile_write(ticket_id public.ulid,secret text,input_text text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.profile_write_tickets;input jsonb;before_data json;after_data json;at_ms public.utc_ms;b_updated public.utc_ms;o_updated public.utc_ms;m_updated public.utc_ms;metadata jsonb;
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.profile_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This profile preparation is unavailable.';end if;
 perform private.profile_owner_lock(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 select * into t from private.profile_write_tickets x where x.id=ticket_id for update nowait;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This profile proof is unavailable.';end if;
 if t.snapshot_hash<>sha256(convert_to(private.profile_write_context(t.business_id,t.outlet_id,t.actor_id)::text,'UTF8')) or exists(select 1 from private.shop_command_receipts r where r.id=t.command_id) then raise sqlstate 'PT409' using message='The profile source changed.',detail='profile_snapshot_changed';end if;
 if input_text is distinct from t.input_json then raise invalid_parameter_value using message='Keep the exact normalized original profile fields.';end if;
 input:=t.plan_input;before_data:=private.profile_portable_snapshot(t.business_id,t.outlet_id,t.actor_id);
 update public.businesses b set name=(input->>'nameJson')::json,business_type=input->>'businessType',market_code=input->>'marketCode',languages=array_to_json(case input->>'language' when 'both' then array['en','bn'] else array[input->>'language'] end),updated_at=greatest(b.created_at,b.updated_at,t.created_at,t.occurred_at) where b.id=t.business_id returning updated_at into b_updated;
 update public.outlets o set name=(input->>'outletNameJson')::json,address=(input->>'addressJson')::json,timezone=input->>'timezone',currency=input->>'currency',updated_at=greatest(o.created_at,o.updated_at,t.created_at,t.occurred_at) where o.business_id=t.business_id and o.id=t.outlet_id returning updated_at into o_updated;
 update public.members m set phone=input->>'phone',updated_at=greatest(m.created_at,m.updated_at,t.created_at,t.occurred_at) where m.business_id=t.business_id and m.id=t.actor_id returning updated_at into m_updated;
 after_data:=private.profile_portable_snapshot(t.business_id,t.outlet_id,t.actor_id);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,'setup.update',before_data,after_data,t.created_at);
 metadata:=jsonb_build_object('id',t.command_id,'type','setup.update','businessId',t.business_id,'outletId',t.outlet_id,'ownerId',t.actor_id,'occurredAt',t.occurred_at,'at',t.created_at,'businessUpdatedAt',b_updated,'outletUpdatedAt',o_updated,'ownerUpdatedAt',m_updated);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,'setup.update',null,t.request_hash,metadata);
 delete from private.profile_write_tickets x where x.command_id=t.command_id;return metadata;
exception when lock_not_available then raise sqlstate 'PT409' using message='The profile source is busy.',detail='profile_snapshot_changed';
end $$;
revoke all on function private.profile_intent_input(public.ulid,public.ulid,public.ulid,public.ulid,public.utc_ms,jsonb,text),private.profile_owner_lock(public.ulid,public.ulid,public.ulid,uuid),private.profile_write_context(public.ulid,public.ulid,public.ulid),private.profile_portable_snapshot(public.ulid,public.ulid,public.ulid),
 private.prepare_profile_write(public.ulid,public.ulid,public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms),private.finish_profile_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.prepare_profile_write(public.ulid,public.ulid,public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_profile_write(public.ulid,text,text) to service_role;
create function public.prepare_profile_write(p_id public.ulid,p_ticket_id public.ulid,p_business_id public.ulid,p_outlet_id public.ulid,p_owner_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_profile_write(p_id,p_ticket_id,p_business_id,p_outlet_id,p_owner_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_profile_write(p_ticket_id public.ulid,p_token text,p_input_json text) returns jsonb language sql security invoker set search_path='' as $$select private.finish_profile_write(p_ticket_id,p_token,p_input_json)$$;
revoke all on function public.prepare_profile_write(public.ulid,public.ulid,public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms),public.finish_profile_write(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_profile_write(public.ulid,public.ulid,public.ulid,public.ulid,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_profile_write(public.ulid,text,text) to service_role;
notify pgrst,'reload schema';
