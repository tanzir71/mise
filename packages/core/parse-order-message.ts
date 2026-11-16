import { normalisePhone } from './phone';
import type { MarketCode } from './packs';
import { e164Pattern } from './public-shop';
import { orderWords as words,validatePublicOrder,type PublicOrderDraft } from './public-order';

/** Recognise the envelope only. Its contents are an untrusted draft, never commands. */
export function parseOrderMessage(message:string,market:MarketCode='BD'):PublicOrderDraft|null{
  try{
    if(typeof message!=='string'||message.length>12000)return null;
    const lines=message.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trimEnd().split('\n'),marker=/^#mise v1 s=([A-Z0-9]{1,4}-[A-Z0-9]{4,12})(?: p=([01]))?$/.exec(lines.pop()||'');if(!marker)return null;
    const language=lines[0]?.startsWith(words.en.order)?'en':lines[0]?.startsWith(words.bn.order)?'bn':null;if(!language)return null;
    const w=words[language],shopName=lines[0].slice(w.order.length);if(!lines[1]?.startsWith(w.name))return null;
    const who=lines[1].slice(w.name.length),split=who.lastIndexOf(' · ');if(split<0)return null;
    const header=lines[2]||'',fulfilment=header.startsWith(w.delivery)?'delivery':header.startsWith(w.pickup)?'pickup':null;if(!fulfilment)return null;
    let address='',when=header.slice(w[fulfilment].length);
    if(fulfilment==='delivery'){const separator=when.lastIndexOf(' · ');if(separator<0)return null;address=when.slice(0,separator);when=when.slice(separator+3);}
    let index=3,payment='';if(lines[index]?.startsWith(w.payment)){payment=lines[index].slice(w.payment.length);index++;}if(lines[index++]!==w.items)return null;
    const items=lines.slice(index),photo=marker[2]===undefined?items.at(-1)===w.photo:marker[2]==='1';if(photo&&items.pop()!==w.photo)return null;
    const rawPhone=who.slice(split+3),phone=e164Pattern.test(rawPhone)?rawPhone:normalisePhone(rawPhone,market);if(!phone)return null;
    return validatePublicOrder({shopCode:marker[1],shopName,name:who.slice(0,split),phone,fulfilment,address,when,items,payment,photo,language});
  }catch{return null;}
}
