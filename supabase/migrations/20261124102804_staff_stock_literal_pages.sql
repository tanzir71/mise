-- Preserve the full supported imported stock source without double quoting
-- or JSONB decoding. This unpublished read protocol keeps its public grants,
-- current-PIN authorization and budget, adding whole-item byte pagination.
-- The original applied migration stays immutable; both wrappers change type
-- together in this transaction. No writer, account or provider is enabled.
drop function public.read_staff_stock_page(text,text,public.ulid,integer,integer);
drop function private.read_staff_stock_page(text,text,public.ulid,integer,integer);
create function private.read_staff_stock_page(device_secret text,session_secret text,after_id public.ulid,page_limit integer,request_limit integer) returns json
language plpgsql volatile security definer set search_path='' set lock_timeout='2s' as $$
declare actor jsonb;business public.ulid;outlet public.ulid;device public.ulid;session_id public.ulid;member public.ulid;
 at_ms public.utc_ms;window_ms bigint;requests integer;rows json[]:='{}';next_id public.ulid;last_id public.ulid;outlet_name json;item_row public.stock_items;item_json json;item_bytes integer;page_bytes integer:=2;
begin
 if page_limit is null or page_limit not between 1 and 100 or request_limit is null or request_limit not between 1 and 60000 then
  raise invalid_parameter_value using message='Use a bounded stock page.';end if;
 actor:=private.read_device_session(device_secret,session_secret);
 if actor is null or not actor->'permissions' ? 'stock.read' then return json_build_object('v',1,'state','missing');end if;
 business:=(actor->>'businessId')::public.ulid;outlet:=(actor->>'outletId')::public.ulid;device:=(actor->>'deviceId')::public.ulid;
 session_id:=(actor->>'sessionId')::public.ulid;member:=(actor->>'memberId')::public.ulid;
 -- Team and stock mutations serialize at this same outlet. Lock identities too
 -- so permission/PIN/revocation changes cannot race the returned projection.
 perform 1 from public.businesses b where b.id=business for share;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for share;
 perform 1 from private.devices d where d.id=device for share;
 perform 1 from private.device_sessions s where s.id=session_id for share;
 perform 1 from public.members m where m.business_id=business and m.id=member for share;
 perform 1 from private.staff_pins p where p.business_id=business and p.member_id=member for share;
 perform 1 from public.member_outlets a where a.business_id=business and a.outlet_id=outlet and a.member_id=member for share;
 perform 1 from private.staff_profiles p where p.business_id=business and p.outlet_id=outlet and p.member_id=member for share;
 actor:=private.read_device_session(device_secret,session_secret);at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if actor is null or not actor->'permissions' ? 'stock.read' or (actor->>'expiresAt')::bigint<=at_ms or not exists(
  select 1 from private.devices d where d.id=device and d.revoked_at is null and d.expires_at>at_ms) then
  return json_build_object('v',1,'state','missing');end if;
 window_ms:=at_ms-at_ms%60000;
 insert into private.staff_stock_budget as b values(device,window_ms,1) on conflict(device_id) do update
  set window_at=excluded.window_at,request_count=case when b.window_at=excluded.window_at then least(b.request_count+1,60001) else 1 end
  returning request_count into requests;
 if requests>request_limit then return json_build_object('v',1,'state','limited','retryAfter',greatest(1,ceil((window_ms+60000-at_ms)/1000.0)::integer));end if;
 select o.name into outlet_name from public.outlets o where o.business_id=business and o.id=outlet;
 -- Return native JSON values: JSONB cannot decode every legitimate imported
 -- UTF-16/control value, and quoting JSON text again needlessly expands it.
 -- Keep whole items, bounded by both count and the 50 MiB backup byte limit.
 for item_row in select s.* from public.stock_items s
  where s.business_id=business and s.outlet_id=outlet and s.archived_at is null
   and (after_id is null or s.id>after_id) order by s.id limit page_limit+1 loop
  if cardinality(rows)>=page_limit then next_id:=last_id;exit;end if;
  item_json:=json_build_object('id',item_row.id,'outletId',item_row.outlet_id,'revision',item_row.revision,
   'name',item_row.name,'nameLocal',item_row.name_local,'unit',item_row.unit,'category',item_row.category,'aliases',item_row.aliases,
   'onHand',item_row.on_hand,'target',item_row.target,'packSize',item_row.pack_size,'lowAt',item_row.low_at,'lastCountedAt',item_row.last_counted_at,
   'eventId',item_row.event_id,'createdAt',item_row.created_at,'updatedAt',item_row.updated_at);
  item_bytes:=octet_length(item_json::text);
  if item_bytes>52428800 then raise sqlstate 'PT413' using message='This stock item exceeds the supported backup size.';end if;
  if cardinality(rows)>0 and page_bytes+item_bytes+1>52428800 then next_id:=last_id;exit;end if;
  rows:=array_append(rows,item_json);page_bytes:=page_bytes+item_bytes+1;last_id:=item_row.id;
 end loop;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if (actor->>'expiresAt')::bigint<=at_ms or not exists(select 1 from private.devices d where d.id=device and d.expires_at>at_ms) then
  return json_build_object('v',1,'state','missing');end if;
 return json_build_object('v',1,'state','stock','access',actor,'outletName',outlet_name,'serverAt',at_ms,'items',array_to_json(rows),'next',next_id);
end $$;
revoke all on function private.read_staff_stock_page(text,text,public.ulid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_staff_stock_page(text,text,public.ulid,integer,integer) to service_role;
create function public.read_staff_stock_page(p_device_token text,p_session_token text,p_after_id public.ulid,p_limit integer,p_request_limit integer) returns json
language sql security invoker set search_path='' as $$select private.read_staff_stock_page(p_device_token,p_session_token,p_after_id,p_limit,p_request_limit)$$;
revoke all on function public.read_staff_stock_page(text,text,public.ulid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_staff_stock_page(text,text,public.ulid,integer,integer) to service_role;
