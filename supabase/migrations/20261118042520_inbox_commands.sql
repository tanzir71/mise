-- Original captures and reversible manual sorting. Source text is inert literal JSON.
alter table private.shop_command_receipts drop constraint shop_command_receipts_type_check;
alter table private.shop_command_receipts add constraint shop_command_receipts_type_check check(type in
 ('customer.create','customer.update','customer.archive','customer.restore','khata.settings','sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication',
 'stock.create','stock.update','stock.archive','stock.restore','stock.adjust','stock.undo','stock.batch','supplier.create','supplier.update','supplier.archive','supplier.restore','purchase.record','purchase.undo',
 'order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings','closing.record','closing.undo',
 'handoff.prepare','handoff.change','supplier-message.undo','inbox.capture','inbox.change'));
create table private.inbox_write_tickets (
 id public.ulid primary key,command_id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,
 actor_id public.ulid not null,auth_user_id uuid not null,type text not null check(type in ('inbox.capture','inbox.change')),
 plan jsonb not null,occurred_at public.utc_ms not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 snapshot_hash bytea not null check(octet_length(snapshot_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),created_at public.utc_ms not null,expires_at public.utc_ms not null
);
alter table private.inbox_write_tickets enable row level security;alter table private.inbox_write_tickets force row level security;
revoke all on private.inbox_write_tickets from public,anon,authenticated,service_role;
create index inbox_write_tickets_actor_idx on private.inbox_write_tickets(auth_user_id,expires_at);
create index inbox_write_tickets_command_idx on private.inbox_write_tickets(command_id);

-- Count JS UTF-16 units and ECMAScript trim content without decoding NUL/surrogates.
create function private.inbox_literal_stats(value json) returns integer[]
language plpgsql immutable security invoker set search_path='' as $$
declare raw text:=value::text;n integer:=0;visible integer:=0;point integer;part text;ch text;
 trim_chars text:=chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
begin
 if json_typeof(value) is distinct from 'string' then raise invalid_parameter_value using message='Keep literal source strings.';end if;
 for part in select m[1] from regexp_matches(substr(raw,2,char_length(raw)-2),'(\\u[0-9a-fA-F]{4}|\\.|[^\\]+)','g') a(m) loop
  if left(part,1)=chr(92) then
   ch:=substr(part,2,1);point:=case when ch='u' then ('x'||substr(part,3,4))::bit(16)::integer when ch='t' then 9 when ch='n' then 10 when ch='r' then 13 when ch='f' then 12 when ch='b' then 8 else ascii(ch) end;
   n:=n+1;if point<>all(array[9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279]) then visible:=1;end if;
  else n:=n+char_length(part)+regexp_count(part,U&'[\+010000-\+10FFFF]');if btrim(part,trim_chars)<>'' then visible:=1;end if;end if;
 end loop;
 return array[n,visible];
end $$;
create function private.check_inbox_content(content jsonb,command_id public.ulid,item_id public.ulid) returns integer
language plpgsql immutable security invoker set search_path='' as $$
declare image jsonb;stats integer[];bytes integer:=0;visible integer:=0;field text;
begin
 if jsonb_typeof(content) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(content) k) is distinct from array['images','textJson','titleJson','urlJson']
  or jsonb_typeof(content->'images') is distinct from 'array' or jsonb_array_length(content->'images')>4 then raise invalid_parameter_value using message='Keep the complete original capture.';end if;
 foreach field in array array['title','text','url'] loop
  if jsonb_typeof(content->(field||'Json')) is distinct from 'string' then raise invalid_parameter_value using message='Keep literal source fields.';end if;
  stats:=private.inbox_literal_stats((content->>(field||'Json'))::json);visible:=visible+stats[2];
  if stats[1]>(case field when 'title' then 200 when 'text' then 12000 else 2400 end) then raise invalid_parameter_value using message='Keep the source within its original character limits.';end if;
 end loop;
 if jsonb_array_length(content->'images')<>(select count(distinct x->>'id') from jsonb_array_elements(content->'images') x) then raise invalid_parameter_value using message='Use distinct original image IDs.';end if;
 for image in select x from jsonb_array_elements(content->'images') x loop
  if jsonb_typeof(image) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(image) k) is distinct from array['id','nameJson','sha256','size','type']
   or jsonb_typeof(image->'id') is distinct from 'string' or image->>'id'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or image->>'id' in(command_id::text,item_id::text)
   or jsonb_typeof(image->'sha256') is distinct from 'string' or image->>'sha256'!~'^[0-9a-f]{64}$'
   or jsonb_typeof(image->'type') is distinct from 'string' or image->>'type' not in ('image/jpeg','image/png','image/webp')
   or jsonb_typeof(image->'size') is distinct from 'number' or (image->>'size')::numeric<>trunc((image->>'size')::numeric) or (image->>'size')::numeric not between 1 and 5242880 or jsonb_typeof(image->'nameJson') is distinct from 'string' then raise invalid_parameter_value using message='Keep every original image identity, size, type and hash.';end if;
  stats:=private.inbox_literal_stats((image->>'nameJson')::json);if stats[1]>200 then raise invalid_parameter_value using message='Keep the original image name within its limit.';end if;
  bytes:=bytes+(image->>'size')::integer;
 end loop;
 if bytes>10485760 or visible=0 and bytes=0 then raise invalid_parameter_value using message='Keep a nonempty capture within the original image budget.';end if;
 return bytes;
end $$;
create function private.inbox_snapshot(item public.inbox_items,images json) returns json
language sql immutable security invoker set search_path='' as $$
 select json_build_object('id',item.id,'outletId',item.outlet_id,'revision',item.revision,'title',item.title,'text',item.text,'url',item.url,
 'images',images,'kind',item.kind,'archived',item.archived,'createdAt',item.created_at,'updatedAt',item.updated_at)
$$;
-- Quote entire raw value-string tokens before JSONB structural comparison. This
-- preserves literal NUL/surrogates without ever unescaping their original values.
create function private.inbox_json_tokens(value json) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare raw text:=value::text;result text:='';i integer:=1;start_at integer;token text;tail text;
begin
 while i<=char_length(raw) loop
  start_at:=strpos(substr(raw,i),'"');if start_at=0 then result:=result||substr(raw,i);exit;end if;
  start_at:=start_at+i-1;result:=result||substr(raw,i,start_at-i);token:=(regexp_match(substr(raw,start_at),'^("(?:[^"\\]|\\.)*")'))[1];
  if token is null then raise invalid_parameter_value using message='Keep valid literal audit JSON.';end if;
  i:=start_at+char_length(token);tail:=ltrim(substr(raw,i),chr(9)||chr(10)||chr(13)||' ');
  result:=result||case when left(tail,1)=':' then token else to_json(token)::text end;
 end loop;
 return result::jsonb;
end $$;
create function private.inbox_snapshot_matches(value json,expected json) returns boolean
language sql immutable security invoker set search_path='' as $$select private.inbox_json_tokens(value)=private.inbox_json_tokens(expected)$$;
create function private.inbox_write_context(business public.ulid,outlet public.ulid,item_id public.ulid) returns json
language sql volatile security invoker set search_path='' as $$
 select json_build_object('business',(select row_to_json(b) from public.businesses b where b.id=business),
 'outlet',(select row_to_json(o) from public.outlets o where o.business_id=business and o.id=outlet),
 'item',(select row_to_json(i) from public.inbox_items i where i.business_id=business and i.outlet_id=outlet and i.id=item_id),
 'images',coalesce((select json_agg(json_build_object('id',i.id,'business_id',i.business_id,'outlet_id',i.outlet_id,'inbox_item_id',i.inbox_item_id,'position',i.position,'name',i.name,'type',i.type,'size',i.size,'sha256',i.sha256) order by i.position) from public.inbox_images i where i.business_id=business and i.outlet_id=outlet and i.inbox_item_id=item_id),'[]'::json),
 'latest',(select row_to_json(e) from public.events e where e.business_id=business and e.outlet_id=outlet and e.inbox_id=item_id and e.inbox_revision is not null order by e.inbox_revision desc limit 1))
$$;
create function private.admit_inbox_write(outlet public.ulid) returns boolean
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;
begin
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));return true;
end $$;
create function private.prepare_inbox_write(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms) returns jsonb
language plpgsql security definer set search_path='' as $$
declare business public.ulid;actor public.ulid;old private.shop_command_receipts;i public.inbox_items;at_ms public.utc_ms;context json;secret text;content jsonb;
begin
 if (select auth.uid()) is null then raise insufficient_privilege using message='This Inbox action is unavailable.';end if;
 if kind is null or kind not in ('inbox.capture','inbox.change') or command_id=ticket_id or ids is null or jsonb_typeof(ids)<>'object'
  or (select array_agg(k order by k) from jsonb_object_keys(ids) k) is distinct from array['change','createdAt','input','intentJson','itemId','revision']
  or jsonb_typeof(ids->'itemId') is distinct from 'string' or ids->>'itemId'!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' or ids->>'itemId'=command_id::text
  or jsonb_typeof(ids->'intentJson') is distinct from 'string' or octet_length(ids->>'intentJson')>256000 or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$'
  or encode(sha256(convert_to(ids->>'intentJson','UTF8')),'hex')<>fingerprint then raise invalid_parameter_value using message='Keep the complete original Inbox intent.';end if;
 if kind='inbox.capture' then
  if ids->'revision'<>'null'::jsonb or ids->'change'<>'null'::jsonb or jsonb_typeof(ids->'createdAt') is distinct from 'number'
   or (ids->>'createdAt')::numeric<>trunc((ids->>'createdAt')::numeric) or (ids->>'createdAt')::numeric not between 0 and 253402300799999
   or jsonb_typeof(ids->'input') is distinct from 'object' or octet_length((ids->'input')::text)>256000 then raise invalid_parameter_value using message='Keep the original source and creation time.';end if;
  content:=ids->'input';perform private.check_inbox_content(content,command_id,(ids->>'itemId')::public.ulid);
 else
  if ids->'createdAt'<>'null'::jsonb or ids->'input'<>'null'::jsonb or jsonb_typeof(ids->'revision') is distinct from 'number'
   or (ids->>'revision')::numeric<>trunc((ids->>'revision')::numeric) or (ids->>'revision')::numeric not between 1 and 9007199254740991
   or jsonb_typeof(ids->'change') is distinct from 'object' or (select count(*) from jsonb_object_keys(ids->'change'))<>1 then raise invalid_parameter_value using message='Keep one reviewed manual sorting choice.';end if;
  if ids->'change' ? 'kind' then
   if jsonb_typeof(ids->'change'->'kind') is distinct from 'string' or ids->'change'->>'kind' not in ('unclassified','order','payment','stock','question','other') then raise invalid_parameter_value using message='Choose a supported manual classification.';end if;
  elsif ids->'change' ? 'archived' then
   if jsonb_typeof(ids->'change'->'archived') is distinct from 'boolean' then raise invalid_parameter_value using message='Keep the explicit archive choice.';end if;
  else raise invalid_parameter_value using message='Choose a supported manual Inbox action.';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(command_id::text,0));select * into old from private.shop_command_receipts r where r.id=command_id;
 if found then
  actor:=private.public_link_actor(old.business_id,old.outlet_id);
  if old.actor_id<>actor or old.auth_user_id<>(select auth.uid()) then raise insufficient_privilege using message='This Inbox command is unavailable.';end if;
  if old.type<>kind or old.outlet_id<>outlet or old.request_hash<>fingerprint then raise unique_violation using message='Keep the original Inbox intent.';end if;
  return jsonb_build_object('done',true,'receipt',old.receipt);
 end if;
 select o.business_id into business from public.outlets o where o.id=outlet;if not found then raise insufficient_privilege using message='This outlet is unavailable.';end if;
 actor:=private.public_link_actor(business,outlet);perform 1 from public.businesses b where b.id=business for share;perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 perform private.customer_write_actor(business,outlet,actor,(select auth.uid()));at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if occurred>at_ms+300000 or kind='inbox.capture' and (ids->>'createdAt')::bigint>at_ms+300000 then raise sqlstate 'PT409' using message='Check the device clock.';end if;
 select * into i from public.inbox_items x where x.business_id=business and x.outlet_id=outlet and x.id=ids->>'itemId';
 if kind='inbox.capture' then if found then raise unique_violation using message='This original source identity exists.';end if;
 else
  if not found then raise insufficient_privilege using message='This source is unavailable in this outlet.';end if;
  if i.revision<>(ids->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the latest Inbox state.';end if;
 end if;
 delete from private.inbox_write_tickets t where t.auth_user_id=(select auth.uid()) and t.expires_at<=at_ms;
 if exists(select 1 from private.inbox_write_tickets t where t.command_id=prepare_inbox_write.command_id and t.auth_user_id=(select auth.uid()) and (t.request_hash<>fingerprint or t.plan<>(ids-'intentJson'))) then raise unique_violation using message='Keep the original source, action and IDs.';end if;
 delete from private.inbox_write_tickets t where t.command_id=prepare_inbox_write.command_id and t.auth_user_id=(select auth.uid());
 if (select count(*) from private.inbox_write_tickets t where t.auth_user_id=(select auth.uid()))>=100 then raise sqlstate 'PT429' using message='Resume pending changes first.';end if;
 context:=private.inbox_write_context(business,outlet,(ids->>'itemId')::public.ulid);secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
 insert into private.inbox_write_tickets values(ticket_id,command_id,business,outlet,actor,(select auth.uid()),kind,ids-'intentJson',occurred,fingerprint,sha256(convert_to(context::text,'UTF8')),sha256(convert_to(secret,'UTF8')),at_ms,at_ms+60000);
 return jsonb_build_object('done',false,'ticketId',ticket_id,'token',secret,'businessId',business,'outletId',outlet,'actorId',actor,'at',at_ms,'contextJson',context::text);
end $$;

create function private.finish_inbox_write(ticket_id public.ulid,secret text,records jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.inbox_write_tickets;before_row public.inbox_items;after_row public.inbox_items;latest public.events;content jsonb;images json;before_snapshot json;after_snapshot json;
 at_ms public.utc_ms;changed boolean:=true;image_count integer;bytes integer;r jsonb;v jsonb;expected jsonb;allowed jsonb;table_name text;image jsonb;position integer;command text;metadata jsonb;item_count integer:=0;audit_count integer:=0;image_records integer:=0;
 specs jsonb:='{"inbox_items":["id","created_at","updated_at","outlet_id","revision","title","text","url","kind","archived","business_id"],"inbox_images":["id","business_id","outlet_id","inbox_item_id","position","name","type","size","sha256","created_at","updated_at","uploaded_at"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"]}';
begin
 if current_setting('role',true)<>'service_role' then raise insufficient_privilege using message='Server completion required.';end if;
 select * into t from private.inbox_write_tickets x where x.id=ticket_id;if not found then raise insufficient_privilege using message='This Inbox preparation is unavailable.';end if;
 perform 1 from public.businesses b where b.id=t.business_id for share;perform 1 from public.outlets o where o.business_id=t.business_id and o.id=t.outlet_id for update;
 select * into t from private.inbox_write_tickets x where x.id=ticket_id for update;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if t.id is null or t.expires_at<=at_ms or secret is null or t.token_hash<>sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='This Inbox proof is unavailable.';end if;
 perform private.customer_write_actor(t.business_id,t.outlet_id,t.actor_id,t.auth_user_id);
 if t.snapshot_hash<>sha256(convert_to(private.inbox_write_context(t.business_id,t.outlet_id,(t.plan->>'itemId')::public.ulid)::text,'UTF8')) then raise sqlstate 'PT409' using message='The Inbox source changed.',detail='inbox_snapshot_changed';end if;
 if t.type='inbox.capture' then
  content:=t.plan->'input';bytes:=private.check_inbox_content(content,t.command_id,(t.plan->>'itemId')::public.ulid);image_count:=jsonb_array_length(content->'images');
  after_row.id:=(t.plan->>'itemId')::public.ulid;after_row.business_id:=t.business_id;after_row.outlet_id:=t.outlet_id;after_row.revision:=1;after_row.title:=(content->>'titleJson')::json;after_row.text:=(content->>'textJson')::json;after_row.url:=(content->>'urlJson')::json;after_row.kind:='unclassified';after_row.archived:=false;after_row.image_bytes:=bytes;
  after_row.created_at:=(t.plan->>'createdAt')::bigint;after_row.updated_at:=greatest(after_row.created_at,t.occurred_at);
  select coalesce(json_agg(json_build_object('id',x->>'id','name',(x->>'nameJson')::json,'type',x->>'type','size',(x->>'size')::integer) order by n),'[]'::json) into images from jsonb_array_elements(content->'images') with ordinality a(x,n);
  before_snapshot:='null'::json;command:='inbox.capture';
 else
  select * into before_row from public.inbox_items i where i.business_id=t.business_id and i.outlet_id=t.outlet_id and i.id=t.plan->>'itemId';
  if before_row.id is null or before_row.revision is distinct from (t.plan->>'revision')::bigint then raise sqlstate 'PT409' using message='Review the latest Inbox state.';end if;
  select coalesce(json_agg(json_build_object('id',i.id,'name',i.name,'type',i.type,'size',i.size) order by i.position),'[]'::json),count(*)::integer,coalesce(sum(i.size),0)::integer into images,image_count,bytes from public.inbox_images i where i.business_id=t.business_id and i.outlet_id=t.outlet_id and i.inbox_item_id=before_row.id;
  if bytes<>before_row.image_bytes or image_count>4 then raise invalid_parameter_value using message='Keep the original image metadata.';end if;
  before_snapshot:=private.inbox_snapshot(before_row,images);
  select * into latest from public.events e where e.business_id=t.business_id and e.outlet_id=t.outlet_id and e.inbox_id=before_row.id and e.inbox_revision is not null order by e.inbox_revision desc limit 1;
  if latest.id is null or latest.inbox_revision<>before_row.revision or latest.at<>before_row.updated_at or latest.actor_type<>'member' or latest.command not in ('inbox.capture','inbox.classify','inbox.archive','inbox.reopen') or private.inbox_snapshot_matches(latest.after_data,before_snapshot) is not true then raise invalid_parameter_value using message='Keep the complete source history.';end if;
  after_row:=before_row;
  if t.plan->'change' ? 'kind' then changed:=before_row.kind is distinct from t.plan->'change'->>'kind';after_row.kind:=t.plan->'change'->>'kind';command:='inbox.classify';
  else changed:=before_row.archived is distinct from (t.plan->'change'->>'archived')::boolean;after_row.archived:=(t.plan->'change'->>'archived')::boolean;command:=case when after_row.archived then 'inbox.archive' else 'inbox.reopen' end;end if;
  if changed then
   if before_row.revision>=9007199254740991 then raise sqlstate 'PT409' using message='Review this source before another revision.';end if;
   after_row.revision:=before_row.revision+1;after_row.updated_at:=greatest(t.occurred_at,before_row.updated_at);
  end if;
 end if;
 after_snapshot:=private.inbox_snapshot(after_row,images);
 if records is null or jsonb_typeof(records)<>'array' or octet_length(records::text)>1000000 or jsonb_array_length(records)<>(case when changed then 2+case when t.type='inbox.capture' then image_count else 0 end else 1 end)
  or exists(select 1 from jsonb_array_elements(records) x group by x->>'table',x->'values'->>'id' having count(*)>1) then raise invalid_parameter_value using message='Keep the complete Inbox source and audit together.';end if;
 for r in select x from jsonb_array_elements(records) x loop
  table_name:=r->>'table';v:=r->'values';allowed:=specs->table_name;
  if jsonb_typeof(r) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(r) k) is distinct from array['table','values'] or allowed is null or jsonb_typeof(v) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(allowed) or exists(select 1 from jsonb_object_keys(v) k where not allowed ? k) then raise invalid_parameter_value using message='Keep exact Inbox record columns.';end if;
  if table_name='inbox_items' then
   item_count:=item_count+1;expected:=jsonb_build_object('id',after_row.id,'business_id',t.business_id,'outlet_id',t.outlet_id,'revision',after_row.revision,'title',after_row.title::text,'text',after_row.text::text,'url',after_row.url::text,'kind',after_row.kind,'archived',after_row.archived,'created_at',after_row.created_at,'updated_at',after_row.updated_at);
   if v is distinct from expected then raise invalid_parameter_value using message='Sorting cannot rewrite an original source.';end if;
  elsif table_name='inbox_images' then
   image_records:=image_records+1;
   if t.type<>'inbox.capture' or jsonb_typeof(v->'position') is distinct from 'number' or (v->>'position')::numeric<>trunc((v->>'position')::numeric) or (v->>'position')::numeric not between 0 and image_count-1 then raise invalid_parameter_value using message='Keep original image positions.';end if;
   position:=(v->>'position')::integer;image:=content->'images'->position;
   expected:=jsonb_build_object('id',image->>'id','business_id',t.business_id,'outlet_id',t.outlet_id,'inbox_item_id',after_row.id,'position',position,'name',image->>'nameJson','type',image->>'type','size',(image->>'size')::integer,'sha256',image->>'sha256','created_at',after_row.created_at,'updated_at',after_row.created_at,'uploaded_at',null);
   if v is distinct from expected then raise invalid_parameter_value using message='Keep exact original image metadata; upload original bytes separately.';end if;
  else
   audit_count:=audit_count+1;
   expected:=jsonb_build_object('id',t.command_id,'business_id',t.business_id,'outlet_id',t.outlet_id,'actor_type','member','actor_id',t.actor_id,'command',case when changed then command else 'command.noop' end,'at',case when changed then after_row.updated_at else t.created_at end,'inbox_id',case when changed then after_row.id else null end,'inbox_revision',case when changed then after_row.revision else null end,'undo_of',null,'customer_id',null,'order_id',null,'order_revision',null,'stock_item_id',null,'stock_revision',null,'supplier_id',null,'closing_id',null,'handoff_id',null,'handoff_revision',null,'handoff_topic',null);
   if (v-'before_data'-'after_data') is distinct from expected or jsonb_typeof(v->'before_data') is distinct from 'string' or jsonb_typeof(v->'after_data') is distinct from 'string'
    then raise invalid_parameter_value using message='Keep the exact source history and acting member.';end if;
   if not changed then
    metadata:=jsonb_build_object('type',t.type,'itemId',after_row.id,'revision',after_row.revision,'change',t.plan->'change');
    if (v->>'before_data')::jsonb is distinct from metadata or (v->>'after_data')::jsonb is distinct from metadata then raise invalid_parameter_value using message='An unchanged choice records only its command metadata.';end if;
   elsif private.inbox_snapshot_matches((v->>'after_data')::json,after_snapshot) is not true then raise invalid_parameter_value using message='Keep the exact resulting source snapshot.';
   elsif t.type='inbox.capture' then
    if json_typeof((v->>'before_data')::json) is distinct from 'null' then raise invalid_parameter_value using message='Keep the original capture root.';end if;
   elsif private.inbox_snapshot_matches((v->>'before_data')::json,before_snapshot) is not true then raise invalid_parameter_value using message='Keep the exact source predecessor.';end if;
  end if;
 end loop;
 if item_count<>(case when changed then 1 else 0 end) or audit_count<>1 or image_records<>(case when t.type='inbox.capture' then image_count else 0 end) then raise invalid_parameter_value using message='Keep the complete Inbox transaction.';end if;
 if changed then
  if t.type='inbox.capture' then
   insert into public.inbox_items(id,business_id,outlet_id,revision,title,text,url,kind,archived,created_at,updated_at) values(after_row.id,t.business_id,t.outlet_id,1,after_row.title,after_row.text,after_row.url,'unclassified',false,after_row.created_at,after_row.updated_at);
   position:=0;for image in select x from jsonb_array_elements(content->'images') x loop
    insert into public.inbox_images(id,business_id,outlet_id,inbox_item_id,position,name,type,size,sha256,created_at,updated_at,uploaded_at) values((image->>'id')::public.ulid,t.business_id,t.outlet_id,after_row.id,position,(image->>'nameJson')::json,image->>'type',(image->>'size')::integer,image->>'sha256',after_row.created_at,after_row.created_at,null);position:=position+1;
   end loop;
  else update public.inbox_items i set kind=after_row.kind,archived=after_row.archived,revision=after_row.revision,updated_at=after_row.updated_at where i.business_id=t.business_id and i.outlet_id=t.outlet_id and i.id=after_row.id;end if;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,inbox_id,inbox_revision) values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,command,before_snapshot,after_snapshot,after_row.updated_at,after_row.id,after_row.revision);
 else
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values(t.command_id,t.business_id,t.outlet_id,'member',t.actor_id,'command.noop',metadata::json,metadata::json,t.created_at);
 end if;
 metadata:=jsonb_build_object('id',t.command_id,'type',t.type,'itemId',after_row.id,'outletId',t.outlet_id,'occurredAt',t.occurred_at,'at',t.created_at,'createdAt',after_row.created_at,'updatedAt',after_row.updated_at,'revision',after_row.revision,'kind',after_row.kind,'archived',after_row.archived,'imageCount',image_count,'imageBytes',bytes,'changed',changed,'eventId',case when changed then t.command_id else null end);
 insert into private.shop_command_receipts(id,business_id,outlet_id,actor_id,auth_user_id,type,customer_id,request_hash,receipt) values(t.command_id,t.business_id,t.outlet_id,t.actor_id,t.auth_user_id,t.type,null,t.request_hash,metadata);
 delete from private.inbox_write_tickets x where x.id=t.id;return metadata;
end $$;

revoke all on function private.inbox_literal_stats(json),private.check_inbox_content(jsonb,public.ulid,public.ulid),private.inbox_snapshot(public.inbox_items,json),private.inbox_json_tokens(json),private.inbox_snapshot_matches(json,json),private.inbox_write_context(public.ulid,public.ulid,public.ulid),private.admit_inbox_write(public.ulid),private.prepare_inbox_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),private.finish_inbox_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.admit_inbox_write(public.ulid),private.prepare_inbox_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function private.finish_inbox_write(public.ulid,text,jsonb) to service_role;
create function public.admit_inbox_write(p_outlet_id public.ulid) returns boolean language sql security invoker set search_path='' as $$select private.admit_inbox_write(p_outlet_id)$$;
create function public.prepare_inbox_write(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_inbox_write(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at)$$;
create function public.finish_inbox_write(p_ticket_id public.ulid,p_token text,p_records jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.finish_inbox_write(p_ticket_id,p_token,p_records)$$;
revoke all on function public.admit_inbox_write(public.ulid),public.prepare_inbox_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms),public.finish_inbox_write(public.ulid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admit_inbox_write(public.ulid),public.prepare_inbox_write(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms) to authenticated;
grant execute on function public.finish_inbox_write(public.ulid,text,jsonb) to service_role;
