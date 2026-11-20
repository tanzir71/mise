import type {LocalOutboxEntry} from '@mise/core/local-outbox';
import {isMoneyCommand,parseShopCommand} from '@mise/core/shop-commands';
import {parseMoneyReviewRequest,type MoneyReviewRequest} from '@mise/core/money-review';
import {nativeRowHash} from './canonical-writes';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const fields=(v:unknown)=>object(v)?Object.fromEntries(['id','outletId','accountId','customerId','saleId','creditAccountId','amount','currency','method','methodName','given','change','type','sequence','createdAt','updatedAt','eventId','voidedAt','voidReason','reversalOf','orderId','refundId','returnsChargeId','closingId','who'].filter(key=>v[key]!==undefined).map(key=>[key,v[key]])):null;
/** Complete source/Blob bytes stay immutable in the original outbox. Only the
 * selected financial companions and actual grouped creation witness go on wire. */
export async function prepareMoneyReviewSource(row:LocalOutboxEntry,index:number,id:string,replacementId:string):Promise<MoneyReviewRequest>{
 if(row.status!=='pending'||index!==row.receipts.length||!row.commands[index])throw Error('Review the first unconfirmed original financial action.');
 const command=parseShopCommand(row.commands[index]);
 if(!isMoneyCommand(command)||command.type==='khata.communication'||command.outletId!==row.outletId)throw Error('Choose the original saved money action.');
 const keys=command.type==='khata.undo'?[command.reversalId]:command.type==='khata.payment'?[command.entryId]:[command.saleId,...('entryId'in command&&command.entryId?[command.entryId]:[])],
  money=row.changes.filter(change=>(change.table==='sales'||change.table==='creditEntries')&&keys.includes(change.key)).map(change=>({table:change.table,key:change.key,before:fields(change.before),after:fields(change.after)}));
 let priorCommands:ReturnType<typeof parseShopCommand>[]=[];
 if(command.type==='sale.undo'&&money.find(change=>change.table==='sales')?.before===null){
  priorCommands=row.commands.slice(0,index).map(parseShopCommand).filter(prior=>(prior.type==='sale.record'||prior.type==='sale.credit')&&prior.saleId===command.saleId&&prior.outletId===command.outletId);
  if(priorCommands.length!==1)throw Error('Keep the actual earlier original sale creation.');
 }
 const source={v:1,entryId:row.id,sequence:row.sequence,commandIndex:index,at:row.at,money,priorCommands};
 return parseMoneyReviewRequest({id,replacementId,command,sourceHash:await nativeRowHash({...row,commands:row.commands.map(parseShopCommand),status:'pending',receipts:[]}),sourceJson:JSON.stringify(source)},false);
}
