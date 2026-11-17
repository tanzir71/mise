-- Initial migration buffers are private; no existing business can be overwritten.
create table private.initial_uploads (
  id public.ulid primary key,auth_user_id uuid not null references auth.users(id) on delete cascade,
  business_id public.ulid not null,outlet_id public.ulid not null,owner_id public.ulid not null,
  manifest text not null check(octet_length(manifest)<=65536),manifest_hash text not null check(manifest_hash~'^[0-9a-f]{64}$'),
  state text not null default 'staging' check(state in ('staging','committed','canceled')),
  created_at public.utc_ms not null,expires_at public.utc_ms not null,
  lease_id public.ulid,lease_hash bytea,lease_until public.utc_ms,receipt jsonb,
  check((lease_id is null and lease_hash is null and lease_until is null) or (lease_id is not null and octet_length(lease_hash)=32 and lease_until is not null)),
  check((state='committed')=(receipt is not null))
);
create unique index initial_upload_active_business on private.initial_uploads(business_id) where state<>'canceled';
create unique index initial_upload_active_user on private.initial_uploads(auth_user_id) where state='staging';
create index initial_upload_user_idx on private.initial_uploads(auth_user_id,expires_at);
create index initial_upload_business_idx on private.initial_uploads(business_id,auth_user_id);
create table private.initial_upload_chunks (
  upload_id public.ulid not null references private.initial_uploads(id) on delete cascade,
  position integer not null check(position between 0 and 199),data bytea not null check(octet_length(data) between 1 and 393216),
  primary key(upload_id,position)
);
alter table private.initial_uploads enable row level security;alter table private.initial_uploads force row level security;
alter table private.initial_upload_chunks enable row level security;alter table private.initial_upload_chunks force row level security;
revoke all on private.initial_uploads,private.initial_upload_chunks from public,anon,authenticated,service_role;

create function private.upload_integer(value jsonb,maximum numeric default 9007199254740991) returns boolean
language sql immutable security invoker set search_path='' as $$
 select case when jsonb_typeof(value)='number' then value::text::numeric between 0 and maximum and trunc(value::text::numeric)=value::text::numeric else false end
$$;
create function private.upload_manifest(source text,fingerprint text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare j jsonb;part jsonb;n integer;records numeric:=0;key text;names text[]:=array['businesses','outlets','members','categories','items','events','sales','customers','creditAccounts','creditEntries','orders','orderNotes','orderCommunications','orderRefunds','stockItems','stockMoves','suppliers','supplierMessages','dayClosings','purchases','inboxItems'];
begin
  if source is null or octet_length(source)>65536 or source~E'[^\\t\\n\\r -~]' or fingerprint is null or fingerprint!~'^[0-9a-f]{64}$' or encode(sha256(convert_to(source,'UTF8')),'hex')<>fingerprint then raise invalid_parameter_value using message='Invalid upload manifest.';end if;
  j:=source::jsonb;
  if jsonb_typeof(j)<>'object' or not(j?&array['version','id','businessId','outletId','ownerId','exportedAt','counts','records','images','imageBytes','snapshotBytes','snapshotHash','reviewHash','chunks']) or j-array['version','id','businessId','outletId','ownerId','exportedAt','counts','records','images','imageBytes','snapshotBytes','snapshotHash','reviewHash','chunks']<>'{}'::jsonb or j->'version'<>'1'::jsonb then raise invalid_parameter_value using message='Invalid upload manifest.';end if;
  foreach key in array array['id','businessId','outletId','ownerId'] loop
    if jsonb_typeof(j->key)<>'string' or j->>key!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' then raise invalid_parameter_value using message='Invalid upload scope.';end if;
  end loop;
  foreach key in array array['snapshotHash','reviewHash'] loop
    if jsonb_typeof(j->key)<>'string' or j->>key!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Invalid upload digest.';end if;
  end loop;
  if not private.upload_integer(j->'exportedAt',8640000000000000) or not private.upload_integer(j->'records') or not private.upload_integer(j->'images') or not private.upload_integer(j->'imageBytes',52428800) or not private.upload_integer(j->'snapshotBytes',52428800) or (j->>'snapshotBytes')::integer=0 or jsonb_typeof(j->'counts')<>'object' or not(j->'counts'?&names) or (j->'counts')-names<>'{}'::jsonb then raise invalid_parameter_value using message='Invalid upload sizes.';end if;
  foreach key in array names loop
    if not private.upload_integer(j->'counts'->key) then raise invalid_parameter_value using message='Invalid upload counts.';end if;records:=records+(j->'counts'->>key)::numeric;
  end loop;
  if records<>(j->>'records')::numeric or records>9007199254740991 or j->'counts'->'businesses'<>'1'::jsonb or j->'counts'->'outlets'<>'1'::jsonb or j->'counts'->'members'<>'1'::jsonb or jsonb_typeof(j->'chunks')<>'array' or jsonb_array_length(j->'chunks')<>ceil((j->>'snapshotBytes')::numeric/262144) then raise invalid_parameter_value using message='Invalid upload counts.';end if;
  for n in 0..jsonb_array_length(j->'chunks')-1 loop
    part:=j->'chunks'->n;
    if jsonb_typeof(part)<>'object' or not(part?&array['index','rawBytes','bytes','sha256']) or part-array['index','rawBytes','bytes','sha256']<>'{}'::jsonb or part->'index'<>to_jsonb(n) or part->'rawBytes'<>to_jsonb(least(262144,(j->>'snapshotBytes')::integer-n*262144)) or not private.upload_integer(part->'bytes',393216) or (part->>'bytes')::integer=0 or jsonb_typeof(part->'sha256')<>'string' or part->>'sha256'!~'^[0-9a-f]{64}$' then raise invalid_parameter_value using message='Invalid upload chunk.';end if;
  end loop;
  return j;
end $$;
create function private.upload_identity(subject uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
begin
  if subject is null then raise insufficient_privilege using message='Upload access denied.';end if;
  perform 1 from auth.users u where u.id=subject and u.phone_confirmed_at is not null and coalesce(u.phone,'')<>'' and u.deleted_at is null and (u.banned_until is null or u.banned_until<=statement_timestamp()) for share;
  if not found then raise insufficient_privilege using message='Upload access denied.';end if;return subject;
end $$;
create function private.upload_owned(upload public.ulid) returns private.initial_uploads
language plpgsql security invoker set search_path='' as $$
declare s private.initial_uploads;subject uuid:=private.upload_identity((select auth.uid()));
begin
  select * into s from private.initial_uploads u where u.id=upload and u.auth_user_id=subject for update;
  if not found then raise insufficient_privilege using message='Upload access denied.';end if;
  if s.state='committed' then
    if private.public_link_actor(s.business_id,s.outlet_id)<>s.owner_id then raise insufficient_privilege using message='Upload access denied.';end if;
  elsif s.state='canceled' or s.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then raise sqlstate 'PT409' using message='Begin or review this upload again.';end if;
  return s;
end $$;
create function private.upload_progress(s private.initial_uploads) returns jsonb
language sql volatile security invoker set search_path='' as $$
 select jsonb_build_object('id',s.id,'manifestHash',s.manifest_hash,'receipt',s.receipt,'received',case when s.state='committed' then (select coalesce(jsonb_agg(n),'[]'::jsonb) from generate_series(0,jsonb_array_length(s.manifest::jsonb->'chunks')-1)n) else (select coalesce(jsonb_agg(c.position order by c.position),'[]'::jsonb) from private.initial_upload_chunks c where c.upload_id=s.id) end)
$$;
create function private.begin_initial_upload(source text,fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare subject uuid:=private.upload_identity((select auth.uid()));j jsonb:=private.upload_manifest(source,fingerprint);s private.initial_uploads;at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('initial-upload-user:'||subject::text,0));
  perform pg_advisory_xact_lock(hashtextextended('initial-upload-business:'||(j->>'businessId'),0));
  select * into s from private.initial_uploads u where u.id=j->>'id' for update;
  if found then
    if s.auth_user_id<>subject then raise insufficient_privilege using message='Upload access denied.';end if;
    if s.manifest_hash<>fingerprint or s.manifest<>source or s.state='canceled' then raise sqlstate 'PT409' using message='This upload ID belongs to another review.';end if;
    if s.state='committed' then perform private.upload_owned(s.id);else update private.initial_uploads set expires_at=at_ms+604800000 where id=s.id returning * into s;end if;
    return private.upload_progress(s);
  end if;
  if exists(select 1 from public.businesses b where b.id=j->>'businessId') or exists(select 1 from private.initial_uploads u where u.business_id=j->>'businessId' and u.auth_user_id<>subject) then raise insufficient_privilege using message='This shop cannot be imported.';end if;
  update private.initial_uploads set state='canceled',lease_id=null,lease_hash=null,lease_until=null where auth_user_id=subject and state='staging' and expires_at<=at_ms and coalesce(lease_until,0)<=at_ms;
  delete from private.initial_upload_chunks c using private.initial_uploads u where u.id=c.upload_id and u.auth_user_id=subject and u.state='canceled';
  if exists(select 1 from private.initial_uploads u where u.auth_user_id=subject and u.state='staging') then raise sqlstate 'PT409' using message='Resume or cancel your existing upload first.';end if;
  insert into private.initial_uploads(id,auth_user_id,business_id,outlet_id,owner_id,manifest,manifest_hash,created_at,expires_at)
    values(j->>'id',subject,j->>'businessId',j->>'outletId',j->>'ownerId',source,fingerprint,at_ms,at_ms+604800000) returning * into s;
  return private.upload_progress(s);
end $$;
create function private.initial_upload_info(upload public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.initial_uploads:=private.upload_owned(upload);
begin return jsonb_build_object('manifest',s.manifest,'authUserId',s.auth_user_id,'progress',private.upload_progress(s));end $$;
create function private.put_initial_upload_chunk(upload public.ulid,chunk_index integer,source text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.initial_uploads:=private.upload_owned(upload);part jsonb;body bytea;previous bytea;
begin
  if s.state='committed' then return private.upload_progress(s);end if;
  if chunk_index is null or chunk_index<0 or chunk_index>=jsonb_array_length(s.manifest::jsonb->'chunks') or source is null or length(source)>524288 or length(source)%4<>0 or source!~'^[A-Za-z0-9+/]*={0,2}$' then raise invalid_parameter_value using message='Invalid upload part.';end if;
  part:=s.manifest::jsonb->'chunks'->chunk_index;body:=decode(source,'base64');
  if octet_length(body)<>(part->>'bytes')::integer or encode(sha256(body),'hex')<>part->>'sha256' then raise invalid_parameter_value using message='Upload part does not match its review.';end if;
  select c.data into previous from private.initial_upload_chunks c where c.upload_id=upload and c.position=chunk_index;
  if found and previous<>body then raise sqlstate 'PT409' using message='Upload part already exists.';end if;
  insert into private.initial_upload_chunks values(upload,chunk_index,body) on conflict do nothing;return private.upload_progress(s);
end $$;
create function private.read_initial_upload_chunk(upload public.ulid,chunk_index integer) returns text
language plpgsql security definer set search_path='' as $$
declare s private.initial_uploads:=private.upload_owned(upload);body bytea;
begin
  select c.data into body from private.initial_upload_chunks c where c.upload_id=s.id and c.position=chunk_index;
  if not found then raise sqlstate 'PT409' using message='Upload part is unavailable.';end if;return replace(encode(body,'base64'),E'\n','');
end $$;
create function private.prepare_initial_upload(upload public.ulid,fingerprint text,lease public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.initial_uploads:=private.upload_owned(upload);at_ms public.utc_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;secret text;
begin
  if fingerprint is distinct from s.manifest_hash or lease is null then raise sqlstate 'PT409' using message='Upload review changed.';end if;
  if s.state='committed' then return jsonb_build_object('done',true,'progress',private.upload_progress(s));end if;
  if s.lease_until>at_ms then raise sqlstate 'PT409' using message='Upload finalization is still in progress.';end if;
  if (select count(*) from private.initial_upload_chunks c where c.upload_id=s.id)<>jsonb_array_length(s.manifest::jsonb->'chunks') then raise sqlstate 'PT409' using message='Upload every part first.';end if;
  secret:=rtrim(translate(encode(sha256(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())),'base64'),'+/','-_'),'=');
  update private.initial_uploads set lease_id=lease,lease_hash=sha256(convert_to(secret,'UTF8')),lease_until=at_ms+120000 where id=s.id;
  return jsonb_build_object('done',false,'manifest',s.manifest,'authUserId',s.auth_user_id,'leaseId',lease,'token',secret);
end $$;
create function private.cancel_initial_upload(upload public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s private.initial_uploads;subject uuid:=private.upload_identity((select auth.uid()));
begin
  select * into s from private.initial_uploads u where u.id=upload and u.auth_user_id=subject for update;
  if not found then raise insufficient_privilege using message='Upload access denied.';end if;
  if s.state='committed' or s.lease_until>floor(extract(epoch from clock_timestamp())*1000)::bigint then raise sqlstate 'PT409' using message='Keep or wait for the accepted upload.';end if;
  update private.initial_uploads set state='canceled',lease_id=null,lease_hash=null,lease_until=null where id=s.id;
  delete from private.initial_upload_chunks where upload_id=s.id;return jsonb_build_object('id',s.id,'canceled',true);
end $$;

-- Public wrappers remain invokers. Only the original JWT can manage its staging.
create function private.initial_upload_identity() returns uuid language plpgsql security definer set search_path='' as $$begin return private.upload_identity((select auth.uid()));end$$;
create function public.initial_upload_identity() returns uuid language sql security invoker set search_path='' as $$select private.initial_upload_identity()$$;
create function public.begin_initial_upload(p_manifest text,p_hash text) returns jsonb language sql security invoker set search_path='' as $$select private.begin_initial_upload(p_manifest,p_hash)$$;
create function public.initial_upload_info(p_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.initial_upload_info(p_id)$$;
create function public.put_initial_upload_chunk(p_id public.ulid,p_index integer,p_data text) returns jsonb language sql security invoker set search_path='' as $$select private.put_initial_upload_chunk(p_id,p_index,p_data)$$;
create function public.read_initial_upload_chunk(p_id public.ulid,p_index integer) returns text language sql security invoker set search_path='' as $$select private.read_initial_upload_chunk(p_id,p_index)$$;
create function public.prepare_initial_upload(p_id public.ulid,p_hash text,p_lease public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.prepare_initial_upload(p_id,p_hash,p_lease)$$;
create function public.cancel_initial_upload(p_id public.ulid) returns jsonb language sql security invoker set search_path='' as $$select private.cancel_initial_upload(p_id)$$;
do $$declare f record;begin
  for f in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname in ('upload_integer','upload_manifest','upload_identity','upload_owned','upload_progress','initial_upload_identity','begin_initial_upload','initial_upload_info','put_initial_upload_chunk','read_initial_upload_chunk','prepare_initial_upload','cancel_initial_upload') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname in ('initial_upload_identity','begin_initial_upload','initial_upload_info','put_initial_upload_chunk','read_initial_upload_chunk','prepare_initial_upload','cancel_initial_upload') then execute format('grant execute on function %s to authenticated',f.signature);end if;
  end loop;
end $$;
