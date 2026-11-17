-- M30, increment 1: tenancy and identity. No browser write path or sync is enabled.
-- New public objects must opt in to API access, including on older Supabase projects.
revoke create on schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
-- Built-in PUBLIC function execution is a global default. A schema-local REVOKE
-- cannot subtract it; every new postgres-owned function must grant execution explicitly.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;

create schema private;
revoke all on schema private from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke execute on functions from anon, authenticated, service_role;

create domain public.ulid as text
  check (value ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$');
create domain public.utc_ms as bigint
  check (value between 0 and 8640000000000000);

create table public.businesses (
  id public.ulid primary key,
  name text not null check (length(btrim(name)) between 1 and 160),
  business_type text not null
    check (business_type in ('restaurant', 'online_shop', 'food_stall', 'corner_shop')),
  market_code text not null check (market_code ~ '^[A-Z]{2}$'),
  languages text[] not null default '{en}'
    check (cardinality(languages) between 1 and 8 and array_position(languages, null) is null),
  created_at public.utc_ms not null,
  updated_at public.utc_ms not null check (updated_at >= created_at)
);

create table public.outlets (
  id public.ulid primary key,
  business_id public.ulid not null references public.businesses(id),
  name text not null check (length(btrim(name)) between 1 and 160),
  address text not null default '' check (length(address) <= 2000),
  timezone text not null check (length(timezone) between 1 and 80),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  opening_hours jsonb not null default '{}' check (jsonb_typeof(opening_hours) = 'object'),
  delivery_zones jsonb not null default '[]' check (jsonb_typeof(delivery_zones) = 'array'),
  created_at public.utc_ms not null,
  updated_at public.utc_ms not null check (updated_at >= created_at),
  unique (business_id, id)
);

create table public.members (
  id public.ulid primary key,
  business_id public.ulid not null references public.businesses(id),
  -- auth.users uses UUIDs. Domain records retain the device-generated ULID.
  -- Deleting an Auth identity immediately removes its access without deleting shop history.
  auth_user_id uuid references auth.users(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 160),
  name_local text not null default '' check (length(name_local) <= 160),
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  role text not null check (role in ('owner', 'manager', 'staff', 'kitchen', 'rider', 'agent')),
  permissions jsonb not null default '{}' check (jsonb_typeof(permissions) = 'object'),
  active boolean not null default true,
  created_at public.utc_ms not null,
  updated_at public.utc_ms not null check (updated_at >= created_at),
  unique (business_id, id),
  unique (business_id, auth_user_id)
);

-- Composite foreign keys prevent attaching a member to another business's outlet.
-- A manager with no assignment has no outlet access. Owners cover their whole business.
create table public.member_outlets (
  business_id public.ulid not null,
  member_id public.ulid not null,
  outlet_id public.ulid not null,
  primary key (business_id, member_id, outlet_id),
  foreign key (business_id, member_id) references public.members(business_id, id),
  foreign key (business_id, outlet_id) references public.outlets(business_id, id)
);

create index members_auth_user_id_idx on public.members(auth_user_id)
  where auth_user_id is not null;
create index member_outlets_outlet_idx on public.member_outlets(business_id, outlet_id, member_id);

alter table public.businesses enable row level security;
alter table public.businesses force row level security;
alter table public.outlets enable row level security;
alter table public.outlets force row level security;
alter table public.members enable row level security;
alter table public.members force row level security;
alter table public.member_outlets enable row level security;
alter table public.member_outlets force row level security;

-- This narrowly privileged lookup breaks membership-policy recursion. It accepts no
-- caller-selected identity/business and never uses user_metadata or JWT role hints.
-- Staff/device and agent authentication are not enabled by this foundation.
-- Bans with a deadline are checked against server time, not the browser clock.
create function private.current_access()
returns table (member_id public.ulid, business_id public.ulid, role text, outlet_ids public.ulid[])
language sql stable security definer
set search_path = ''
as $$
  select m.id, m.business_id, m.role,
    case when m.role = 'owner' then
      array(select o.id from public.outlets o where o.business_id = m.business_id)
    when m.role = 'manager' then
      array(select mo.outlet_id from public.member_outlets mo
        where mo.business_id = m.business_id and mo.member_id = m.id)
    else array[]::public.ulid[] end
  from public.members m
  join auth.users u on u.id = m.auth_user_id
  where m.auth_user_id = (select auth.uid())
    and m.active
    and u.phone_confirmed_at is not null
    and coalesce(u.phone, '') <> ''
    and (u.banned_until is null or u.banned_until <= now())
    and u.deleted_at is null
$$;
revoke all on function private.current_access() from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.current_access() to authenticated;

create policy businesses_read on public.businesses for select to authenticated
  using (id in (select a.business_id from private.current_access() a
    where a.role = 'owner' or cardinality(a.outlet_ids) > 0));

create policy outlets_read on public.outlets for select to authenticated
  using (id in (select unnest(a.outlet_ids) from private.current_access() a));

create policy members_read on public.members for select to authenticated
  using (
    id in (select a.member_id from private.current_access() a)
    or business_id in (select a.business_id from private.current_access() a where a.role = 'owner')
    or id in (
      select mo.member_id from public.member_outlets mo
      where mo.outlet_id in (
        select unnest(a.outlet_ids) from private.current_access() a where a.role = 'manager'
      )
    )
  );

create policy member_outlets_read on public.member_outlets for select to authenticated
  using (
    member_id in (select a.member_id from private.current_access() a)
    or business_id in (select a.business_id from private.current_access() a where a.role = 'owner')
    or outlet_id in (
      select unnest(a.outlet_ids) from private.current_access() a where a.role = 'manager'
    )
  );

-- No direct write policy/grant: mutation and membership administration must pass through
-- validated transactional commands and an audit event in a later M30 increment.
revoke all on public.businesses, public.outlets, public.members, public.member_outlets
  from public, anon, authenticated, service_role;
grant select on public.businesses, public.outlets, public.members, public.member_outlets
  to authenticated;
