-- Shared server validation supplies fixed primitive fields; SQL supplies scope/atomicity.
create function private.finish_initial_upload(upload public.ulid,lease public.ulid,secret text,records jsonb,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.initial_uploads;j jsonb;row_data jsonb;v jsonb;t text;allowed text[];names text;expressions text;inserted bigint;expected numeric;local_name text;entry record;image public.inbox_images;
  at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  columns jsonb:='{"businesses":["id","created_at","updated_at","name","business_type","market_code","languages"],"outlets":["id","created_at","updated_at","business_id","name","address","timezone","currency","shop_link","credit_messaging","order_warning_minutes"],"members":["id","created_at","updated_at","business_id","name","phone","role","active","auth_user_id"],"categories":["id","created_at","updated_at","outlet_id","name","sort","business_id"],"items":["id","created_at","updated_at","outlet_id","name","name_local","category_id","price","unit","available","is_sample","often_bought","business_id"],"customers":["id","created_at","updated_at","business_id","name","nickname","phone","address","notes","tags","consent","archived_at"],"credit_accounts":["id","created_at","updated_at","outlet_id","customer_id","currency","allowed","credit_limit","reminder","business_id"],"credit_entries":["id","created_at","updated_at","outlet_id","created_by","event_id","account_id","customer_id","currency","sequence","type","amount","note","sale_id","order_id","refund_id","returns_charge_id","method_name","occurred_at","reversal_of","purpose","over_limit","business_id"],"orders":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","business_type","sequence","number","source","source_text","customer_id","customer_name","customer_phone","type","status","status_changed_at","status_event_id","lines","subtotal","delivery_fee","discount","total","currency","timezone","address","table_label","scheduled_for","payment","handled_by","business_id"],"sales":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","order_number","closing_id","delivery_fee","discount","expression","amount","currency","method","method_name","given","change","who","customer_id","credit_account_id","items","shop_name","shop_link","timezone","void_reason","business_id"],"order_notes":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","order_id","text","business_id"],"order_communications":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","order_id","purpose","channel","text","business_id"],"order_refunds":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","order_id","sale_id","customer_id","account_id","amount","currency","method","method_name","note","credit_entry_id","business_id"],"suppliers":["id","created_at","updated_at","outlet_id","revision","name","phone","note","archived_at","event_id","business_id"],"stock_items":["id","created_at","updated_at","outlet_id","revision","name","name_local","active_key","unit","category","aliases","on_hand","target","pack_size","low_at","supplier_id","archived_at","last_counted_at","event_id","business_id"],"stock_moves":["id","created_at","updated_at","outlet_id","created_by","event_id","revision","stock_item_id","name","unit","before_quantity","after_quantity","delta","reason","source","note","count_batch_id","undo_of","business_id"],"supplier_messages":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","supplier_id","supplier_name","phone","text","channel","stock_item_ids","part","parts","business_id"],"day_closings":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","active_key","day","timezone","currency","summary","counted_cash","expected_cash","difference","added_walk_in","added_sale_id","note","preview_fingerprint","created_by_name","business_id"],"purchases":["id","created_at","updated_at","outlet_id","created_by","event_id","voided_at","supplier_id","supplier_name","reference","lines","total","currency","timezone","paid","method_name","note","photo_ref","business_id"],"inbox_items":["id","created_at","updated_at","outlet_id","revision","title","text","url","kind","archived","business_id"],"events":["id","outlet_id","actor_type","actor_id","command","before_data","after_data","at","undo_of","customer_id","order_id","order_revision","stock_item_id","stock_revision","supplier_id","closing_id","handoff_id","handoff_revision","handoff_topic","inbox_id","inbox_revision","business_id"],"member_outlets":["business_id","member_id","outlet_id"],"customer_outlets":["business_id","outlet_id","customer_id"],"inbox_images":["id","business_id","outlet_id","inbox_item_id","position","name","type","size","sha256","created_at","updated_at","uploaded_at"]}'::jsonb;
  local_tables jsonb:='{"businesses":"businesses","outlets":"outlets","members":"members","categories":"categories","items":"items","customers":"customers","credit_accounts":"creditAccounts","credit_entries":"creditEntries","orders":"orders","sales":"sales","order_notes":"orderNotes","order_communications":"orderCommunications","order_refunds":"orderRefunds","suppliers":"suppliers","stock_items":"stockItems","stock_moves":"stockMoves","supplier_messages":"supplierMessages","day_closings":"dayClosings","purchases":"purchases","inbox_items":"inboxItems","events":"events"}'::jsonb;
begin
  select * into s from private.initial_uploads u where u.id=upload;
  if not found then raise insufficient_privilege using message='Upload access denied.';end if;
  perform private.upload_identity(s.auth_user_id);
  perform pg_advisory_xact_lock(hashtextextended('initial-upload-business:'||s.business_id,0));
  select * into s from private.initial_uploads u where u.id=upload for update;
  if not found or lease is null or s.lease_id is distinct from lease or secret is null or secret!~'^[A-Za-z0-9_-]{43}$' or s.lease_hash is distinct from sha256(convert_to(secret,'UTF8')) then raise insufficient_privilege using message='Upload proof is unavailable.';end if;
  if s.state='committed' then
    perform 1 from public.members m where m.id=s.owner_id and m.business_id=s.business_id and m.auth_user_id=s.auth_user_id and m.active and (m.role='owner' or (m.role='manager' and exists(select 1 from public.member_outlets a where a.business_id=s.business_id and a.member_id=m.id and a.outlet_id=s.outlet_id))) for share;
    if not found then raise insufficient_privilege using message='Upload access denied.';end if;return private.upload_progress(s);
  end if;
  if s.state<>'staging' or s.expires_at<=at_ms or s.lease_until<=at_ms then raise sqlstate 'PT409' using message='Prepare this upload again.';end if;
  if exists(select 1 from public.businesses b where b.id=s.business_id) then raise sqlstate 'PT409' using message='This shop already exists.';end if;
  j:=s.manifest::jsonb;
  if jsonb_typeof(records)<>'array' or jsonb_array_length(records)<>(j->>'records')::numeric+1+(j->'counts'->>'customers')::numeric+(j->>'images')::numeric or event_id is null then raise invalid_parameter_value using message='Invalid validated upload records.';end if;
  if (select count(*) from private.initial_upload_chunks c where c.upload_id=s.id)<>jsonb_array_length(j->'chunks') then raise sqlstate 'PT409' using message='Upload every part first.';end if;
  set constraints all deferred;
  for row_data in select value from jsonb_array_elements(records) loop
    if jsonb_typeof(row_data)<>'object' or not(row_data?&array['table','values']) or row_data-array['table','values']<>'{}'::jsonb or jsonb_typeof(row_data->'table')<>'string' or not(columns? (row_data->>'table')) or jsonb_typeof(row_data->'values')<>'object' then raise invalid_parameter_value using message='Invalid validated upload table.';end if;
    t:=row_data->>'table';v:=row_data->'values';select array_agg(value) into allowed from jsonb_array_elements_text(columns->t);
    if not(v?&allowed) or v-allowed<>'{}'::jsonb or exists(select 1 from jsonb_each(v) e where jsonb_typeof(e.value) not in ('string','number','boolean','null')) then raise invalid_parameter_value using message='Invalid validated upload fields.';end if;
    if (t='businesses' and v->>'id' is distinct from s.business_id::text) or (t<>'businesses' and v->>'business_id' is distinct from s.business_id::text) or (v?'outlet_id' and v->>'outlet_id' is distinct from s.outlet_id::text) or (t='outlets' and v->>'id' is distinct from s.outlet_id::text) or (t='members' and (v->>'id' is distinct from s.owner_id::text or v->>'auth_user_id' is distinct from s.auth_user_id::text or v->>'role'<>'owner' or v->'active'<>'true'::jsonb)) or (t='member_outlets' and v->>'member_id' is distinct from s.owner_id::text) then raise insufficient_privilege using message='Upload scope changed.';end if;
    select string_agg(format('%I',a.name),',' order by a.n),string_agg(format('($1->>%L)::%s',a.name,format_type(p.atttypid,p.atttypmod)),',' order by a.n)
      into names,expressions from unnest(allowed) with ordinality a(name,n) join pg_attribute p on p.attrelid=('public.'||quote_ident(t))::regclass and p.attname=a.name and not p.attisdropped and p.attgenerated='';
    if names is null or expressions is null then raise invalid_parameter_value using message='Unsupported upload schema.';end if;
    execute format('insert into public.%I(%s) select %s',t,names,expressions) using v;
  end loop;
  for entry in select key,value from jsonb_each_text(local_tables) loop
    t:=entry.key;local_name:=entry.value;
    execute format('select count(*) from public.%I where %I=$1',t,case when t='businesses' then 'id' else 'business_id' end) into inserted using s.business_id;
    expected:=(j->'counts'->>local_name)::numeric;
    if inserted<>expected then raise invalid_parameter_value using message='Upload record counts changed.';end if;
  end loop;
  if (select count(*) from public.member_outlets where business_id=s.business_id)<>1 or (select count(*) from public.customer_outlets where business_id=s.business_id)<>(j->'counts'->>'customers')::numeric or (select count(*) from public.inbox_images where business_id=s.business_id)<>(j->>'images')::numeric then raise invalid_parameter_value using message='Upload association counts changed.';end if;
  for image in select * from public.inbox_images i where i.business_id=s.business_id loop
    if not exists(select 1 from storage.objects o join storage.buckets b on b.id=o.bucket_id where b.id='mise-inbox' and not b.public and o.name=image.storage_path and o.metadata->'size'=to_jsonb(image.size) and o.metadata->>'mimetype'=image.type and o.user_metadata->>'sha256'=image.sha256) then raise object_not_in_prerequisite_state using message='Verify every original image before importing.';end if;
    update public.inbox_images set uploaded_at=at_ms where id=image.id;
  end loop;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
    values(event_id,s.business_id,s.outlet_id,'member',s.owner_id,'sync.initial_upload','null',jsonb_build_object('uploadId',s.id,'snapshotHash',j->>'snapshotHash','counts',j->'counts','images',j->'images')::json,at_ms);
  -- Force all original cross-record checks before sealing the receipt.
  set constraints all immediate;
  update private.initial_uploads set state='committed',receipt=jsonb_build_object('id',s.id,'businessId',s.business_id,'outletId',s.outlet_id,'snapshotHash',j->>'snapshotHash','records',j->'records','images',j->'images','at',at_ms) where id=s.id returning * into s;
  delete from private.initial_upload_chunks where upload_id=s.id;
  return private.upload_progress(s);
end $$;
revoke all on function private.finish_initial_upload(public.ulid,public.ulid,text,jsonb,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.finish_initial_upload(public.ulid,public.ulid,text,jsonb,public.ulid) to service_role;
create function public.finish_initial_upload(p_id public.ulid,p_lease public.ulid,p_token text,p_records jsonb,p_event public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.finish_initial_upload(p_id,p_lease,p_token,p_records,p_event)$$;
revoke all on function public.finish_initial_upload(public.ulid,public.ulid,text,jsonb,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.finish_initial_upload(public.ulid,public.ulid,text,jsonb,public.ulid) to service_role;
create function private.release_initial_upload(upload public.ulid,lease public.ulid,secret text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update private.initial_uploads set lease_id=null,lease_hash=null,lease_until=null
    where id=upload and state='staging' and lease_id=lease and lease_hash=sha256(convert_to(secret,'UTF8'));
  return found;
end $$;
revoke all on function private.release_initial_upload(public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function private.release_initial_upload(public.ulid,public.ulid,text) to service_role;
create function public.release_initial_upload(p_id public.ulid,p_lease public.ulid,p_token text) returns boolean
language sql security invoker set search_path='' as $$select private.release_initial_upload(p_id,p_lease,p_token)$$;
revoke all on function public.release_initial_upload(public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function public.release_initial_upload(public.ulid,public.ulid,text) to service_role;
