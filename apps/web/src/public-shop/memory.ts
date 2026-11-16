import {e164Pattern,publicText,type PublicShop} from '@mise/core/public-shop';
import {validatePublicOrder,type PublicOrderDraft} from '@mise/core/public-order';
import type {PublicLanguage} from './copy';
export interface CustomerMemory {v:1;name:string;phone:string;address:string;language:PublicLanguage;last?:{draft:PublicOrderDraft;at:number}}
export function memoryKey(shop:PublicShop):string{return `mise.customer.v1.${shop.code}.${shop.phone}`;}
export function emptyMemory():CustomerMemory{return {v:1,name:'',phone:'',address:'',language:'en'};}
export function readMemory(shop:PublicShop,storage:Pick<Storage,'getItem'>):CustomerMemory{
  try{
    const value=JSON.parse(storage.getItem(memoryKey(shop))||'null');if(!value||value.v!==1||!['en','bn'].includes(value.language)||typeof value.phone!=='string'||(value.phone&&!e164Pattern.test(value.phone)))return emptyMemory();
    const memory:CustomerMemory={v:1,name:publicText(value.name,80),phone:value.phone,address:publicText(value.address,250),language:value.language};
    if(value.last&&Number.isSafeInteger(value.last.at)&&value.last.at>=0&&value.last.at<=8640000000000000){const draft=validatePublicOrder(value.last.draft);if(draft.shopCode===shop.code)memory.last={draft,at:value.last.at};}return memory;
  }catch{return emptyMemory();}
}
