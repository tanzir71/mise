import {parseCheckoutWallet,type CheckoutWallet} from './order-confirmation';
import {marketPacks,type MarketCode} from './packs';
import type {CreditEntry} from './models';
export interface KhataIntent {v:1;id:string;eventId:string;taskId:string;linkId:string;accountId:string;kind:'more-time'|'question';entryId:string|null;message:string;at:number}
export interface KhataEntry {id:string;sequence:number;type:CreditEntry['type'];amount:number;delta:number;at:number;note:string;by:string|null;method:string|null;orderNumber:string|null;reversalOf:string|null}
export interface KhataView {v:1;state:'view';serverAt:number;linkId:string;accountId:string;shopName:string;outletName:string;customerName:string;marketCode:MarketCode;currency:string;timeZone:string;balance:number;settingsRevision:number;wallets:CheckoutWallet[];entries:KhataEntry[];next:number|null}
export interface KhataOutcome {v:1;state:'pending'|'created'|'closed';intent:KhataIntent;at:number|null}
export interface KhataRequest {token:string;operation:'read'|'submit'|'inspect'|'close';intent:KhataIntent|null;after:number}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export const khataId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const int=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const time=(v:unknown)=>int(v,0,8640000000000000);
const bad=()=>Error('Keep the original khata link and request. Ask the shop if it cannot be checked.');
const literal=(v:unknown):string=>{if(typeof v!=='string')throw bad();const s:unknown=JSON.parse(v);if(typeof s!=='string')throw bad();return s;};
export function parseKhataIntent(v:unknown):KhataIntent {
 if(!object(v)||!exact(v,'v,id,eventId,taskId,linkId,accountId,kind,entryId,message,at')||v.v!==1||![v.id,v.eventId,v.taskId,v.linkId,v.accountId].every(khataId)||new Set([v.id,v.eventId,v.taskId]).size!==3||!['more-time','question'].includes(v.kind as string)||typeof v.message!=='string'||!v.message.trim()||v.message.length>2000||!time(v.at)||(v.kind==='question'?!khataId(v.entryId):v.entryId!==null))throw bad();
 return {v:1,id:v.id as string,eventId:v.eventId as string,taskId:v.taskId as string,linkId:v.linkId as string,accountId:v.accountId as string,kind:v.kind as KhataIntent['kind'],entryId:v.entryId as string|null,message:v.message,at:v.at as number};
}
export function parseKhataRequest(v:unknown):KhataRequest {
 if(!object(v)||!exact(v,'token,operation,intent,after')||typeof v.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(v.token)||!['read','submit','inspect','close'].includes(v.operation as string)||!int(v.after)||v.operation==='read'&&v.intent!==null||v.operation!=='read'&&(v.intent===null||v.after!==0))throw bad();
 return {token:v.token,operation:v.operation as KhataRequest['operation'],intent:v.intent===null?null:parseKhataIntent(v.intent),after:v.after};
}
export function parseKhataOutcome(v:unknown,intent:KhataIntent):KhataOutcome {
 const source=parseKhataIntent(intent);if(!object(v)||!exact(v,'v,state,intent,at')||v.v!==1||!['pending','created','closed'].includes(v.state as string)||JSON.stringify(parseKhataIntent(v.intent))!==JSON.stringify(source)||(v.state==='pending'?v.at!==null:!time(v.at)))throw bad();
 return {v:1,state:v.state as KhataOutcome['state'],intent:source,at:v.at as number|null};
}
export function parseKhataView(v:unknown,after=0,sql=false):KhataView {
 const keys='v,state,serverAt,linkId,accountId,shopName,outletName,customerName,marketCode,currency,timeZone,balance,settingsRevision,wallets,entries,next';
 if(!object(v)||!exact(v,sql?keys.replace('shopName,','shopNameJson,').replace('outletName,','outletNameJson,').replace('customerName,','customerNameJson,'):keys)||v.v!==1||v.state!=='view'||!time(v.serverAt)||!khataId(v.linkId)||!khataId(v.accountId)||!int(v.balance,-Number.MAX_SAFE_INTEGER)||typeof v.currency!=='string'||!/^[A-Z]{3}$/.test(v.currency)||typeof v.timeZone!=='string'||typeof v.marketCode!=='string'||!Object.hasOwn(marketPacks,v.marketCode)||!int(v.settingsRevision)||!Array.isArray(v.wallets)||v.wallets.length>8||!Array.isArray(v.entries)||v.entries.length>50||v.next!==null&&!int(v.next,1))throw bad();
 new Intl.DateTimeFormat('en',{timeZone:v.timeZone});const label=(key:string):string=>{const x=sql?literal(v[key+'Json']):v[key];if(typeof x!=='string')throw bad();return x;};
 const wallets=v.wallets.map(parseCheckoutWallet);if(new Set(wallets.map(w=>w.id)).size!==wallets.length||wallets.some(w=>!marketPacks[v.marketCode as MarketCode]['pay/wallets'].includes(w.name)))throw bad();
 let previous=after;const seen=new Set<string>(),entries=v.entries.map(raw=>{
  const k='id,sequence,type,amount,delta,at,note,by,method,orderNumber,reversalOf';if(!object(raw)||!exact(raw,sql?k.replace('note,','noteJson,').replace('by,','byJson,').replace('method,','methodJson,').replace('orderNumber,','orderNumberJson,'):k)||!khataId(raw.id)||seen.has(raw.id)||!int(raw.sequence,previous+1)||!['charge','payment','adjustment','reminder','refund'].includes(raw.type as string)||!int(raw.amount,raw.type==='adjustment'?-Number.MAX_SAFE_INTEGER:0)||!int(raw.delta,-Number.MAX_SAFE_INTEGER)||!time(raw.at)||raw.reversalOf!==null&&!khataId(raw.reversalOf))throw bad();
  const delta=raw.type==='payment'?-raw.amount:raw.type==='charge'||raw.type==='adjustment'?raw.amount:0;if(raw.delta!==delta||raw.type==='reminder'&&raw.amount!==0)throw bad();seen.add(raw.id);previous=raw.sequence;
  const field=(key:string,nullable=false)=>{const x=raw[sql?key+'Json':key];if(nullable&&x===null)return null;const s=sql?literal(x):x;if(typeof s!=='string')throw bad();return s;};
  return {id:raw.id,sequence:raw.sequence,type:raw.type as KhataEntry['type'],amount:raw.amount,delta,at:raw.at as number,note:field('note')!,by:field('by',true),method:field('method',true),orderNumber:field('orderNumber',true),reversalOf:raw.reversalOf as string|null};
 });if(v.next!==null&&(entries.length!==50||v.next!==previous))throw bad();
 return {v:1,state:'view',serverAt:v.serverAt as number,linkId:v.linkId,accountId:v.accountId,shopName:label('shopName'),outletName:label('outletName'),customerName:label('customerName'),marketCode:v.marketCode as MarketCode,currency:v.currency,timeZone:v.timeZone,balance:v.balance,settingsRevision:v.settingsRevision,wallets,entries,next:v.next as number|null};
}
