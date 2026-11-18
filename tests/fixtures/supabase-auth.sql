-- Test-only Auth boundary for the embedded PostgreSQL suite.
-- This is never a migration and must never be loaded into a Supabase project.
create role anon nologin nobypassrls;
create role authenticated nologin nobypassrls;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key,
  phone text,
  phone_confirmed_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean not null default false,
  raw_user_meta_data jsonb not null default '{}'
);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
