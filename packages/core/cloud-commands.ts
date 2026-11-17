import {normaliseItemInput,type ItemInput} from './catalogue-save.ts';
export type CatalogueWrite = {id:string;type:'catalogue.create';itemId:string;outletId:string;input:ItemInput}|{id:string;type:'catalogue.update';itemId:string;input:ItemInput}|{id:string;type:'catalogue.delete';itemId:string};
export type CloudCommand = {id:string;type:'catalogue.availability';itemId:string;available:boolean}|{id:string;type:'catalogue.undo';undoOf:string}|CatalogueWrite;
export interface CloudCommandReceipt {id:string;type:CloudCommand['type'];itemId:string;outletId:string;available:boolean|null;at:number;itemUpdatedAt:number;sequence:number;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const isId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,max=8640000000000000):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
export function parseCloudCommand(value:unknown):CloudCommand {
  if(!object(value)||!isId(value.id))throw new Error('Use a valid command ID.');
  const inputValue=value.input;
  if(value.type==='catalogue.availability'&&Object.keys(value).sort().join(',')==='available,id,itemId,type'&&isId(value.itemId)&&typeof value.available==='boolean')return {id:value.id,type:value.type,itemId:value.itemId,available:value.available};
  if(value.type==='catalogue.undo'&&Object.keys(value).sort().join(',')==='id,type,undoOf'&&isId(value.undoOf))return {id:value.id,type:value.type,undoOf:value.undoOf};
  if(value.type==='catalogue.delete'&&Object.keys(value).sort().join(',')==='id,itemId,type'&&isId(value.itemId))return {id:value.id,type:value.type,itemId:value.itemId};
  if((value.type==='catalogue.create'||value.type==='catalogue.update')&&isId(value.itemId)&&object(inputValue)&&
    Object.keys(value).sort().join(',')===(value.type==='catalogue.create'?'id,input,itemId,outletId,type':'id,input,itemId,type')&&
    (value.type!=='catalogue.create'||isId(value.outletId))&&Object.keys(inputValue).sort().join(',')==='available,category,name,nameLocal,oftenBought,price,unit'&&
    ['name','nameLocal','category','unit'].every(k=>typeof inputValue[k]==='string')&&typeof inputValue.available==='boolean'&&typeof inputValue.oftenBought==='boolean'){
    const input=normaliseItemInput(inputValue as unknown as ItemInput);
    return value.type==='catalogue.create'?{id:value.id,type:value.type,itemId:value.itemId,outletId:value.outletId as string,input}:{id:value.id,type:value.type,itemId:value.itemId,input};
  }
  throw new Error('Choose a supported catalogue action and its exact fields.');
}
export function parseCloudCommandReceipt(value:unknown,command:CloudCommand):CloudCommandReceipt {
  if(!object(value)||value.id!==command.id||value.type!==command.type||!isId(value.itemId)||!isId(value.outletId)||!(typeof value.available==='boolean'||value.available===null)||!integer(value.at)||!integer(value.itemUpdatedAt)||!integer(value.sequence,Number.MAX_SAFE_INTEGER)||value.sequence<1||
    (command.type==='catalogue.undo'?value.undoOf!==command.undoOf:value.itemId!==command.itemId||value.undoOf!==null)||
    (command.type==='catalogue.availability'&&value.available!==command.available)||
    (command.type==='catalogue.delete'?value.available!==null:typeof value.available!=='boolean')||
    ((command.type==='catalogue.create'||command.type==='catalogue.update')&&value.available!==command.input.available)||
    (command.type==='catalogue.create'&&value.outletId!==command.outletId))throw new Error('Invalid command receipt.');
  return {id:command.id,type:command.type,itemId:value.itemId,outletId:value.outletId,available:value.available,at:value.at,itemUpdatedAt:value.itemUpdatedAt,sequence:value.sequence,undoOf:value.undoOf as string|null};
}
