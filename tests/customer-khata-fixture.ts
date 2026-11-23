import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {decodeCommandRecord,encodeCommandRecord} from '../packages/core/cloud-records';
import {saveCustomerCommand} from '../packages/core/customers';
import {saveCreditTermsCommand,defaultCreditTerms,chargeCreditCommand} from '../packages/core/khata';
import {newInboxId} from '../packages/core/inbox';
import {parseKhataIntent,type KhataRequest,type KhataIntent} from '../packages/core/customer-khata';
import {createCustomerKhataHandler,type KhataLimits} from '../supabase/functions/_shared/customer-khata-handler';
import type {Business,Outlet,Member,SetupSnapshot} from '../packages/core/models';
export async function customerKhataFixture(root?:string){
 const f=await createPairingDatabase(root);let setup:SetupSnapshot,accountId:string,customerId:string,entryId:string,token:string,linkId:string;
 async function seed(){await f.seed();await f.db.exec('update private.public_read_budget set window_at=0,requests=0');
  const row=async<T>(table:'businesses'|'outlets'|'members',id:string)=>decodeCommandRecord(table,(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(t) data from public.'+table+' t where id=$1',[id])).rows[0].data) as unknown as T;
  setup={business:await row<Business>('businesses',deviceId(1)),outlet:await row<Outlet>('outlets',deviceId(11)),owner:await row<Member>('members',deviceId(101))};
  const c=saveCustomerCommand({name:'Rina Begum',nickname:'',phone:'01712345482',address:'PRIVATE ADDRESS',notes:'PRIVATE CONTACT NOTE',tags:[]},setup,[]),terms=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:150000},c.customer,setup,null),charge=chargeCreditCommand(96000,{setup,customer:c.customer,account:terms.account,entries:[]},{note:'Rice 2 kg, soybean oil'});
  await f.db.transaction(async sql=>{for(const[table,value]of [['customers',c.customer],['creditAccounts',terms.account],['creditEntries',charge.entry],['events',c.event],['events',terms.event],['events',charge.event]] as const){const r=encodeCommandRecord(table,value,setup.business.id),keys=Object.keys(r.values);await sql.query('insert into public.'+r.table+'('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(r.values));if(table==='customers')await sql.query('insert into public.customer_outlets(business_id,outlet_id,customer_id) values($1,$2,$3)',[setup.business.id,setup.outlet.id,c.customer.id]);}});
  accountId=terms.account.id;customerId=c.customer.id;entryId=charge.entry.id;
  const link=await f.asRole<{id:string;token:string}>(1,'authenticated','select public.create_public_link($1,$2,\'khata\',$3,null) data',[newInboxId(),newInboxId(),accountId]);token=link.token;linkId=link.id;
 }
 const visit=(input:KhataRequest,limits:KhataLimits={global:3000,link:60})=>f.asRole<unknown>(null,'service_role','select public.visit_customer_khata($1,$2,$3,$4,$5,$6) data',[input.token,input.operation,input.intent===null?null:JSON.stringify(input.intent),input.after,limits.global,limits.link]);
 const handler=(limits?:KhataLimits)=>createCustomerKhataHandler({origins:new Set(['https://shop.test']),store:{visit},limits});
 const intent=(patch:Partial<KhataIntent>={})=>parseKhataIntent({v:1,id:newInboxId(),eventId:newInboxId(),taskId:newInboxId(),linkId,accountId,kind:'more-time',entryId:null,message:'Please allow a little more time. আরও সময় দিন।',at:Date.now(),...patch});
 async function otherAccount(){const branch={...setup,outlet:{...setup.outlet,id:deviceId(12)}},c=saveCustomerCommand({name:'Other customer',nickname:'',phone:'',address:'OTHER PRIVATE ADDRESS',notes:'OTHER PRIVATE NOTE',tags:[]},branch,[]),terms=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:100000},c.customer,branch,null),charge=chargeCreditCommand(45000,{setup:branch,customer:c.customer,account:terms.account,entries:[]},{note:'Other outlet purchase'});
  await f.db.transaction(async sql=>{for(const[table,value]of [['customers',c.customer],['creditAccounts',terms.account],['creditEntries',charge.entry],['events',c.event],['events',terms.event],['events',charge.event]] as const){const r=encodeCommandRecord(table,value,setup.business.id),keys=Object.keys(r.values);await sql.query('insert into public.'+r.table+'('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(r.values));if(table==='customers')await sql.query('insert into public.customer_outlets values($1,$2,$3)',[setup.business.id,branch.outlet.id,c.customer.id]);}});
  const link=await f.asRole<{id:string;token:string}>(1,'authenticated','select public.create_public_link($1,$2,\'khata\',$3,null) data',[newInboxId(),newInboxId(),terms.account.id]);return {token:link.token,accountId:terms.account.id,entryId:charge.entry.id};
 }
 return {...f,seed,visit,handler,intent,otherAccount,get setup(){return setup;},get accountId(){return accountId;},get customerId(){return customerId;},get entryId(){return entryId;},get token(){return token;},get linkId(){return linkId;}};
}
