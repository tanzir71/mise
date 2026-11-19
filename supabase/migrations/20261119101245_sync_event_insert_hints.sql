-- Append-only audit events wake the verified cursor reader. No payload is applied
-- directly by a device. Exclude UPDATE/DELETE/TRUNCATE from the publication.
do $$
declare publication_id oid;
begin
  if not exists(select 1 from pg_class where oid='public.events'::regclass
    and relrowsecurity and relforcerowsecurity)
    or has_table_privilege('anon','public.events','select') then
    raise exception 'Secure event access before enabling Realtime hints.';
  end if;
  select oid into publication_id from pg_publication where pubname='supabase_realtime';
  if publication_id is not null then
    if exists(select 1 from pg_publication where oid=publication_id and puballtables)
      or exists(select 1 from pg_publication_namespace where pnpubid=publication_id)
      or exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
        and (schemaname,tablename) is distinct from ('public','events')) then
      raise exception 'Review existing Realtime tables before changing their publication.';
    end if;
    alter publication supabase_realtime set (publish='insert');
  else
    create publication supabase_realtime with (publish='insert');
  end if;
  if not exists(select 1 from pg_publication_rel r join pg_publication p on p.oid=r.prpubid
    where p.pubname='supabase_realtime' and r.prrelid='public.events'::regclass) then
    alter publication supabase_realtime add table only public.events;
  end if;
end;
$$;
