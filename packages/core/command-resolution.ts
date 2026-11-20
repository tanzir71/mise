import {parseOrderCommand,parseOrderCommandReceipt,type OrderCommand,type OrderCommandReceipt} from './order-commands';

export const commandReviewHeader='X-Mise-Command-Review';
export const commandReviewBodyLimit=8_000_000;
export interface CommandResolutionReceipt {
  id:string;type:'command.resolved';commandId:string;commandType:OrderCommand['type'];
  outletId:string;occurredAt:number;commandHash:string;sourceHash:string;at:number;
  outcome:'withdrawn'|'replaced';replacement:{id:string;revision:number;commandHash:string;receipt:OrderCommandReceipt}|null;
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;

/** A new, explicitly reviewed intent. The retained original and every reserved
 * financial/source identity stay unchanged. Undo keeps its actual expiry. */
export function reviewedOrderProposal(original:OrderCommand,revision:number|null,replacementId:string):OrderCommand {
  const c=parseOrderCommand(original);
  if(c.type==='order.warning-settings'||!id(replacementId)||replacementId===c.id)throw new Error('Keep distinct original and reviewed action identities.');
  if(c.type==='order.create'){
    if(revision!==null)throw new Error('Review this existing order manually.');
    return parseOrderCommand({...c,id:replacementId});
  }
  if(revision===null||!Number.isSafeInteger(revision)||revision<c.revision)throw new Error('Review the original order and its current revision.');
  return parseOrderCommand({...c,id:replacementId,revision});
}
export function parseCommandResolutionReceipt(value:unknown,original:OrderCommand):CommandResolutionReceipt {
  const c=parseOrderCommand(original);
  if(!object(value)||Object.keys(value).sort().join(',')!=='at,commandHash,commandId,commandType,id,occurredAt,outcome,outletId,replacement,sourceHash,type'||
    value.type!=='command.resolved'||!id(value.id)||value.id===c.id||value.commandId!==c.id||value.commandType!==c.type||value.outletId!==c.outletId||value.occurredAt!==c.occurredAt||
    !hash(value.commandHash)||!hash(value.sourceHash)||!time(value.at)||!['withdrawn','replaced'].includes(value.outcome as string))throw new Error('Keep the original server resolution proof.');
  let replacement:CommandResolutionReceipt['replacement']=null;
  if(value.outcome==='withdrawn'){
    if(value.replacement!==null)throw new Error('A withdrawn action has no substitute payment receipt.');
  }else{
    if(!object(value.replacement)||Object.keys(value.replacement).sort().join(',')!=='commandHash,id,receipt,revision'||!id(value.replacement.id)||value.replacement.id===value.id||!hash(value.replacement.commandHash)||!Number.isSafeInteger(value.replacement.revision))throw new Error('Keep the actual reviewed action and receipt.');
    const revision=value.replacement.revision as number,command=reviewedOrderProposal(c,c.type==='order.create'?null:revision,value.replacement.id);
    if(c.type==='order.create'&&revision!==0)throw new Error('Keep the reviewed new-order revision.');
    replacement={id:command.id,revision,commandHash:value.replacement.commandHash,receipt:parseOrderCommandReceipt(value.replacement.receipt,command)};
  }
  return {id:value.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:value.commandHash,sourceHash:value.sourceHash,at:value.at,outcome:value.outcome as CommandResolutionReceipt['outcome'],replacement};
}
