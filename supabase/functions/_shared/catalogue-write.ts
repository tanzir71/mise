import {saveCatalogueItem} from '../../../packages/core/catalogue-save.ts';
import {parseCloudCommand,type CatalogueWrite} from '../../../packages/core/cloud-commands.ts';
import type {Category,Item} from '../../../packages/core/models.ts';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export class CatalogueMutationInvalid extends Error {}
export class CatalogueMutationConflict extends Error {}
export async function catalogueFingerprint(c:CatalogueWrite){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parseCloudCommand(c))))),v=>v.toString(16).padStart(2,'0')).join('');}
/** The context is read with the caller JWT. Only this server produces commit fields. */
export function catalogueWriteFields(value:unknown,c:CatalogueWrite,ticketId:string):Record<string,unknown> {
  if(!object(value)||value.done!==false||value.ticketId!==ticketId||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||value.outletId!==c.outletId||!id(value.actorId)||!time(value.at)||typeof value.itemJson!=='string'||typeof value.categoriesJson!=='string')throw new Error('Invalid catalogue context');
  const before:unknown=JSON.parse(value.itemJson),categories:unknown=JSON.parse(value.categoriesJson);
  if((c.type==='catalogue.create'?before!==null:!object(before)||before.id!==c.itemId||before.outletId!==value.outletId||!time(before.createdAt))||!Array.isArray(categories)||!categories.every(x=>object(x)&&id(x.id)&&x.outletId===value.outletId&&typeof x.name==='string'&&typeof x.sort==='number'&&Number.isSafeInteger(x.sort)&&x.sort>=0&&time(x.createdAt)&&time(x.updatedAt)))throw new Error('Invalid catalogue records');
  const result:Record<string,unknown>={p_ticket_id:ticketId,p_token:value.token,p_name_json:null,p_local_json:null,p_unit_json:null,p_price:null,p_category_id:null,p_new_category_json:null,p_available:null,p_often_bought:null};
  if(c.occurredAt>value.at+300000)throw new CatalogueMutationConflict('Check the device clock and keep the original catalogue action.');
  if(c.type==='catalogue.delete'||c.type==='catalogue.remove-sample'){
    if(c.type==='catalogue.remove-sample'&&(!object(before)||before.isSample!==true))throw new CatalogueMutationInvalid('Only sample items can be removed during setup.');
    return result;
  }
  const mutation=saveCatalogueItem(c.input,{outletId:value.outletId,actorId:value.actorId,categories:categories as Category[]},before as Item|null,c.occurredAt,kind=>kind==='item'?c.itemId:kind==='event'?c.id:c.categoryId);
  if(mutation.item.categoryId!==c.categoryId)throw new CatalogueMutationConflict('This category has another saved identity. Keep the original intent for review.');
  return {...result,p_name_json:JSON.stringify(mutation.item.name),p_local_json:JSON.stringify(mutation.item.nameLocal),p_unit_json:JSON.stringify(mutation.item.unit),p_price:mutation.item.price,p_category_id:mutation.item.categoryId,p_new_category_json:mutation.category?JSON.stringify(mutation.category.name):null,p_available:mutation.item.available,p_often_bought:mutation.item.oftenBought};
}
