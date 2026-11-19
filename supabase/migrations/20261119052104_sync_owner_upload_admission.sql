-- Historical receipts stay unknown. Only a real future promotion stamps its XID.
alter table private.initial_uploads add column admission_xid xid8;
create function private.owner_upload_receipt_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_schema<>'private' or tg_table_name<>'initial_uploads' then raise insufficient_privilege using message='Invalid upload receipt boundary.';end if;
 if tg_op='INSERT' then
  if new.state='committed' or new.receipt is not null or new.admission_xid is not null then raise insufficient_privilege using message='Keep the original upload promotion.';end if;
 elsif old.state='committed' then
  if row_to_json(new)::text is distinct from row_to_json(old)::text then raise insufficient_privilege using message='Keep the original accepted upload receipt.';end if;
 elsif new.state='committed' then
  if old.state<>'staging' or old.receipt is not null or new.receipt is null or new.admission_xid is not null then raise insufficient_privilege using message='Keep the original upload promotion.';end if;
  new.admission_xid:=pg_current_xact_id();
 elsif new.admission_xid is not null then raise insufficient_privilege using message='Keep the original upload promotion.';
 end if;
 return new;
end $$;
create trigger mise_owner_upload_receipt_identity before insert or update on private.initial_uploads
 for each row execute function private.owner_upload_receipt_identity();
revoke all on function private.owner_upload_receipt_identity() from public,anon,authenticated,service_role;

-- A read-only fact about the original promotion in this exact completed window.
-- No Auth identity, lease, token, XID, connection setting or grant is returned.
create function private.read_sync_upload_coverage(window_id public.ulid,outlet public.ulid,upload public.ulid,fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb;w private.sync_read_windows;s private.initial_uploads;state text;at_ms public.utc_ms;
begin
 if window_id is null or outlet is null or upload is null or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Keep the original upload and download identities.';end if;
 actor:=private.sync_read_actor(outlet);
 if actor->>'role'<>'owner' then raise insufficient_privilege using message='Review the original owner upload.';end if;
 select * into w from private.sync_read_windows x where x.id=window_id for share;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if w.id is null or w.auth_user_id<>(select auth.uid()) or w.actor_id::text<>actor->>'actorId' or w.business_id::text<>actor->>'businessId' or w.outlet_id<>outlet then raise insufficient_privilege using message='This sync review is unavailable.';end if;
 if w.expires_at<=at_ms or w.epoch::text<>actor->>'epoch' or w.scope_version::text<>actor->>'scopeVersion' or w.actor_role<>actor->>'role' then raise sqlstate 'PT409' using message='Prepare a fresh sync review from its accepted cursor.';end if;
 if not w.done or w.previous_cursor is not null then raise invalid_parameter_value using message='Complete the original bootstrap download first.';end if;
 -- Legacy upload reads lock their upload first. Never wait in the reverse order.
 begin
  select * into s from private.initial_uploads u where u.id=upload and u.auth_user_id=w.auth_user_id and u.business_id=w.business_id and u.outlet_id=w.outlet_id and u.owner_id=w.actor_id for share nowait;
 exception when lock_not_available then raise sqlstate 'PT409' using message='Retry the original upload review.';
 end;
 if s.id is null then raise insufficient_privilege using message='This upload review is unavailable.';end if;
 if s.manifest_hash<>fingerprint or s.state<>'committed' or s.receipt is null then raise sqlstate 'PT409' using message='Keep the original accepted upload receipt.';end if;
 state:=case when s.admission_xid is null then 'unknown' when pg_visible_in_snapshot(s.admission_xid,w.current_snapshot) then 'visible' else 'later' end;
 return actor||jsonb_build_object('v',1,'id',w.id,'uploadId',s.id,'manifestHash',s.manifest_hash,'receipt',s.receipt,'state',state,'snapshot',w.current_snapshot::text);
end $$;
revoke all on function private.read_sync_upload_coverage(public.ulid,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function private.read_sync_upload_coverage(public.ulid,public.ulid,public.ulid,text) to authenticated;
create function public.read_sync_upload_coverage(p_id public.ulid,p_outlet_id public.ulid,p_upload_id public.ulid,p_manifest_hash text) returns jsonb
language sql security invoker set search_path='' as $$select private.read_sync_upload_coverage(p_id,p_outlet_id,p_upload_id,p_manifest_hash)$$;
revoke all on function public.read_sync_upload_coverage(public.ulid,public.ulid,public.ulid,text) from public,anon,authenticated,service_role;
grant execute on function public.read_sync_upload_coverage(public.ulid,public.ulid,public.ulid,text) to authenticated;
