import {normaliseItemInput,type ItemInput} from './catalogue-save.ts';
interface CatalogueBase {id:string;outletId:string;occurredAt:number}
export type CatalogueWrite =
 |CatalogueBase&{type:'catalogue.create';itemId:string;categoryId:string;input:ItemInput}
 |CatalogueBase&{type:'catalogue.update';itemId:string;categoryId:string;input:ItemInput}
 |CatalogueBase&{type:'catalogue.delete';itemId:string}
 |CatalogueBase&{type:'catalogue.remove-sample';itemId:string};
export type CloudCommand = CatalogueBase&({type:'catalogue.availability';itemId:string;available:boolean}|{type:'catalogue.undo';undoOf:string})|CatalogueWrite;
export interface CloudCommandReceipt {id:string;type:CloudCommand['type'];itemId:string;outletId:string;occurredAt:number;categoryId:string|null;available:boolean|null;at:number;itemUpdatedAt:number;sequence:number;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const isId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,max=8640000000000000):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys;
export function isCatalogueWrite(c:CloudCommand):c is CatalogueWrite{return c.type==='catalogue.create'||c.type==='catalogue.update'||c.type==='catalogue.delete'||c.type==='catalogue.remove-sample';}
export function catalogueRecordPlan(value:CatalogueWrite){const c=parseCloudCommand(value);if(!isCatalogueWrite(c))throw new Error('Keep the catalogue write.');return {categoryId:'input' in c?c.categoryId:null,input:'input' in c?{nameJson:JSON.stringify(c.input.name),localJson:JSON.stringify(c.input.nameLocal),unitJson:JSON.stringify(c.input.unit),categoryJson:JSON.stringify(c.input.category),price:c.input.price,available:c.input.available,oftenBought:c.input.oftenBought}:null,intentJson:JSON.stringify(c)};}
export function parseCloudCommand(value:unknown):CloudCommand {
 if(!object(value)||!isId(value.id)||!isId(value.outletId)||!integer(value.occurredAt))throw new Error('Keep the original catalogue command, outlet and occurrence time.');
 const base={id:value.id,outletId:value.outletId,occurredAt:value.occurredAt},inputValue=value.input;
 if(value.type==='catalogue.undo'&&exact(value,'id,occurredAt,outletId,type,undoOf')&&isId(value.undoOf)&&value.undoOf!==value.id)return {...base,type:value.type,undoOf:value.undoOf};
 if(!isId(value.itemId)||value.itemId===value.id)throw new Error('Keep the original catalogue item identity.');
 if(value.type==='catalogue.availability'&&exact(value,'available,id,itemId,occurredAt,outletId,type')&&typeof value.available==='boolean')return {...base,type:value.type,itemId:value.itemId,available:value.available};
 if((value.type==='catalogue.delete'||value.type==='catalogue.remove-sample')&&exact(value,'id,itemId,occurredAt,outletId,type'))return {...base,type:value.type,itemId:value.itemId};
 if((value.type==='catalogue.create'||value.type==='catalogue.update')&&exact(value,'categoryId,id,input,itemId,occurredAt,outletId,type')&&isId(value.categoryId)&&value.categoryId!==value.id&&value.categoryId!==value.itemId&&object(inputValue)&&exact(inputValue,'available,category,name,nameLocal,oftenBought,price,unit')&&['name','nameLocal','category','unit'].every(k=>typeof inputValue[k]==='string')&&typeof inputValue.available==='boolean'&&typeof inputValue.oftenBought==='boolean'){
  return {...base,type:value.type,itemId:value.itemId,categoryId:value.categoryId,input:normaliseItemInput(inputValue as unknown as ItemInput)};
 }
 throw new Error('Choose a supported catalogue action and its exact original fields.');
}
export function parseCloudCommandReceipt(value:unknown,command:CloudCommand):CloudCommandReceipt {
 const removed=command.type==='catalogue.delete'||command.type==='catalogue.remove-sample';
 if(!object(value)||value.id!==command.id||value.type!==command.type||!isId(value.itemId)||value.outletId!==command.outletId||value.occurredAt!==command.occurredAt||!(typeof value.available==='boolean'||value.available===null)||!integer(value.at)||!integer(value.itemUpdatedAt)||!integer(value.sequence,Number.MAX_SAFE_INTEGER)||value.sequence<1||
  (removed?value.available!==null||value.categoryId!==null:typeof value.available!=='boolean'||!isId(value.categoryId))||
  (command.type==='catalogue.undo'?value.undoOf!==command.undoOf:value.itemId!==command.itemId||value.undoOf!==null)||
  (command.type==='catalogue.availability'&&value.available!==command.available)||
  ('input' in command&&(value.available!==command.input.available||value.categoryId!==command.categoryId)))throw new Error('Invalid command receipt.');
 return {id:command.id,type:command.type,itemId:value.itemId,outletId:command.outletId,occurredAt:command.occurredAt,categoryId:value.categoryId as string|null,available:value.available,at:value.at,itemUpdatedAt:value.itemUpdatedAt,sequence:value.sequence,undoOf:value.undoOf as string|null};
}
