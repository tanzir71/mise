-- Preserve existing membership-first locks and require the same verified,
-- non-anonymous phone account as operator discovery, before accessing bytes.
create or replace function private.inbox_image_context(image_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare image public.inbox_images;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This image is unavailable.';end if;
  select * into image from public.inbox_images i where i.id=image_id;
  if not found then raise insufficient_privilege using message='This image is unavailable.';end if;
  perform private.public_link_actor(image.business_id,image.outlet_id);
  perform private.operator_account_hash();
  if not exists(select 1 from storage.buckets where id='mise-inbox' and not public) then
    raise object_not_in_prerequisite_state using message='Private image storage is unavailable.';
  end if;
  return jsonb_build_object('id',image.id,'businessId',image.business_id,'outletId',image.outlet_id,'inboxId',image.inbox_item_id,
    'path',image.storage_path,'type',image.type,'size',image.size,'sha256',image.sha256,'uploadedAt',image.uploaded_at);
end $$;

create or replace function private.complete_inbox_image(image_id public.ulid,event_id public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare image public.inbox_images; actor public.ulid; at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if (select auth.uid()) is null then raise insufficient_privilege using message='This image is unavailable.';end if;
  select * into image from public.inbox_images i where i.id=image_id for update;
  if not found then raise insufficient_privilege using message='This image is unavailable.';end if;
  actor:=private.public_link_actor(image.business_id,image.outlet_id);
  perform private.operator_account_hash();
  -- Only trusted servers can write this bucket. Its sha256 user metadata is
  -- supplied after actual byte verification, not copied from the browser.
  if not exists(select 1 from storage.objects o join storage.buckets b on b.id=o.bucket_id
    where b.id='mise-inbox' and not b.public and o.name=image.storage_path
      and o.metadata->'size'=to_jsonb(image.size) and o.metadata->>'mimetype'=image.type
      and o.user_metadata->>'sha256'=image.sha256) then
    raise object_not_in_prerequisite_state using message='Upload the original image first.';
  end if;
  if image.uploaded_at is not null then return jsonb_build_object('id',image.id,'uploadedAt',image.uploaded_at);end if;
  update public.inbox_images set uploaded_at=at_ms where id=image.id;
  insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at,inbox_id)
    values(event_id,image.business_id,image.outlet_id,'member',actor,'inbox.image.upload',
      jsonb_build_object('imageId',image.id,'uploadedAt',null)::json,
      jsonb_build_object('imageId',image.id,'uploadedAt',at_ms)::json,at_ms,image.inbox_item_id);
  return jsonb_build_object('id',image.id,'uploadedAt',at_ms);
end $$;

revoke all on function private.inbox_image_context(public.ulid),private.complete_inbox_image(public.ulid,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.inbox_image_context(public.ulid),private.complete_inbox_image(public.ulid,public.ulid) to authenticated;
