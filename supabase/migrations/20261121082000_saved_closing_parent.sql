-- Bind automatic undo to its saved parent generation, outside the immutable
-- command. The ordinary ticket then pins that exact parent through completion.
create function private.prepare_saved_closing(command_id public.ulid,ticket_id public.ulid,kind text,outlet public.ulid,ids jsonb,fingerprint text,occurred public.utc_ms,parent_event public.ulid) returns jsonb
language plpgsql security definer set search_path='' as $$declare prepared jsonb;business public.ulid;c public.day_closings;
begin
 if kind<>'closing.undo' and parent_event is not null then raise invalid_parameter_value using message='Choose a saved closing undo parent.';end if;
 prepared:=private.prepare_closing_write(command_id,ticket_id,kind,outlet,ids,fingerprint,occurred);
 -- A genuine completed command outranks a later parent/day change.
 if prepared->>'done'='true' then return prepared;end if;
 if kind='closing.undo' then
  business:=(prepared->>'businessId')::public.ulid;
  select * into c from public.day_closings x where x.business_id=business and x.outlet_id=outlet and x.id=ids->>'closingId' for update;
  if parent_event is null or c.id is null or c.event_id is distinct from parent_event then raise sqlstate 'PT409' using message='The original closing parent changed. Review this saved undo.';end if;
 end if;
 return prepared;
end $$;
revoke all on function private.prepare_saved_closing(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,public.ulid) from public,anon,authenticated,service_role;
grant execute on function private.prepare_saved_closing(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,public.ulid) to authenticated;
create function public.prepare_saved_closing(p_id public.ulid,p_ticket_id public.ulid,p_type text,p_outlet_id public.ulid,p_plan jsonb,p_hash text,p_occurred_at public.utc_ms,p_parent_event_id public.ulid) returns jsonb
language sql security invoker set search_path='' as $$select private.prepare_saved_closing(p_id,p_ticket_id,p_type,p_outlet_id,p_plan,p_hash,p_occurred_at,p_parent_event_id)$$;
revoke all on function public.prepare_saved_closing(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,public.ulid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_saved_closing(public.ulid,public.ulid,text,public.ulid,jsonb,text,public.utc_ms,public.ulid) to authenticated;
