-- Test-only Storage metadata/RLS boundary; no object server or actual bytes.
-- Never load this into a Supabase project. Storage itself owns these tables.
create schema storage;
create table storage.buckets(id text primary key,name text not null,public boolean not null default false);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null references storage.buckets(id),name text not null,
  metadata jsonb,user_metadata jsonb,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon,authenticated,service_role;
grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
-- Deliberately permissive: the application restriction must still protect its
-- bucket without interfering with unrelated buckets. This is a fixture only.
create policy fixture_allow on storage.objects to anon,authenticated using(true) with check(true);
