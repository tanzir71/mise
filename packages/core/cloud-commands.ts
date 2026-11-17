export type CloudCommand = {id:string;type:'catalogue.availability';itemId:string;available:boolean}|{id:string;type:'catalogue.undo';undoOf:string};
export interface CloudCommandReceipt {id:string;type:CloudCommand['type'];itemId:string;outletId:string;available:boolean;at:number;itemUpdatedAt:number;sequence:number;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const isId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,max=8640000000000000):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
export function parseCloudCommand(value:unknown):CloudCommand {
  if(!object(value)||!isId(value.id))throw new Error('Use a valid command ID.');
  if(value.type==='catalogue.availability'&&Object.keys(value).sort().join(',')==='available,id,itemId,type'&&isId(value.itemId)&&typeof value.available==='boolean')return {id:value.id,type:value.type,itemId:value.itemId,available:value.available};
  if(value.type==='catalogue.undo'&&Object.keys(value).sort().join(',')==='id,type,undoOf'&&isId(value.undoOf))return {id:value.id,type:value.type,undoOf:value.undoOf};
  throw new Error('Choose a supported catalogue action and its exact fields.');
}
export function parseCloudCommandReceipt(value:unknown,command:CloudCommand):CloudCommandReceipt {
  if(!object(value)||value.id!==command.id||value.type!==command.type||!isId(value.itemId)||!isId(value.outletId)||typeof value.available!=='boolean'||!integer(value.at)||!integer(value.itemUpdatedAt)||!integer(value.sequence,Number.MAX_SAFE_INTEGER)||value.sequence<1||
    (command.type==='catalogue.availability'?(value.itemId!==command.itemId||value.available!==command.available||value.undoOf!==null):value.undoOf!==command.undoOf))throw new Error('Invalid command receipt.');
  return {id:command.id,type:command.type,itemId:value.itemId,outletId:value.outletId,available:value.available,at:value.at,itemUpdatedAt:value.itemUpdatedAt,sequence:value.sequence,undoOf:value.undoOf as string|null};
}
