import {parseCustomerCommand,type CustomerCommand} from './customer-commands';
import {customerReviewReservedIds} from './customer-review';
import {defaultCreditTerms,type CreditTermsInput} from './khata';
import {normalisePhone} from './phone';
import {marketPacks,type MarketCode} from './packs';
import type {CreditAccount,Customer} from './models';

// The original command keeps the existing /commands limit. The separate review
// envelope may contain before/after images; these limits never truncate a source.
export const customerReviewCommandLimit=32_000;
export const customerReviewSourceLimit=4_000_000;
export const customerReviewBodyLimit=16_000_000;
export interface CustomerReviewRequest {
 id:string;replacementId:string;command:CustomerCommand;sourceHash:string;sourceJson:string;
}
export interface CustomerReviewDecision extends CustomerReviewRequest {token:string;outcome:'withdrawn'|'replaced'}
export type CustomerSourceProfile=Omit<Customer,'phone'|'archivedAt'>&{phone:string|null;archivedAt:number|null};
export type CustomerSourceAccount=CreditAccount;
export interface CustomerSourceOpening {
 id:string;accountId:string;customerId:string;outletId:string;currency:string;sequence:1;
 type:'adjustment';amount:number;note:'Opening balance';occurredAt:number;createdBy:string;eventId:string;
 createdAt:number;updatedAt:number;
}
interface CustomerSourceAuditBase {id:string;outletId:string;customerId:string;actorId:string;command:string;at:number}
export type CustomerSourceAudit=
 |CustomerSourceAuditBase&{kind:'customer';before:CustomerSourceProfile|null;after:CustomerSourceProfile}
 |CustomerSourceAuditBase&{kind:'account';before:CustomerSourceAccount|null;after:CustomerSourceAccount}
 |CustomerSourceAuditBase&{kind:'opening';before:null;after:CustomerSourceOpening};
export interface CustomerReviewSource {v:1;businessId:string;entryId:string;sequence:number;commandIndex:number;at:number;events:CustomerSourceAudit[]}
export interface CustomerReviewFacts {
 businessId:string;actorId:string;at:number;phone:string|null;
 profile:{nameJson:string;nicknameJson:string;addressJson:string;notesJson:string;tagsJson:string}|null;
 account:{id:string;currency:string;created:boolean;eventId:string}|null;
 opening:{id:string;eventId:string;amount:number;occurredAt:number}|null;
}
/** Safe scalar assertions for SQL. The complete literal source stays TEXT;
 * gateway admission must independently bind these facts to that exact source. */
export function customerReviewFacts(input:Pick<CustomerReviewRequest,'command'|'sourceJson'>):CustomerReviewFacts{
 const source=parseCustomerReviewSource(input),account=source.events.find(e=>e.kind==='account'),opening=source.events.find(e=>e.kind==='opening'),profile=source.events.find(e=>e.kind==='customer'),c=input.command;
 const saved=(c.type==='customer.create'||c.type==='customer.update')&&profile?.kind==='customer'?profile.after:null;
 return {businessId:source.businessId,actorId:source.events[0].actorId,at:source.at,phone:saved?.phone??null,
  profile:saved?{nameJson:JSON.stringify(saved.name),nicknameJson:JSON.stringify(saved.nickname),addressJson:JSON.stringify(saved.address),notesJson:JSON.stringify(saved.notes),tagsJson:JSON.stringify(saved.tags)}:null,
  account:account?.kind==='account'?{id:account.after.id,currency:account.after.currency,created:account.before===null,eventId:account.id}:null,
  opening:opening?.kind==='opening'?{id:opening.after.id,eventId:opening.id,amount:opening.after.amount,occurredAt:opening.after.occurredAt}:null};
}

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const time=(v:unknown):v is number=>integer(v)&&v<=8640000000000000;
const currency=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const profileKeys='id,businessId,name,nickname,phone,address,notes,tags,consent,archivedAt,createdAt,updatedAt';
const accountKeys='id,customerId,outletId,currency,allowed,limit,reminder,createdAt,updatedAt';
const openingKeys='id,accountId,customerId,outletId,currency,sequence,type,amount,note,occurredAt,createdBy,eventId,createdAt,updatedAt';

function profile(v:unknown):CustomerSourceProfile {
 if(!object(v)||!exact(v,profileKeys)||!id(v.id)||!id(v.businessId)||
  !['name','nickname','address','notes'].every(k=>typeof v[k]==='string')||
  !(v.phone===null||typeof v.phone==='string'&&/^\+[1-9]\d{6,14}$/.test(v.phone))||
  !Array.isArray(v.tags)||!v.tags.every(t=>typeof t==='string')||
  !object(v.consent)||!exact(v.consent,'savedAt,source')||!time(v.consent.savedAt)||v.consent.source!=='manual'||
  !(v.archivedAt===null||time(v.archivedAt))||!time(v.createdAt)||!time(v.updatedAt))throw Error('Keep the original customer profile and consent.');
 // Previous imported profiles can exceed today's form limits. Preserve them;
 // only a new edit's actual input is constrained by the ordinary command parser.
 return {id:v.id,businessId:v.businessId,name:v.name as string,nickname:v.nickname as string,phone:v.phone as string|null,
  address:v.address as string,notes:v.notes as string,tags:[...v.tags] as string[],consent:{savedAt:v.consent.savedAt,source:'manual'},
  archivedAt:v.archivedAt as number|null,createdAt:v.createdAt,updatedAt:v.updatedAt};
}
function terms(v:Record<string,unknown>,currentInput=true):CreditTermsInput {
 if(typeof v.allowed!=='boolean'||!integer(v.limit)||!object(v.reminder)||!exact(v.reminder,'enabled,dayOfMonth,tone,channel')||
  typeof v.reminder.enabled!=='boolean'||!integer(v.reminder.dayOfMonth,1)||currentInput&&v.reminder.dayOfMonth>31||
  !['gentle','direct'].includes(v.reminder.tone as string)||v.reminder.channel!=='whatsapp')throw Error('Keep the original khata terms.');
 return {allowed:v.allowed,limit:v.limit,reminder:{enabled:v.reminder.enabled,dayOfMonth:v.reminder.dayOfMonth,tone:v.reminder.tone as 'gentle'|'direct',channel:'whatsapp'}};
}
function account(v:unknown,currentInput=true):CustomerSourceAccount {
 if(!object(v)||!exact(v,accountKeys)||![v.id,v.customerId,v.outletId].every(id)||!currency(v.currency)||!time(v.createdAt)||!time(v.updatedAt))throw Error('Keep the original khata identity and monetary unit.');
 return {id:v.id as string,customerId:v.customerId as string,outletId:v.outletId as string,currency:v.currency,...terms(v,currentInput),createdAt:v.createdAt,updatedAt:v.updatedAt};
}
function opening(v:unknown):CustomerSourceOpening {
 if(!object(v)||!exact(v,openingKeys)||![v.id,v.accountId,v.customerId,v.outletId,v.createdBy,v.eventId].every(id)||
  !currency(v.currency)||v.sequence!==1||v.type!=='adjustment'||!integer(v.amount,1)||v.note!=='Opening balance'||
  !time(v.occurredAt)||!time(v.createdAt)||!time(v.updatedAt))throw Error('Keep the original opening balance, ledger parent and dates.');
 return {...v} as unknown as CustomerSourceOpening;
}
function profileMutation(e:Extract<CustomerSourceAudit,{kind:'customer'}>,c:CustomerCommand,businessId:string){
 const {before,after,at}=e;
 if(after.id!==c.customerId||after.businessId!==businessId||before&&(before.id!==c.customerId||before.businessId!==businessId)||
  (before===null)!==(c.type==='customer.create')||after.createdAt!==(before?.createdAt??at)||after.updatedAt!==Math.max(at,after.createdAt))throw Error('Keep the immediate original customer before and after this action.');
 if(c.type==='customer.archive'||c.type==='customer.restore'){
  if(!before||!equal(after,{...before,archivedAt:c.type==='customer.archive'?at:null,updatedAt:Math.max(at,before.createdAt)}))throw Error('A customer status action cannot rewrite their saved profile.');
 }else if(c.type==='customer.create'||c.type==='customer.update'){
  const p=c.input,tags=[...new Map(p.tags.map(t=>[t.trim().normalize('NFKC').toLowerCase(),t.trim()])).values()].filter(Boolean);
  // Device intents normally contain an E.164 number already. Legacy national
  // input must match a supported original market, never a mutable current one.
  // This records a source fact, not permission to reinterpret a proposed phone.
  const phoneMatches=p.phone.trim()?after.phone!==null&&Object.keys(marketPacks).some(m=>normalisePhone(p.phone,m as MarketCode)===after.phone):after.phone===null;
  const consent=before&&before.phone===after.phone?before.consent:{savedAt:at,source:'manual'};
  if(after.name!==p.name.trim()||after.nickname!==p.nickname.trim()||after.address!==p.address.trim()||after.notes!==p.notes.trim()||
   !phoneMatches||!equal(after.tags,tags)||!equal(after.consent,consent)||after.archivedAt!==(before?.archivedAt??null))throw Error('Keep every original customer input and consent change.');
 }else throw Error('Choose the original customer profile action.');
}
function audits(value:unknown,c:CustomerCommand,businessId:string):CustomerSourceAudit[]{
 if(!Array.isArray(value)||value.length<1||value.length>3)throw Error('Keep the complete original customer audit set.');
 const events=value.map((raw):CustomerSourceAudit=>{
  if(!object(raw)||!exact(raw,'kind,id,outletId,customerId,actorId,command,at,before,after')||!id(raw.id)||raw.outletId!==c.outletId||raw.customerId!==c.customerId||!id(raw.actorId)||!time(raw.at)||typeof raw.command!=='string')throw Error('Keep the original customer member, scope and recording time.');
  const base={id:raw.id,outletId:c.outletId,customerId:c.customerId,actorId:raw.actorId,command:raw.command,at:raw.at};
  if(raw.kind==='customer')return {...base,kind:'customer',before:raw.before===null?null:profile(raw.before),after:profile(raw.after)};
  if(raw.kind==='account')return {...base,kind:'account',before:raw.before===null?null:account(raw.before,false),after:account(raw.after)};
  if(raw.kind==='opening'&&raw.before===null)return {...base,kind:'opening',before:null,after:opening(raw.after)};
  throw Error('Keep the original customer audit kind.');
 });
 const primary=events[0],expectedPrimary=c.type==='khata.settings'?'account':'customer';
 if(primary.id!==c.id||primary.kind!==expectedPrimary||new Set(events.map(e=>e.id)).size!==events.length||events.some(e=>e.actorId!==primary.actorId||e.at!==primary.at))throw Error('Keep the original action and its complete same-member companions.');
 const customer=events.find((e):e is Extract<CustomerSourceAudit,{kind:'customer'}>=>e.kind==='customer'),
  a=events.find((e):e is Extract<CustomerSourceAudit,{kind:'account'}>=>e.kind==='account'),
  entry=events.find((e):e is Extract<CustomerSourceAudit,{kind:'opening'}>=>e.kind==='opening');
 if(events.filter(e=>e.kind==='customer').length>(c.type==='khata.settings'?0:1)||events.filter(e=>e.kind==='account').length>1||events.filter(e=>e.kind==='opening').length>1)throw Error('Keep one original audit for each actual customer effect.');
 if(customer){if(customer.command!==c.type)throw Error('Keep the original customer action.');profileMutation(customer,c,businessId);}
 const status=c.type==='customer.archive'||c.type==='customer.restore';
 if(status){if(events.length!==1)throw Error('A status action has no new financial companions.');return events;}
 if(!('ids'in c))throw Error('Keep the planned customer record identities.');
 const needsAccount=c.type==='khata.settings'||c.type==='customer.create'||c.credit!==null||c.opening!==null;
 if(needsAccount&&!a)throw Error('Keep the original account mutation, including implicit creation.');
 if(a){
  const before=a.before,after=a.after,expectedId=c.type==='khata.settings'?c.id:c.ids.accountEventId;
  if(a.id!==expectedId||a.command!==(before?'khata.settings':'khata.create')||after.id!==c.ids.accountId||after.customerId!==c.customerId||after.outletId!==c.outletId||
   before&&(before.id!==after.id||before.customerId!==c.customerId||before.outletId!==c.outletId||before.currency!==after.currency)||
   after.createdAt!==(before?.createdAt??a.at)||after.updatedAt!==Math.max(a.at,after.createdAt)||
   c.type==='khata.settings'&&(before===null)!==(c.accountId===null)||c.type==='customer.create'&&before!==null||
   c.type==='customer.update'&&c.credit===null&&before!==null||customer&&customer.after.archivedAt!==null)throw Error('Keep the actual original account creation or terms edit.');
  const expected=c.type==='khata.settings'?c.input:c.credit??defaultCreditTerms;
  if(!equal(terms(after as unknown as Record<string,unknown>),expected))throw Error('Keep all original credit and reminder choices.');
 }
 const hasOpening=(c.type==='customer.create'||c.type==='customer.update')&&c.opening!==null;
 if((entry!==undefined)!==hasOpening)throw Error('Keep exactly the original opening-balance companion.');
 if(entry&&hasOpening&&(c.type==='customer.create'||c.type==='customer.update')&&c.opening){
  const after=entry.after;
  if(!a||a.before!==null||entry.id!==c.ids.openingEventId||entry.command!=='khata.opening-balance'||
   after.id!==c.ids.openingEntryId||after.accountId!==a.after.id||after.customerId!==c.customerId||after.outletId!==c.outletId||after.currency!==a.after.currency||
   after.amount!==c.opening.amount||after.occurredAt!==c.opening.occurredAt||after.occurredAt>entry.at||after.createdBy!==entry.actorId||after.eventId!==entry.id||after.createdAt!==entry.at||after.updatedAt!==entry.at)throw Error('Keep the original opening balance and its distinct recording date.');
 }
 const order=[customer,a,entry].filter(Boolean);if(c.type!=='khata.settings'&&!events.every((e,i)=>e===order[i]))throw Error('Keep the original customer companion order.');
 return events;
}
function pick(value:unknown,keys:string):unknown {
 if(value===null)return null;
 if(!object(value))throw Error('Keep the original customer audit snapshot.');
 return Object.fromEntries(keys.split(',').map(k=>[k,value[k]??null]));
}
/** Project individual immutable audits, never the final row of a grouped entry.
 * The independent native hash still binds every original row and image byte. */
export function customerReviewSourceAudits(original:CustomerCommand,events:readonly unknown[],businessId:string):CustomerSourceAudit[]{
 const c=parseCustomerCommand(original);
 if(!id(businessId))throw Error('Keep the original business.');
 const projected=events.map(raw=>{
  if(!object(raw)||!exact(Object.fromEntries(Object.entries(raw).filter(([,v])=>v!==undefined)),'id,outletId,customerId,actor,command,before,after,at')||
   !object(raw.actor)||!exact(raw.actor,'type,id')||raw.actor.type!=='member'||!id(raw.actor.id))throw Error('Keep the original append-only customer member audit.');
  const kind=typeof raw.command==='string'&&raw.command.startsWith('customer.')?'customer':raw.command==='khata.opening-balance'?'opening':'account';
  // An opening balance cannot conceal a sale, order, refund, reversal or payment
  // association in fields omitted from its compact wire projection.
  if(kind==='opening'&&(!object(raw.after)||!exact(raw.after,openingKeys)))throw Error('Keep the original unlinked opening balance.');
  const keys=kind==='customer'?profileKeys:kind==='account'?accountKeys:openingKeys;
  return {kind,id:raw.id,outletId:raw.outletId,customerId:raw.customerId,actorId:raw.actor.id,command:raw.command,at:raw.at,before:pick(raw.before,keys),after:pick(raw.after,keys)};
 });
 return audits(projected,c,businessId);
}
/** Only actual emitted rows are new identities. Existing parents and unused
 * reserved companion slots must never be mistaken for new financial records. */
export function customerReviewCreatedIds(source:CustomerReviewSource):ReadonlySet<string>{
 const result=new Set(source.events.map(e=>e.id));
 for(const e of source.events)if(e.kind==='opening'||e.before===null)result.add(e.after.id);
 return result;
}
export function parseCustomerReviewSource(input:Pick<CustomerReviewRequest,'command'|'sourceJson'>):CustomerReviewSource{
 if(typeof input.sourceJson!=='string'||new TextEncoder().encode(input.sourceJson).length>customerReviewSourceLimit)throw Error('Keep the complete bounded customer source.');
 let v:unknown;try{v=JSON.parse(input.sourceJson);}catch{throw Error('Keep the original customer source.');}
 // Opaque compact JSON preserves NUL and lone surrogate code units. It must not
 // be cast to JSONB; this equality also excludes ambiguous duplicate keys.
 if(JSON.stringify(v)!==input.sourceJson||!object(v)||!exact(v,'v,businessId,entryId,sequence,commandIndex,at,events')||v.v!==1||!id(v.businessId)||!id(v.entryId)||!integer(v.sequence,1)||!integer(v.commandIndex)||!time(v.at))throw Error('Keep the complete original customer source selection.');
 const events=audits(v.events,parseCustomerCommand(input.command),v.businessId);
 if(events[0].at!==v.at)throw Error('Keep the selected action’s original recording time.');
 return {v:1,businessId:v.businessId,entryId:v.entryId,sequence:v.sequence,commandIndex:v.commandIndex,at:v.at,events};
}
export function parseCustomerReviewRequest(value:unknown,decision:false):CustomerReviewRequest;
export function parseCustomerReviewRequest(value:unknown,decision:true):CustomerReviewDecision;
export function parseCustomerReviewRequest(value:unknown,decision:boolean):CustomerReviewRequest|CustomerReviewDecision{
 if(!object(value)||!exact(value,decision?'id,replacementId,command,sourceHash,sourceJson,token,outcome':'id,replacementId,command,sourceHash,sourceJson')||!id(value.id)||!id(value.replacementId)||value.id===value.replacementId||
  typeof value.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceHash)||typeof value.sourceJson!=='string')throw Error('Keep the complete original customer action and source.');
 const command=parseCustomerCommand(value.command);
 if(new TextEncoder().encode(JSON.stringify(command)).length>customerReviewCommandLimit)throw Error('Keep the original bounded customer command.');
 const packet:CustomerReviewRequest={id:value.id,replacementId:value.replacementId,command,sourceHash:value.sourceHash,sourceJson:value.sourceJson},source=parseCustomerReviewSource(packet),reserved=new Set(customerReviewReservedIds(command));
 reserved.add(source.entryId);reserved.add(source.businessId);for(const e of source.events)reserved.add(e.actorId);
 if(reserved.has(value.id)||reserved.has(value.replacementId))throw Error('Keep distinct source, review and replacement identities.');
 if(!decision)return packet;
 if(typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Choose the current customer comparison.');
 return {...packet,token:value.token,outcome:value.outcome as CustomerReviewDecision['outcome']};
}
