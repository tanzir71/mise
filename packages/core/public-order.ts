import { e164Pattern,publicRecord,publicShopCodePattern,publicText } from './public-shop';

export interface PublicOrderDraft {
  shopCode:string;shopName:string;name:string;phone:string;fulfilment:'pickup'|'delivery';address:string;when:string;
  items:string[];payment:string;photo:boolean;language:'en'|'bn';
}
export const orderWords={
  en:{order:'🛒 Order for ',name:'Name: ',delivery:'Delivery: ',pickup:'Pickup: ',payment:'Payment: ',items:'— Items —',photo:'(photo attached separately)'},
  bn:{order:'🛒 অর্ডার — ',name:'নাম: ',delivery:'ডেলিভারি: ',pickup:'দোকান থেকে: ',payment:'পেমেন্ট: ',items:'— পণ্য —',photo:'(ছবি WhatsApp-এ আলাদা করে পাঠাতে হবে)'},
} as const;
export function validatePublicOrder(value:unknown):PublicOrderDraft{
  const row=publicRecord(value,['shopCode','shopName','name','phone','fulfilment','address','when','items','payment','photo','language']);
  if(typeof row.shopCode!=='string'||!publicShopCodePattern.test(row.shopCode)||typeof row.phone!=='string'||!e164Pattern.test(row.phone)||!['pickup','delivery'].includes(row.fulfilment as string)||!['en','bn'].includes(row.language as string)||typeof row.photo!=='boolean')throw new Error('Use a valid shop, customer phone and delivery choice.');
  const address=publicText(row.address,250),when=publicText(row.when,120,false,true);
  if((row.fulfilment==='delivery'&&!address.trim())||(row.fulfilment==='pickup'&&address!=='')||when.includes(' · '))throw new Error('Check the delivery address and requested time.');
  if(!Array.isArray(row.items)||row.items.length<1||row.items.length>120)throw new Error('Write the items you need.');
  const items=row.items.map(item=>publicText(item,4000));
  if(!items.some(item=>item.trim())||items.join('\n').length>4000)throw new Error('Write a request of at most 4,000 characters.');
  return {shopCode:row.shopCode,shopName:publicText(row.shopName,80,false,true),name:publicText(row.name,80,false,true),phone:row.phone,fulfilment:row.fulfilment as PublicOrderDraft['fulfilment'],address,when,items,payment:publicText(row.payment,40),photo:row.photo,language:row.language as PublicOrderDraft['language']};
}
export function orderMessage(value:unknown):string{
  const draft=validatePublicOrder(value),w=orderWords[draft.language];
  return [w.order+draft.shopName,w.name+draft.name+' · '+draft.phone,draft.fulfilment==='delivery'?w.delivery+draft.address+' · '+draft.when:w.pickup+draft.when,...(draft.payment?[w.payment+draft.payment]:[]),w.items,...draft.items,...(draft.photo?[w.photo]:[]),`#mise v1 s=${draft.shopCode} p=${draft.photo?1:0}`].join('\n');
}
