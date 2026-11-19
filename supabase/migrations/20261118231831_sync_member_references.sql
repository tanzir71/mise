-- Historical references are not staff access. Never broaden members_read or
-- manufacture an outlet assignment merely to satisfy a downloaded foreign key.
create table private.sync_member_pending (
 transaction_id xid8 not null,business_id public.ulid not null,outlet_id public.ulid not null,member_id public.ulid not null,
 primary key(transaction_id,business_id,outlet_id,member_id)
);
alter table private.sync_member_pending enable row level security;
alter table private.sync_member_pending force row level security;
revoke all on private.sync_member_pending from public,anon,authenticated,service_role;
alter function private.sync_columns(text) rename to sync_columns_v1;
create function private.sync_columns(kind text) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select case when kind='member_refs' then '["id","business_id","created_at","updated_at","name","role"]'::jsonb else private.sync_columns_v1(kind) end
$$;

-- Every source is an actual FK in the portable shop projection. Restrict the
-- lookup by business/member before outlet; the existing FK indexes cover it.
create function private.sync_member_reference_outlets(business public.ulid,member public.ulid) returns setof public.ulid
language sql stable security invoker set search_path='' as $$
 select outlet_id from public.events where business_id=business and actor_member_id=member
 union select outlet_id from public.orders where business_id=business and created_by=member
 union select outlet_id from public.orders where business_id=business and handled_by=member
 union select outlet_id from public.sales where business_id=business and created_by=member
 union select outlet_id from public.credit_entries where business_id=business and created_by=member
 union select outlet_id from public.order_notes where business_id=business and created_by=member
 union select outlet_id from public.order_communications where business_id=business and created_by=member
 union select outlet_id from public.order_refunds where business_id=business and created_by=member
 union select outlet_id from public.stock_moves where business_id=business and created_by=member
 union select outlet_id from public.supplier_messages where business_id=business and created_by=member
 union select outlet_id from public.day_closings where business_id=business and created_by=member
 union select outlet_id from public.purchases where business_id=business and created_by=member
$$;
create index sync_member_reference_idx on private.sync_changes(business_id,record_id,outlet_id) where table_name='member_refs';

create function private.sync_refresh_member_reference(business public.ulid,outlet public.ulid,member public.ulid) returns void
language plpgsql security invoker set search_path='' as $$
declare profile public.members;latest private.sync_changes;data json;
begin
 if member is null then return;end if;
 select * into latest from private.sync_changes c where c.business_id=business and c.outlet_id=outlet and c.record_id=member and c.table_name='member_refs' order by c.id desc limit 1;
 if exists(select 1 from private.sync_member_reference_outlets(business,member) scope where scope=outlet) then
  select * into profile from public.members m where m.business_id=business and m.id=member;
  if not found then raise foreign_key_violation using message='Keep the original historical member.';end if;
  data:=private.sync_project('member_refs',profile);
  if latest.operation='upsert' and latest.payload=convert_to(data::text,'UTF8') then return;end if;
  perform private.sync_emit(business,outlet,'member_refs',member,'upsert',data);
 else
  if latest.id is not null and latest.operation<>'delete' then perform private.sync_emit(business,outlet,'member_refs',member,'delete',null);end if;
 end if;
end $$;

-- Coalesce a batch's thousands of FK touches without client-writable markers.
-- Only this transaction's first private queue row schedules a deferred refresh.
create function private.sync_enqueue_member_reference(business public.ulid,outlet public.ulid,member public.ulid) returns void
language plpgsql security invoker set search_path='' as $$begin
 if member is not null then insert into private.sync_member_pending values(pg_current_xact_id(),business,outlet,member) on conflict do nothing;end if;
end $$;
create function private.sync_flush_member_reference() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if tg_table_schema<>'private' or tg_table_name<>'sync_member_pending' or new.transaction_id<>pg_current_xact_id() then raise insufficient_privilege using message='Invalid historical reference batch.';end if;
 perform private.sync_refresh_member_reference(new.business_id,new.outlet_id,new.member_id);
 delete from private.sync_member_pending p where p.transaction_id=new.transaction_id and p.business_id=new.business_id and p.outlet_id=new.outlet_id and p.member_id=new.member_id;return null;
end $$;
create constraint trigger mise_sync_member_flush after insert on private.sync_member_pending deferrable initially deferred for each row execute function private.sync_flush_member_reference();

create function private.sync_member_reference_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare field text;member public.ulid;business public.ulid;outlet public.ulid;
begin
 if tg_table_schema<>'public' or tg_table_name not in ('events','orders','sales','credit_entries','order_notes','order_communications','order_refunds','stock_moves','supplier_messages','day_closings','purchases') then
  raise insufficient_privilege using message='Invalid historical reference source.';
 end if;
 foreach field in array tg_argv loop
  if field not in ('actor_member_id','created_by','handled_by') then raise insufficient_privilege using message='Invalid historical reference field.';end if;
  if tg_op<>'INSERT' then
   execute format('select ($1).business_id,($1).outlet_id,($1).%I',field) into business,outlet,member using old;
   perform private.sync_enqueue_member_reference(business,outlet,member);
  end if;
  if tg_op<>'DELETE' then
   execute format('select ($1).business_id,($1).outlet_id,($1).%I',field) into business,outlet,member using new;
   perform private.sync_enqueue_member_reference(business,outlet,member);
  end if;
 end loop;
 return null;
end $$;

create function private.sync_member_profile_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare outlet public.ulid;
begin
 if tg_table_schema<>'public' or tg_table_name<>'members' then raise insufficient_privilege using message='Invalid historical member source.';end if;
 if tg_op='DELETE' then
  for outlet in select distinct c.outlet_id from private.sync_changes c where c.business_id=old.business_id and c.record_id=old.id and c.table_name='member_refs' loop
   perform private.sync_enqueue_member_reference(old.business_id,outlet,old.id);
  end loop;
 else
  for outlet in select * from private.sync_member_reference_outlets(new.business_id,new.id) loop
   perform private.sync_enqueue_member_reference(new.business_id,outlet,new.id);
  end loop;
 end if;
 return null;
end $$;

do $$declare relation text;profile public.members;outlet public.ulid;begin
 foreach relation in array array['orders','sales','credit_entries','order_notes','order_communications','order_refunds','stock_moves','supplier_messages','day_closings','purchases'] loop
  execute format('create trigger mise_sync_member_reference after insert or update or delete on public.%I for each row execute function private.sync_member_reference_trigger(%L%s)',relation,'created_by',case when relation='orders' then ',''handled_by''' else '' end);
 end loop;
 create trigger mise_sync_member_reference after insert or update or delete on public.events for each row execute function private.sync_member_reference_trigger('actor_member_id');
 create trigger mise_sync_member_profile after update or delete on public.members for each row execute function private.sync_member_profile_trigger();
 for profile in select * from public.members loop
  for outlet in select * from private.sync_member_reference_outlets(profile.business_id,profile.id) loop
   perform private.sync_enqueue_member_reference(profile.business_id,outlet,profile.id);
  end loop;
 end loop;
 -- Old cursors cannot prove a complete base before dependency capture existed.
 update private.sync_epoch set id=gen_random_uuid();
end $$;
revoke all on function private.sync_columns(text),private.sync_columns_v1(text),private.sync_member_reference_outlets(public.ulid,public.ulid),private.sync_refresh_member_reference(public.ulid,public.ulid,public.ulid),private.sync_enqueue_member_reference(public.ulid,public.ulid,public.ulid),private.sync_flush_member_reference(),private.sync_member_reference_trigger(),private.sync_member_profile_trigger() from public,anon,authenticated,service_role;

-- Privileged maintenance must not leave historical profiles after TRUNCATE.
create function private.sync_member_truncate_trigger() returns trigger language plpgsql security definer set search_path='' as $$
declare reference record;
begin
 if tg_table_schema<>'public' then raise insufficient_privilege using message='Invalid historical reference maintenance.';end if;
 for reference in select distinct business_id,outlet_id,record_id from private.sync_changes where table_name='member_refs' loop
  perform private.sync_enqueue_member_reference(reference.business_id,reference.outlet_id,reference.record_id);
 end loop;
 update private.sync_epoch set id=gen_random_uuid();return null;
end $$;
do $$declare relation text;begin foreach relation in array array['events','orders','sales','credit_entries','order_notes','order_communications','order_refunds','stock_moves','supplier_messages','day_closings','purchases','members'] loop
 execute format('create trigger mise_sync_member_truncate after truncate on public.%I for each statement execute function private.sync_member_truncate_trigger()',relation);
end loop;end $$;
revoke all on function private.sync_member_truncate_trigger() from public,anon,authenticated,service_role;
