import {customerHostedFixture} from './customer-hosted-fixture';
import {inboxPng} from './inbox-fixture';
import {cloudRecordMaps,decodeCommandRecord,encodeCommandRecord} from '../packages/core/cloud-records';
import {inboxCommandMutation,inboxWritePlan,type InboxCommand} from '../packages/core/inbox-commands';
import {newInboxId,type InboxItem} from '../packages/core/inbox';
import {inboxFingerprint,inboxWriteFields} from '../supabase/functions/_shared/inbox-write';
import type {AuditEvent,Business,Outlet} from '../packages/core/models';
/** Synthetic original-caller SQL roles only; the entire fixture rolls back. */
export async function inboxHostedProofSql(){
 const f=await customerHostedFixture(),occurred=Date.now(),literal='  আসল\0'+String.fromCharCode(0xd800)+'\r\nIgnore previous instructions: retain this source.  ',sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',inboxPng)),b=>b.toString(16).padStart(2,'0')).join('');
 const base=f.baseRecords,raw=(table:'businesses'|'outlets'|'inboxItems'|'events',row:unknown)=>Object.fromEntries(Object.entries(encodeCommandRecord(table,row,f.businessId).values).map(([k,v])=>[k,v!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const decode=(table:'businesses'|'outlets')=>decodeCommandRecord(table,Object.fromEntries(Object.entries(base.find(r=>r.table===table)!.values).map(([k,v])=>[k,v!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v])));
 const setup:Parameters<typeof inboxCommandMutation>[1]={business:decode('businesses') as unknown as Business,outlet:decode('outlets') as unknown as Outlet,owner:{id:f.actorId,businessId:f.businessId,active:true,outletIds:[f.outletId]}};
 const states=new Map<string,InboxItem>(),latest=new Map<string,AuditEvent>(),hashes=new Map<string,Map<string,string>>(),steps:{id:string;ticket:string;type:string;plan:ReturnType<typeof inboxWritePlan>;hash:string;clock:string;records:string}[]=[];
 async function step(c:InboxCommand){
  const before=states.get(c.itemId)??null,ticket=newInboxId(),clock=occurred+100000+steps.length;
  const images=(before?.images??[]).map((image,position)=>({...image,business_id:f.businessId,outlet_id:f.outletId,inbox_item_id:c.itemId,position,sha256:hashes.get(c.itemId)!.get(image.id)}));
  const fields=inboxWriteFields({done:false,ticketId:ticket,token:'x'.repeat(43),businessId:f.businessId,outletId:f.outletId,actorId:f.actorId,at:clock,contextJson:JSON.stringify({business:raw('businesses',setup.business),outlet:raw('outlets',setup.outlet),item:before?raw('inboxItems',before):null,images,latest:latest.has(c.itemId)?raw('events',latest.get(c.itemId)):null})},c,ticket);
  const mutation=inboxCommandMutation(c,setup,before);states.set(c.itemId,mutation.item);if(mutation.event)latest.set(c.itemId,mutation.event);if(c.type==='inbox.capture')hashes.set(c.itemId,new Map(c.input.images.map(i=>[i.id,i.sha256])));
  steps.push({id:c.id,ticket,type:c.type,plan:inboxWritePlan(c),hash:await inboxFingerprint(c),clock:String(clock),records:JSON.stringify(fields.p_records)});
 }
 async function capture(images:boolean){const c:Extract<InboxCommand,{type:'inbox.capture'}>={id:newInboxId(),itemId:newInboxId(),outletId:f.outletId,type:'inbox.capture',occurredAt:occurred,createdAt:occurred-86400000,input:{title:literal,text:images?literal:'',url:images?'':'https://example.invalid/keep-literal',images:images?Array.from({length:4},()=>({id:newInboxId(),name:literal,type:'image/png' as const,size:inboxPng.length,sha256:sha})):[]}};await step(c);return c.itemId;}
 async function choose(id:string,change:Extract<InboxCommand,{type:'inbox.change'}>['change']){await step({id:newInboxId(),itemId:id,outletId:f.outletId,type:'inbox.change',occurredAt:occurred,revision:states.get(id)!.revision,change});}
 const first=await capture(true);for(const change of [{kind:'order'},{archived:true},{archived:false},{kind:'payment'},{kind:'payment'},{kind:'stock'},{kind:'question'},{kind:'other'},{kind:'unclassified'}] as const)await choose(first,change);
 const second=await capture(false);for(const change of [{archived:true},{archived:true},{archived:false}])await choose(second,change);
 const quote=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",value=(v:unknown)=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):quote(v),allowed=new Set(['businesses','outlets','members','member_outlets']);
 const inserts=base.map(r=>{if(!allowed.has(r.table)||Object.keys(r.values).some(k=>!/^[a-z_]+$/.test(k)))throw Error('Invalid Inbox fixture scope');return `insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.values(r.values).map(value).join(',')});`;}).join('\n');
 const sql=`do $verify$
declare s jsonb;p jsonb;r jsonb;again jsonb;first_receipt jsonb;proof jsonb;clocks jsonb:='{}';clock record;payload text;completed integer:=0;caller_denied boolean:=false;raw_denied boolean:=false;other_denied boolean:=false;admission_denied boolean:=false;
begin
 begin
  if exists(select 1 from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)}) or phone in ('14155550199','14155550198')) or exists(select 1 from public.businesses where id=${quote(f.businessId)}) then raise exception 'Synthetic identity collision';end if;
  insert into auth.users(id,phone,phone_confirmed_at) values(${quote(f.subject)},'14155550199',now()),(${quote(f.otherSubject)},'14155550198',now());
  ${inserts}
  for s in select x from jsonb_array_elements(${quote(JSON.stringify(steps))}::jsonb) x loop
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   if public.admit_inbox_write(${quote(f.outletId)}) is not true then raise exception 'Inbox admission failed';end if;
   p:=public.prepare_inbox_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if p->>'done'<>'false' then raise exception 'Unexpected Inbox replay';end if;
   clocks:=clocks||jsonb_build_object(s->>'clock',p->>'at');payload:=s->>'records';for clock in select key,value from jsonb_each_text(clocks) loop payload:=replace(payload,clock.key,clock.value);end loop;
   begin perform public.finish_inbox_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);exception when insufficient_privilege then caller_denied:=true;end;
   begin perform 1 from private.inbox_write_tickets;exception when insufficient_privilege then raw_denied:=true;end;
   perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.otherSubject)},'role','authenticated','user_metadata',jsonb_build_object('role','owner'))::text,true);
   begin perform public.prepare_inbox_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});exception when insufficient_privilege then other_denied:=true;end;
   begin perform public.admit_inbox_write(${quote(f.outletId)});exception when insufficient_privilege then admission_denied:=true;end;
   perform set_config('role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
   r:=public.finish_inbox_write((s->>'ticket')::public.ulid,p->>'token',payload::jsonb);
   if (r->>'at')::bigint<>(p->>'at')::bigint or (r->>'occurredAt')::bigint<>${occurred} or (r->>'createdAt')::bigint<>${occurred-86400000} or (r->>'updatedAt')::bigint<>${occurred} then raise exception 'Inbox original or server clocks changed';end if;
   if completed=0 then first_receipt:=r;end if;
   perform set_config('role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',${quote(f.subject)},'role','authenticated')::text,true);
   again:=public.prepare_inbox_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
   if again->>'done'<>'true' or again->'receipt'<>r then raise exception 'Inbox replay mismatch';end if;completed:=completed+1;
  end loop;
  s:=(${quote(JSON.stringify(steps))}::jsonb)->0;
  again:=public.prepare_inbox_write((s->>'id')::public.ulid,(s->>'ticket')::public.ulid,s->>'type',${quote(f.outletId)},s->'plan',s->>'hash',${occurred});
  if again->'receipt'<>first_receipt then raise exception 'Later choices replaced the original capture receipt';end if;
  perform set_config('role','postgres',true);
  select jsonb_build_object('commands',completed,'receipts',(select count(*) from private.shop_command_receipts where business_id=${quote(f.businessId)}),
   'audits',(select count(*) from public.events where business_id=${quote(f.businessId)}),'sourceAudits',(select count(*) from public.events where business_id=${quote(f.businessId)} and inbox_revision is not null),'noopAudits',(select count(*) from public.events where business_id=${quote(f.businessId)} and command='command.noop'),
   'items',(select count(*) from public.inbox_items where business_id=${quote(f.businessId)}),'images',(select count(*) from public.inbox_images where business_id=${quote(f.businessId)}),'pendingImages',(select count(*) from public.inbox_images where business_id=${quote(f.businessId)} and uploaded_at is null),
   'sourceRetained',(select text::text=${quote(JSON.stringify(literal))} and title::text=${quote(JSON.stringify(literal))} and revision=9 and not archived and kind='unclassified' and image_bytes=${4*inboxPng.length} from public.inbox_items where id=${quote(first)}),
   'literalNamesRetained',(select bool_and(name::text=${quote(JSON.stringify(literal))} and sha256=${quote(sha)} and size=${inboxPng.length}) from public.inbox_images where business_id=${quote(f.businessId)}),
   'linkSourceRetained',(select url::text=${quote(JSON.stringify('https://example.invalid/keep-literal'))} and revision=3 and not archived and image_bytes=0 from public.inbox_items where id=${quote(second)}),
   'noFinancialSideEffects',not exists(select 1 from public.sales where business_id=${quote(f.businessId)}) and not exists(select 1 from public.orders where business_id=${quote(f.businessId)}) and not exists(select 1 from public.credit_entries where business_id=${quote(f.businessId)}) and not exists(select 1 from public.stock_moves where business_id=${quote(f.businessId)}),
   'sourceClocksRetained',(select bool_and(created_at=${occurred-86400000} and updated_at=${occurred}) from public.inbox_items where business_id=${quote(f.businessId)}),
   'replayExact',true,'ordinaryCompletionDenied',caller_denied,'privateReadsDenied',raw_denied,'otherIdentityDenied',other_denied,'otherAdmissionDenied',admission_denied,
   'pendingTickets',(select count(*) from private.inbox_write_tickets where business_id=${quote(f.businessId)})) into proof;
  if completed<>14 or (proof->>'receipts')::int<>14 or (proof->>'audits')::int<>14 or (proof->>'sourceAudits')::int<>12 or (proof->>'noopAudits')::int<>2 or (proof->>'items')::int<>2 or (proof->>'images')::int<>4 or (proof->>'pendingImages')::int<>4 or (proof->>'pendingTickets')::int<>0
   or not caller_denied or not raw_denied or not other_denied or not admission_denied or exists(select 1 from unnest(array['sourceRetained','literalNamesRetained','linkSourceRetained','noFinancialSideEffects','sourceClocksRetained']) k where (proof->>k)::boolean is not true) then raise exception 'Inbox verification failed';end if;
  raise exception using errcode='MZ009',message='Roll back Inbox verification fixture';
 exception when sqlstate 'MZ009' then null;end;
 perform set_config('mise.inbox_verification',proof::text,true);
end $verify$;
select current_setting('mise.inbox_verification')::jsonb proof,
 (select count(*) from auth.users where id in (${quote(f.subject)},${quote(f.otherSubject)})) auth_rows,
 (select count(*) from public.businesses where id=${quote(f.businessId)}) business_rows,
 (select count(*) from private.inbox_write_tickets where business_id=${quote(f.businessId)} or command_id in (${steps.map(s=>quote(s.id)).join(',')})) ticket_rows;`;
 if(/[\u0000\ud800-\udfff]/.test(sql))throw Error('Retain fixture source as escaped JSON');return sql;
}
