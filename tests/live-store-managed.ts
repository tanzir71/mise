import {setupCommand} from '../packages/core/setup';
import {recordSaleCommand} from '../packages/core/sales';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,encodeCommandRecord} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
/** Synthetic local/managed commissioning, always rolled back; no SMS or provider. */
export async function liveStoreManagedProof(){
 const uid='00000000-0000-4000-8000-000000009971',managerUid='00000000-0000-4000-8000-000000009972',at=Date.now()-1000,q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'";
 const shops=(['restaurant','food_stall','online_shop'] as const).map((businessType,n)=>setupCommand({businessType,marketCode:'BD',name:'Synthetic live shop '+n,outletName:'Synthetic place '+n,phone:'+14155550971',currency:n===2?'USD':'BDT'},null,at));
 const rows=[];
 for(let n=0;n<shops.length;n++){const s=shops[n],tables=emptyBackupTables(),sale=recordSaleCommand({expression:['100','250','12'][n],method:'cash'},{setup:s.snapshot,items:[],wallets:[]},at);tables.businesses.push(s.snapshot.business);tables.outlets.push(s.snapshot.outlet);tables.members.push(s.snapshot.owner);tables.sales.push(sale.sale);tables.events.push(s.event,sale.event);rows.push(...(await prepareCloudMigration(createBackup(tables,at),uid)).records);}
 const first=shops[0].snapshot,other=shops[2].snapshot,manager={...first.owner,id:newInboxId(),role:'manager' as const,name:'Synthetic manager',phone:'+14155550972',outletIds:[first.outlet.id]},m=encodeCommandRecord('members',manager,first.business.id);rows.push({...m,values:{...m.values,auth_user_id:managerUid}},{table:'member_outlets',values:{business_id:first.business.id,member_id:manager.id,outlet_id:first.outlet.id}});
 const inserts=rows.map(row=>'insert into public.'+row.table+'('+Object.keys(row.values).join(',')+') values('+Object.values(row.values).map(v=>v===null?'null':q(v)).join(',')+');').join('\n');
 const auth=(who:string)=>`reset role;perform set_config('request.jwt.claim.sub',${q(who)},true);perform set_config('request.jwt.claims',${q(JSON.stringify({sub:who,role:'authenticated',user_metadata:{role:'owner'}}))},true);set local role authenticated;`,call=(all:boolean,target=first.outlet.id)=>`public.read_live_store(${q(first.outlet.id)},${all},'today',null,${q(target)})`;
 return `begin;insert into auth.users(id,phone,phone_confirmed_at,is_anonymous) values(${q(uid)},'14155550971',now(),false),(${q(managerUid)},'14155550972',now(),false);\n${inserts}\n`+
 `do $proof$ declare r json;checks integer:=0;role_name text;baseline text;after_reads text;helper record;begin
 select md5(string_agg(row_to_json(s)::text,',' order by s.id)) into baseline from public.sales s where business_id in(${shops.map(s=>q(s.snapshot.business.id)).join(',')});
 ${auth(uid)}r:=${call(true)};if r->>'outletCount'<>'3' or json_array_length(r->'outlets')<>3 then raise exception 'All owned businesses not projected';end if;checks:=checks+1;
 if not exists(select 1 from json_array_elements(r->'totals'->'money') m where m->>'currency'='BDT' and m->>'sales'='35000') or not exists(select 1 from json_array_elements(r->'totals'->'money') m where m->>'currency'='USD' and m->>'sales'='1200') then raise exception 'Currencies mixed or money changed';end if;checks:=checks+1;
 if (select count(*) from public.outlets)<>3 then raise exception 'RLS differs from owner view';end if;checks:=checks+1;
 r:=${call(false,other.outlet.id)};if r->>'anchorId'<>${q(first.outlet.id)} or r->>'actorId'<>${q(first.owner.id)} or r->>'viewActorId'<>${q(other.owner.id)} or (r->'outlets'->0)->>'businessId'<>${q(other.business.id)} then raise exception 'Native/viewed scopes lost';end if;checks:=checks+1;
 ${auth(managerUid)}r:=${call(false)};if r->>'outletCount'<>'1' or r->>'actorRole'<>'manager' or (r->'outlets'->0)->>'id'<>${q(first.outlet.id)} then raise exception 'Manager view widened';end if;checks:=checks+1;
 if (select count(*) from public.outlets)<>1 or (select count(*) from public.sales)<>1 then raise exception 'RLS differs from manager view';end if;checks:=checks+1;
 begin perform ${call(true)};raise exception 'Manager All allowed';exception when insufficient_privilege then checks:=checks+1;end;
 begin perform ${call(false,other.outlet.id)};raise exception 'Manager foreign place allowed';exception when insufficient_privilege then checks:=checks+1;end;
 reset role;foreach role_name in array array['anon','service_role'] loop execute 'set local role '||role_name;begin perform ${call(false)};raise exception 'Direct RPC allowed';exception when insufficient_privilege then checks:=checks+1;end;reset role;end loop;
 foreach role_name in array array['anon','authenticated','service_role'] loop for helper in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in('live_store_start','live_store_money','live_store_people','live_store_summary','live_store_detail') loop if has_function_privilege(role_name,helper.oid,'execute') then raise exception 'Projection helper exposed';end if;checks:=checks+1;end loop;end loop;
 select md5(string_agg(row_to_json(s)::text,',' order by s.id)) into after_reads from public.sales s where business_id in(${shops.map(s=>q(s.snapshot.business.id)).join(',')});if baseline is distinct from after_reads then raise exception 'Read changed money';end if;checks:=checks+1;
 perform set_config('mise.live_store_probe',jsonb_build_object('checks',checks,'ownedBusinesses',3,'outlets',3,'syntheticSalesSeeded',3,'readFinancialWrites',0,'providerRequests',0,'rolledBack',true)::text,true);
 end $proof$;select current_setting('mise.live_store_probe')::jsonb proof;rollback;`;
}
