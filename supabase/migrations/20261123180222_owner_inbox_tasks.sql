-- M37 human Inbox. Customer text is data; no action here writes money, stock,
-- order status, attendance or provider state. Kitchen tasks keep their lifecycle.
create table private.owner_task_definitions (
 task_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 mode text not null check(mode in('decision','message','check')),recipient text check(recipient~'^\+[1-9][0-9]{6,14}$'),
 prepared public.literal_text not null,urgent boolean not null,created_by public.ulid not null,
 foreign key(business_id,outlet_id,task_id) references public.tasks(business_id,outlet_id,id) on delete cascade,
 foreign key(business_id,created_by) references public.members(business_id,id) deferrable initially deferred
);
create index owner_task_definition_actor on private.owner_task_definitions(business_id,created_by);
create table private.owner_task_actions (
 auth_user_id uuid not null,id public.ulid not null,business_id public.ulid not null,outlet_id public.ulid not null,actor_id public.ulid not null,
 intent_json text not null check(octet_length(intent_json)<=131072),state text not null check(state in('applied','closed')),
 outcome json not null,created_at public.utc_ms not null,primary key(auth_user_id,id)
);
create index owner_task_actions_personal on private.owner_task_actions(auth_user_id,created_at);
create table private.owner_task_states (
 task_id public.ulid primary key,business_id public.ulid not null,outlet_id public.ulid not null,
 last_action_id public.ulid not null,revision bigint not null check(revision between 1 and 9007199254740991),undoable boolean not null,decision text check(decision in('allow','no','reply-myself','sent','fixed','reopen')),
 reply public.literal_text,
 foreign key(business_id,outlet_id,task_id) references public.tasks(business_id,outlet_id,id) on delete cascade
);
alter table private.owner_task_definitions enable row level security;
alter table private.owner_task_definitions force row level security;
alter table private.owner_task_actions enable row level security;
alter table private.owner_task_actions force row level security;
alter table private.owner_task_states enable row level security;
alter table private.owner_task_states force row level security;
revoke all on private.owner_task_definitions,private.owner_task_actions,private.owner_task_states from public,anon,authenticated,service_role;
create index owner_task_active_page on public.tasks(business_id,outlet_id,(coalesce(due_at,8640000000000000)),id) where status in('open','waiting');
create index owner_task_resolved_page on public.tasks(business_id,outlet_id,(coalesce(due_at,8640000000000000)),id) where status='resolved';
-- Standard JSON extraction decodes unrelated literal fields, including legacy
-- NUL/surrogates. Inspect only the closed ASCII routing fields lexically.
create function private.owner_khata_task_id(result json) returns public.ulid
language plpgsql immutable security invoker set search_path='' as $$
declare source json;
begin
 if private.confirmation_json_field(result,'state')::text is distinct from '"created"' then return null;end if;
 source:=private.confirmation_json_field(private.confirmation_json_field(result,'intent'),'taskId');
 return(source::jsonb#>>'{}')::public.ulid;
end $$;
revoke all on function private.owner_khata_task_id(json) from public,anon,authenticated,service_role;
create index customer_khata_owner_task on private.customer_khata_actions(private.owner_khata_task_id(outcome)) where private.owner_khata_task_id(outcome) is not null;
create trigger owner_task_definition_version after insert or update or delete on private.owner_task_definitions for each row execute function private.note_inbox_task_version();
create trigger owner_task_state_version after insert or update or delete on private.owner_task_states for each row execute function private.note_inbox_task_version();

-- Contacts and author names are part of a complete task projection too.
create function private.owner_task_dependency_version() returns trigger
language plpgsql security definer set search_path='' as $$
declare business public.ulid;
begin
 if tg_op='DELETE' then business:=old.business_id;else business:=new.business_id;end if;
 insert into private.inbox_task_versions as v select o.business_id,o.id,1 from public.outlets o where o.business_id=business
 on conflict(outlet_id) do update set version=v.version+1;
 return null;
end $$;
revoke all on function private.owner_task_dependency_version() from public,anon,authenticated,service_role;
create trigger owner_task_customer_version after update or delete on public.customers for each row execute function private.owner_task_dependency_version();
create trigger owner_task_author_version after update or delete on public.members for each row execute function private.owner_task_dependency_version();
create trigger owner_task_account_version after update or delete on public.credit_accounts for each row execute function private.owner_task_dependency_version();
create function private.owner_task_khata_version() returns trigger
language plpgsql security definer set search_path='' as $$
declare task public.tasks;source json;
begin
 if tg_op='DELETE' then source:=old.outcome;else source:=new.outcome;end if;
 if private.owner_khata_task_id(source) is not null then
  select * into task from public.tasks t where t.id=private.owner_khata_task_id(source);
  if found then insert into private.inbox_task_versions as v values(task.business_id,task.outlet_id,1) on conflict(outlet_id) do update set version=v.version+1;end if;
 end if;
 return null;
end $$;
revoke all on function private.owner_task_khata_version() from public,anon,authenticated,service_role;
create trigger owner_task_khata_source_version after insert or update or delete on private.customer_khata_actions for each row execute function private.owner_task_khata_version();

create function private.owner_task_account() returns uuid
language plpgsql stable security invoker set search_path='' as $$
declare account uuid:=(select auth.uid());
begin
 if account is null or not exists(select 1 from auth.users u where u.id=account and not u.is_anonymous and u.phone is not null and u.phone_confirmed_at is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=clock_timestamp())) then
  raise insufficient_privilege using message='Use the original verified phone account.';
 end if;return account;
end $$;
revoke all on function private.owner_task_account() from public,anon,authenticated,service_role;
create function private.owner_task_access(outlet public.ulid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare actor public.ulid;scope jsonb;
begin
 perform private.owner_task_account();actor:=private.public_shop_actor(outlet);
 select jsonb_build_object('v',1,'businessId',m.business_id,'outletId',outlet,'memberId',m.id,'role',m.role) into scope from public.members m where m.id=actor and m.role in('owner','manager');
 if scope is null then raise insufficient_privilege using message='Open an assigned outlet.';end if;return scope;
end $$;
revoke all on function private.owner_task_access(public.ulid) from public,anon,authenticated,service_role;

create function private.owner_task_projection(t public.tasks) returns json
language plpgsql stable security invoker set search_path='' as $$
declare d private.owner_task_definitions;s private.owner_task_states;a json;target json;source text:='unknown';mode text:='source';recipient text;
 prepared public.literal_text:='""';author public.literal_text;urgent boolean:=false;choices json;result json;stamp text;
begin
 select * into d from private.owner_task_definitions x where x.task_id=t.id and x.business_id=t.business_id and x.outlet_id=t.outlet_id;
 select * into s from private.owner_task_states x where x.task_id=t.id and x.business_id=t.business_id and x.outlet_id=t.outlet_id;
 if d.task_id is not null then
  source:='manual';mode:=d.mode;recipient:=d.recipient;prepared:=d.prepared;urgent:=d.urgent;
  select m.name into author from public.members m where m.business_id=t.business_id and m.id=d.created_by;
 elsif exists(select 1 from private.kitchen_alarm_tasks k where k.task_id=t.id and k.business_id=t.business_id and k.outlet_id=t.outlet_id) then
  source:='kitchen';urgent:=true;
  select json_build_object('kind','order','orderId',k.order_id) into target from private.kitchen_alarm_tasks k where k.task_id=t.id;
 elsif exists(select 1 from private.customer_khata_actions x where private.owner_khata_task_id(x.outcome) is not null and private.owner_khata_task_id(x.outcome)=t.id) then
  a:=t.actions->0;
  if private.staff_exact(a,array['accountId','customerId','entryId','kind']) and a->>'kind'='open-customer' then
   select c.phone into recipient from public.credit_accounts x join public.customers c on c.business_id=x.business_id and c.id=x.customer_id
    where x.business_id=t.business_id and x.outlet_id=t.outlet_id and x.id=a->>'accountId' and x.customer_id=a->>'customerId';
   if found then source:='khata';mode:='message';target:=json_build_object('kind','customer','customerId',a->>'customerId','accountId',a->>'accountId','entryId',a->>'entryId');end if;
  end if;
 end if;
 choices:=case when mode='source' then '[]'::json when t.status='resolved' then '["reopen"]'::json
  when mode='decision' and t.status='open' then '["allow","no","reply-myself"]'::json when mode='check' then '["fixed"]'::json else '["sent"]'::json end;
 if mode<>'source' and s.undoable then choices:=(choices::jsonb||'["undo"]'::jsonb)::json;end if;
 result:=json_build_object('id',t.id,'businessId',t.business_id,'outletId',t.outlet_id,'kind',t.kind,'titleJson',t.title::text,'bodyJson',t.body::text,
  'status',t.status,'dueAt',t.due_at,'createdAt',t.created_at,'updatedAt',t.updated_at,'source',source,'mode',mode,'recipient',recipient,
  'preparedJson',prepared::text,'authorJson',author::text,'target',target,'lastActionId',s.last_action_id,'undoable',coalesce(s.undoable,false),
  'decision',s.decision,'replyJson',s.reply::text,'urgent',urgent,'actions',choices);
 stamp:=encode(sha256(convert_to(row_to_json(t)::text||'|'||coalesce(row_to_json(s)::text,'')||'|'||result::text,'UTF8')),'hex');
 return (result::jsonb||jsonb_build_object('fingerprint',stamp))::json;
end $$;
revoke all on function private.owner_task_projection(public.tasks) from public,anon,authenticated,service_role;

create function private.read_owner_task_page(outlet public.ulid,task_filter text,after_at public.utc_ms,after_id public.ulid,expected_version bigint,page_size integer) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare scope jsonb;business public.ulid;version bigint;rows json;cursor json;more boolean;counts json;
begin
 scope:=private.owner_task_access(outlet);business:=(scope->>'businessId')::public.ulid;
 if task_filter is null or task_filter not in('active','resolved') or page_size is null or page_size not between 1 and 100 or (after_at is null)<>(after_id is null)
  or after_id is not null and expected_version is null or expected_version is not null and expected_version not between 0 and 9007199254740991 then raise invalid_parameter_value using message='Use the complete original task page.';end if;
 -- One SQL snapshot supplies rows, sources, counts and continuation version.
 with scoped as materialized(select t.id,t.kind,t.due_at from public.tasks t where t.business_id=business and t.outlet_id=outlet
  and(case when task_filter='active' then t.status in('open','waiting') else t.status='resolved' end)),
 candidates as materialized(select t.*,coalesce(t.due_at,8640000000000000) sort_at from scoped t
  where after_at is null or(coalesce(t.due_at,8640000000000000),t.id)>(after_at,after_id) order by coalesce(t.due_at,8640000000000000),t.id limit page_size+1),
 page as(select c.* from candidates c order by c.sort_at,c.id limit page_size)
 select (select coalesce(json_agg(private.owner_task_projection(t) order by p.sort_at,p.id),'[]'::json) from page p join public.tasks t on t.id=p.id),
  (select json_build_object('sortAt',p.sort_at,'id',p.id) from page p order by p.sort_at desc,p.id desc limit 1),
  (select count(*) from candidates)>(select count(*) from page),
  (select json_build_object('question',count(*) filter(where t.kind='question'),'failure',count(*) filter(where t.kind='failure'),
   'chat',count(*) filter(where t.kind='chat'),'check',count(*) filter(where t.kind='check'),'total',count(*),
   'urgent',count(*) filter(where coalesce(d.urgent,false) or k.task_id is not null))
   from scoped t left join private.owner_task_definitions d on d.task_id=t.id left join private.kitchen_alarm_tasks k on k.task_id=t.id),
  coalesce((select v.version from private.inbox_task_versions v where v.business_id=business and v.outlet_id=outlet),0)
 into rows,cursor,more,counts,version;
 if expected_version is not null and expected_version<>version then raise sqlstate 'PT409' using message='Tasks changed. Read the current Inbox again.';end if;
 return json_build_object('v',1,'access',scope,'at',floor(extract(epoch from clock_timestamp())*1000)::bigint,'version',version,'filter',task_filter,'counts',counts,'tasks',rows,'next',case when more then cursor else null end);
end $$;
revoke all on function private.read_owner_task_page(public.ulid,text,public.utc_ms,public.ulid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function private.read_owner_task_page(public.ulid,text,public.utc_ms,public.ulid,bigint,integer) to authenticated;
create function public.read_owner_task_page(p_outlet_id public.ulid,p_filter text default 'active',p_after_at public.utc_ms default null,p_after_id public.ulid default null,p_version bigint default null,p_limit integer default 50) returns json
language sql security invoker set search_path='' as $$select private.read_owner_task_page(p_outlet_id,p_filter,p_after_at,p_after_id,p_version,p_limit)$$;
revoke all on function public.read_owner_task_page(public.ulid,text,public.utc_ms,public.ulid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_owner_task_page(public.ulid,text,public.utc_ms,public.ulid,bigint,integer) to authenticated;

create function private.act_owner_task(outlet public.ulid,operation text,source_json text) returns json
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare account uuid;input json;control jsonb;scope jsonb;actor public.ulid;business public.ulid;action_id public.ulid;event_id public.ulid;task_id public.ulid;
 saved private.owner_task_actions;previous private.owner_task_actions;t public.tasks;before_image json;after_image json;answer json;stamp public.utc_ms;
 field text;stats integer[];choice text;next_status text;decision text;reply public.literal_text;undoable boolean:=false;
begin
 account:=private.owner_task_account();
 if operation is null or operation not in('submit','inspect','close') or source_json is null or octet_length(source_json)>131072 then raise invalid_parameter_value using message='Use the complete original task choice.';end if;
 begin
  input:=source_json::json;control:=input::jsonb;
  if control->>'type'='create' then
   if not private.staff_exact(input,array['at','bodyJson','eventId','id','kind','mode','preparedJson','recipient','scope','taskId','titleJson','type','urgent','v']) then raise invalid_parameter_value;end if;
   foreach field in array array['titleJson','bodyJson','preparedJson'] loop
    if jsonb_typeof(control->field)<>'string' then raise invalid_parameter_value;end if;
    stats:=private.inbox_literal_stats((control->>field)::json);
    if stats[1]>(case field when 'titleJson' then 200 when 'bodyJson' then 12000 else 4000 end) or field<>'preparedJson' and stats[2]<>1 then raise invalid_parameter_value;end if;
   end loop;
   if jsonb_typeof(control->'kind')<>'string' or control->>'kind' not in('question','failure','chat','check') or jsonb_typeof(control->'mode')<>'string' or control->>'mode' not in('decision','message','check') or jsonb_typeof(control->'urgent')<>'boolean' or jsonb_typeof(control->'taskId')<>'string'
    or control->'recipient'<>'null'::jsonb and(jsonb_typeof(control->'recipient')<>'string' or control->>'recipient'!~'^\+[1-9][0-9]{6,14}$') then raise invalid_parameter_value;end if;
   task_id:=(control->>'taskId')::public.ulid;
  elsif control->>'type'='act' then
   if not private.staff_exact(input,array['action','at','eventId','id','replyJson','scope','task','type','undoOf','v']) or jsonb_typeof(control->'task')<>'object' then raise invalid_parameter_value;end if;
   choice:=control->>'action';if choice is null or choice not in('allow','no','reply-myself','sent','fixed','reopen','undo') or jsonb_typeof(control->'replyJson')<>'string' then raise invalid_parameter_value;end if;
   reply:=(control->>'replyJson')::public.literal_text;stats:=private.inbox_literal_stats(reply);
   if stats[1]>4000 or choice='sent' and stats[2]<>1 or choice<>'sent' and reply::text<>'""' or(choice='undo')<>(control->'undoOf'<>'null'::jsonb) or control->'undoOf'<>'null'::jsonb and jsonb_typeof(control->'undoOf')<>'string' then raise invalid_parameter_value;end if;
   task_id:=(control->'task'->>'id')::public.ulid;
  else raise invalid_parameter_value;end if;
  if not private.staff_exact(input->'scope',array['businessId','memberId','outletId','role','v']) or control->>'v'<>'1' or jsonb_typeof(control->'v')<>'number' or control->'scope'->>'v'<>'1' or jsonb_typeof(control->'scope'->'v')<>'number'
   or jsonb_typeof(control->'scope'->'role')<>'string' or control->'scope'->>'role' not in('owner','manager') or control->'scope'->>'outletId' is distinct from outlet::text then raise invalid_parameter_value;end if;
  foreach field in array array['id','eventId'] loop if jsonb_typeof(control->field)<>'string' then raise invalid_parameter_value;end if;end loop;
  foreach field in array array['businessId','memberId','outletId'] loop if jsonb_typeof(control->'scope'->field)<>'string' then raise invalid_parameter_value;end if;end loop;
  business:=(control->'scope'->>'businessId')::public.ulid;actor:=(control->'scope'->>'memberId')::public.ulid;
  action_id:=(control->>'id')::public.ulid;event_id:=(control->>'eventId')::public.ulid;
  if action_id is null or event_id is null or task_id is null or action_id=event_id or action_id=task_id or event_id=task_id or business is null or actor is null
   or jsonb_typeof(control->'at')<>'number' or control->>'at'!~'^[0-9]+$' or(control->>'at')::numeric not between 0 and 8640000000000000 then raise invalid_parameter_value;end if;
 exception when others then raise invalid_parameter_value using message='Keep the complete original task choice.';end;
 perform pg_advisory_xact_lock(hashtextextended('mise:owner-task:'||account::text||':'||action_id::text,0));
 select * into saved from private.owner_task_actions a where a.auth_user_id=account and a.id=action_id for update;
 if found then
  if saved.intent_json<>source_json or saved.business_id<>business or saved.outlet_id<>outlet or saved.actor_id<>actor then raise sqlstate 'PT409' using message='Keep the original task choice.';end if;
  return saved.outcome;
 end if;
 stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if operation='inspect' then return json_build_object('v',1,'state','pending','intent',input,'at',null,'before',null,'after',null);end if;
 if operation='close' then
  if(select count(*) from private.owner_task_actions a where a.auth_user_id=account and a.state='closed' and a.created_at>=stamp-stamp%86400000)>=1000 then raise sqlstate 'PT429' using message='Keep this original task choice and retry later.';end if;
  answer:=json_build_object('v',1,'state','closed','intent',input,'at',stamp,'before',null,'after',null);
  insert into private.owner_task_actions values(account,action_id,business,outlet,actor,source_json,'closed',answer,stamp);return answer;
 end if;
 scope:=private.owner_task_access(outlet);
 if not private.confirmation_json_equal(input->'scope',scope::json) then raise insufficient_privilege using message='Refresh the actual task account and outlet.';end if;
 perform 1 from public.outlets o where o.business_id=business and o.id=outlet for update;
 if(control->>'at')::numeric>stamp+30000 then raise sqlstate 'PT409' using message='Review the original task clock.';end if;
 if control->>'type'='create' then
  insert into public.tasks(id,business_id,outlet_id,kind,title,body,actions,assignee,status,due_at,created_at,updated_at)
  values(task_id,business,outlet,control->>'kind',(control->>'titleJson')::public.literal_text,(control->>'bodyJson')::public.literal_text,'[]','owner','open',null,stamp,stamp) returning * into t;
  insert into private.owner_task_definitions values(task_id,business,outlet,control->>'mode',control->>'recipient',(control->>'preparedJson')::public.literal_text,(control->>'urgent')::boolean,actor);
 else
  select * into t from public.tasks x where x.business_id=business and x.outlet_id=outlet and x.id=task_id for update;
  if not found then raise sqlstate 'PT409' using message='The original task is unavailable.';end if;
  before_image:=private.owner_task_projection(t);
  if not private.confirmation_json_equal(input->'task',before_image) or not exists(select 1 from json_array_elements_text(before_image->'actions') a where a=choice) then raise sqlstate 'PT409' using message='The task changed. Review its current source.';end if;
  decision:=choice;next_status:=case choice when 'reply-myself' then 'waiting' when 'reopen' then 'open' else 'resolved' end;undoable:=true;
  if choice='undo' then
   select * into previous from private.owner_task_actions a where a.id=(control->>'undoOf')::public.ulid and a.business_id=business and a.outlet_id=outlet and a.state='applied' and a.outcome->'after'->>'id'=task_id and a.outcome->'after'->>'lastActionId'=control->>'undoOf' and private.confirmation_json_equal(a.outcome->'after',before_image) limit 1;
   if not found or previous.outcome->>'before' is null or not private.confirmation_json_equal(previous.outcome->'after',before_image) then raise sqlstate 'PT409' using message='Review the newer task before undoing an earlier choice.';end if;
   next_status:=previous.outcome->'before'->>'status';decision:=previous.outcome->'before'->>'decision';reply:=(previous.outcome->'before'->>'replyJson')::public.literal_text;
  elsif choice<>'sent' then reply:=null;end if;
  update public.tasks x set status=next_status,updated_at=greatest(x.updated_at,stamp) where x.id=task_id returning * into t;
 end if;
 insert into private.owner_task_states as x values(task_id,business,outlet,action_id,1,undoable,decision,reply)
 on conflict on constraint owner_task_states_pkey do update set last_action_id=excluded.last_action_id,revision=x.revision+1,undoable=excluded.undoable,decision=excluded.decision,reply=excluded.reply;
 after_image:=private.owner_task_projection(t);
 insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
 values(event_id,business,outlet,'member',actor,case when control->>'type'='create' then 'task.create' else 'task.'||choice end,
  coalesce(before_image,'null'::json),after_image,stamp);
 answer:=json_build_object('v',1,'state','applied','intent',input,'at',stamp,'before',before_image,'after',after_image);
 insert into private.owner_task_actions values(account,action_id,business,outlet,actor,source_json,'applied',answer,stamp);
 return answer;
end $$;
revoke all on function private.act_owner_task(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function private.act_owner_task(public.ulid,text,text) to authenticated;
create function public.act_owner_task(p_outlet_id public.ulid,p_operation text,p_intent_json text) returns json
language sql security invoker set search_path='' as $$select private.act_owner_task(p_outlet_id,p_operation,p_intent_json)$$;
revoke all on function public.act_owner_task(public.ulid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.act_owner_task(public.ulid,text,text) to authenticated;
