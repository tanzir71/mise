import type {AuditEvent,Category,Item} from './models.ts';
export interface ItemInput {name:string;nameLocal:string;price:number;unit:string;category:string;available:boolean;oftenBought:boolean}
export interface CatalogueContext {outletId:string;actorId:string;categories:Category[]}
export interface ItemCommand {item:Item;category?:Category;event:AuditEvent}
export function normaliseItemInput(input:ItemInput):ItemInput {
  const name=input.name.trim(),nameLocal=input.nameLocal.trim(),unit=input.unit.trim(),category=input.category.trim()||'Uncategorised';
  if(!name||name.length>120||nameLocal.length>120)throw new Error('Use an item name between 1 and 120 characters.');
  if(!unit||unit.length>16||category.length>80)throw new Error('Enter a unit and a category of at most 80 characters.');
  if(!Number.isSafeInteger(input.price)||input.price<0)throw new Error('Enter a valid non-negative price.');
  return {name,nameLocal,price:input.price,unit,category,available:Boolean(input.available),oftenBought:Boolean(input.oftenBought)};
}
/** Same catalogue command for local and hosted writes; IDs are supplied by each runtime. */
export function saveCatalogueItem(input:ItemInput,context:CatalogueContext,before:Item|null,at:number,newId:(kind:'item'|'category'|'event')=>string):ItemCommand {
  const value=normaliseItemInput(input);
  if(before&&before.outletId!==context.outletId)throw new Error('This item belongs to another outlet.');
  const existing=context.categories.find(c=>c.outletId===context.outletId&&c.name.normalize('NFKC').toLowerCase()===value.category.normalize('NFKC').toLowerCase());
  const category:Category=existing||{id:newId('category'),outletId:context.outletId,name:value.category,sort:context.categories.length,createdAt:at,updatedAt:at};
  const item:Item={id:before?.id||newId('item'),outletId:context.outletId,name:value.name,nameLocal:value.nameLocal,price:value.price,unit:value.unit,categoryId:category.id,available:value.available,oftenBought:value.oftenBought,isSample:false,createdAt:before?.createdAt??at,updatedAt:at};
  return {item,category:existing?undefined:category,event:{id:newId('event'),outletId:context.outletId,actor:{type:'member',id:context.actorId},command:before?'catalogue.update':'catalogue.create',before,after:{item,category:existing?null:category},at}};
}
