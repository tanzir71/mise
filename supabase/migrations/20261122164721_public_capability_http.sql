-- Customer reads enter through one bounded service-only HTTP transport. Keep
-- the original capability, audit and financial rows; counters carry no token.
alter table private.public_links
 add column read_window_at public.utc_ms not null default 0,
 add column read_count integer not null default 0 check(read_count between 0 and 60000);

create table private.public_read_budget (
 id boolean primary key default true check(id),
 window_at public.utc_ms not null default 0,
 requests integer not null default 0 check(requests between 0 and 60000)
);
insert into private.public_read_budget(id) values(true);
alter table private.public_read_budget enable row level security;
alter table private.public_read_budget force row level security;
revoke all on private.public_read_budget from public,anon,authenticated,service_role;

-- Direct invoker RPCs would bypass the HTTP budget. Preserve their definitions
-- for the migration history, but remove every API-role execution grant.
revoke all on function public.read_order_link(text),public.read_khata_link(text,bigint,integer),
 private.read_public_link(text,text,bigint,integer) from public,anon,authenticated,service_role;

create function private.read_public_capability(secret text,link_kind text,after_sequence bigint,page_size integer,global_limit integer,link_limit integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare budget private.public_read_budget; cap private.public_links; at_ms public.utc_ms; window_ms public.utc_ms; result jsonb;
begin
 if link_kind is null or link_kind not in ('order','khata') or after_sequence is null or after_sequence<0 or after_sequence>9007199254740991
  or page_size is null or page_size not between 1 and 100 or link_kind='order' and (after_sequence<>0 or page_size<>50)
  or global_limit is null or global_limit not between 1 and 60000 or link_limit is null or link_limit not between 1 and 60000 then
  raise invalid_parameter_value using message='Use a bounded customer link read.';
 end if;
 -- The fixed global row bounds unknown-token traffic without storing random
 -- attacker-supplied identifiers or trusting caller-supplied IP headers.
 select * into budget from private.public_read_budget b where b.id for update;
 if not found then raise exception using message='Customer links are unavailable.';end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;window_ms:=(at_ms/60000)*60000;
 if budget.window_at=window_ms and budget.requests>=global_limit then
  return jsonb_build_object('v',1,'state','limited','retryAfter',greatest(1,ceil((window_ms+60000-at_ms)/1000.0)::integer));
 end if;
 update private.public_read_budget set window_at=window_ms,requests=case when budget.window_at=window_ms then budget.requests+1 else 1 end where id;
 if secret is null or secret!~'^[A-Za-z0-9_-]{43}$' then return jsonb_build_object('v',1,'state','missing');end if;
 -- The lock order is always global budget, then capability. Revocation locks
 -- only the capability, so a completed revoke is observed on the next read.
 select * into cap from private.public_links c where c.token_hash=sha256(convert_to(secret,'UTF8')) and c.kind=link_kind for update;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;window_ms:=(at_ms/60000)*60000;
 if not found or cap.revoked_at is not null or cap.expires_at<=at_ms then return jsonb_build_object('v',1,'state','missing');end if;
 if cap.read_window_at=window_ms and cap.read_count>=link_limit then
  return jsonb_build_object('v',1,'state','limited','retryAfter',greatest(1,ceil((window_ms+60000-at_ms)/1000.0)::integer));
 end if;
 update private.public_links set read_window_at=window_ms,read_count=case when cap.read_window_at=window_ms then cap.read_count+1 else 1 end where id=cap.id;
 -- A projection that cannot safely represent its ledger must still consume
 -- the reservation. Keep its read error inside a separate subtransaction.
 begin
  result:=private.read_public_link(secret,link_kind,after_sequence,page_size);
 exception when others then
  return jsonb_build_object('v',1,'state','unavailable');
 end;
 if result is null or cap.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint then return jsonb_build_object('v',1,'state','missing');end if;
 return jsonb_build_object('v',1,'state','ok','data',result);
end $$;
revoke all on function private.read_public_capability(text,text,bigint,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_public_capability(text,text,bigint,integer,integer,integer) to service_role;
grant usage on schema private to service_role;

create function public.read_public_capability(p_token text,p_kind text,p_after_sequence bigint default 0,p_page_size integer default 50,p_global_limit integer default 3000,p_link_limit integer default 60)
returns jsonb language sql security invoker set search_path='' as $$
 select private.read_public_capability(p_token,p_kind,p_after_sequence,p_page_size,p_global_limit,p_link_limit)
$$;
revoke all on function public.read_public_capability(text,text,bigint,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_public_capability(text,text,bigint,integer,integer,integer) to service_role;
