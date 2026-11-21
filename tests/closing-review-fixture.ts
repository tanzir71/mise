import {closingPreview,type TodayContext} from '../packages/core/today';
import {closeDayCommand,undoClosingCommand,type ClosingChange} from '../packages/core/closing';
import {parseClosingCommand,type ClosingCommand} from '../packages/core/closing-commands';
import {closingFingerprint} from '../packages/core/closing-replay';
import {cloudRecordMaps,encodeCommandRecord} from '../packages/core/cloud-records';
import {prepareClosingReviewView,type ClosingReviewCurrent} from '../packages/core/closing-review-view';
import {closingIntent} from '../apps/web/src/data/outbox-intents';
import {parseClosingReviewRequest,closingReviewSourceAudits,type ClosingReviewRequest} from '../packages/core/closing-review-source';
import {recordSaleCommand} from '../packages/core/sales';
import {creditFixture,at} from './credit-fixture';
import type {LocalOutboxEntry,LocalRowChange} from '../packages/core/local-outbox';
import type {BackupTable} from '../packages/core/backup-tables';
import type {DayClosing,Sale} from '../packages/core/models';
export const id=(n:number)=>String(n).padStart(26,'0'),literal='Count · বাংলা\0\ud800';
export const modes=['exact','surplus','shortfall','explained-surplus','undo','undo-surplus'] as const;
export type Mode=typeof modes[number];
export function fixture(mode:Mode='surplus',options:{at?:number;currency?:string;timezone?:string}={}){
 const baseAt=options.at??at,{context:{setup}}=creditFixture('BD',baseAt);let n=10000;const next=()=>id(++n);
 if(options.currency)setup.outlet.currency=options.currency;if(options.timezone)setup.outlet.timezone=options.timezone;
 const initial=recordSaleCommand({expression:'100',method:'cash',who:'Customer'},{setup,items:[],wallets:[]},baseAt,next);
 const context:TodayContext={setup,sales:[initial.sale],orders:[],refunds:[],accounts:[],entries:[],customers:[],stock:[],closings:[]},occurredAt=baseAt+1000,p=closingPreview(context,occurredAt);
 const add=mode==='surplus'||mode==='undo-surplus',delta=add||mode==='explained-surplus'?2501:mode==='shortfall'?-1001:0;
 const created=closeDayCommand({id:id(12000),day:p.summary.day,fingerprint:p.fingerprint,countedCash:p.summary.expectedCash+delta,addDifference:add,note:literal},context,occurredAt,next);
 let change:ClosingChange=created,command:ClosingCommand=closingIntent(created);
 if(mode.startsWith('undo')){change=undoClosingCommand(created.closing,setup,created.sale,baseAt+2000,next);command=closingIntent(change,true);}
 command=parseClosingCommand(command);
 const before=mode.startsWith('undo')?created.closing:null;
 const changes:LocalRowChange[]=[{table:'dayClosings',key:change.closing.id,before,after:change.closing}];
 if(change.sale)changes.push({table:'sales',key:change.sale.id,before:mode.startsWith('undo')?created.sale!:null,after:change.sale});
 changes.push(...change.events.map(after=>({table:'events' as const,key:after.id,before:null,after})));
 const row:LocalOutboxEntry={id:id(90000),version:1,uploadId:id(90003),businessId:setup.business.id,outletId:setup.outlet.id,sequence:1,at:command.occurredAt,status:'pending',commands:[command],receipts:[],changes};
 const packet:ClosingReviewRequest=parseClosingReviewRequest({id:id(90001),replacementId:id(90002),command,sourceHash:'a'.repeat(64),sourceJson:JSON.stringify({v:1,businessId:setup.business.id,entryId:row.id,sequence:1,commandIndex:0,at:command.occurredAt,events:closingReviewSourceAudits(command,change.events)})},false);
 return {context,created,change,command,packet,row,initial};
}
export function currentContext(f:{command:ClosingCommand;row:Pick<LocalOutboxEntry,'businessId'>;context:TodayContext;created:Pick<ClosingChange,'closing'|'sale'>},options:{context?:TodayContext;closing?:DayClosing|null;sale?:Sale|null}={}){
 const context=options.context??f.context,undo=f.command.type==='closing.undo',businessId=f.row.businessId;
 const raw=(table:BackupTable,value:unknown|null)=>value===null?null:Object.fromEntries(Object.entries(encodeCommandRecord(table,value,businessId).values).map(([k,v])=>[k,v!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const tables={sales:'sales',orders:'orders',refunds:'orderRefunds',accounts:'creditAccounts',entries:'creditEntries',customers:'customers',stock:'stockItems',closings:'dayClosings'} as const;
 return JSON.stringify({business:raw('businesses',context.setup.business),outlet:raw('outlets',context.setup.outlet),actorName:context.setup.owner.name,closing:raw('dayClosings',Object.hasOwn(options,'closing')?options.closing:undo?f.created.closing:null),sale:raw('sales',Object.hasOwn(options,'sale')?options.sale:undo?f.created.sale??null:null),...Object.fromEntries(Object.entries(tables).map(([k,table])=>[k,context[k as keyof typeof tables].map(value=>raw(table,value))]))});
}
export async function view(f=fixture(),options:Parameters<typeof currentContext>[1]={},patch:Partial<ClosingReviewCurrent>={},at=f.command.occurredAt+60000){
 const current:ClosingReviewCurrent={stateHash:'c'.repeat(64),contextJson:currentContext(f,options),available:true,...patch};
 return prepareClosingReviewView({v:1,id:f.packet.id,replacementId:f.packet.replacementId,commandId:f.command.id,commandHash:await closingFingerprint(f.command),sourceHash:f.packet.sourceHash,businessId:f.row.businessId,outletId:f.row.outletId,actorId:f.context.setup.owner.id,token:'t'.repeat(43),at,expiresAt:at+120000},current,f.packet);
}
