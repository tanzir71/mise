import {normalisePhone} from './phone';
import {parseOrderMessage} from './parse-order-message';
import {publicText} from './public-shop';
import type {MarketCode} from './packs';

export interface PastedOrderLine {
  /** Original literal line, including its spacing. Never executable input. */
  text:string;
  name:string;
  quantity:number|null;
  unit:string|null;
}
export interface PastedOrderDraft {
  format:'mise-v1'|'free-text';
  sourceText:string;
  name:string;
  phone:string;
  fulfilment:'delivery'|'pickup'|null;
  address:string;
  requestedTime:string;
  paymentPreference:string;
  photoExpected:boolean;
  shopCode:string;
  shopName:string;
  lines:PastedOrderLine[];
  warnings:string[];
}

const units:Record<string,string>={kg:'kg',kgs:'kg',কেজি:'kg',কিলো:'kg',g:'g',gm:'g',grams:'g',গ্রাম:'g',l:'L',ltr:'L',litre:'L',liter:'L',লিটার:'L',ml:'ml',মিলি:'ml',pc:'pc',pcs:'pc',piece:'pc',pieces:'pc',টি:'pc',টা:'pc',হালি:'hali',hali:'hali',dozen:'dozen',ডজন:'dozen'};
const number='[0-9০-৯]+(?:\\.[0-9০-৯]{1,3})?';
const leading=new RegExp(`^(${number})(?:\\s*x\\s+|\\s*×\\s*|\\s+)(.+)$`,'i');
const compact=new RegExp(`^(${number})(${Object.keys(units).join('|')})\\s+(.+)$`,'i');
const trailing=new RegExp(`^(.+?)\\s+[x×]\\s*(${number})$`,'i');
function quantity(value:string):number|null {
  const result=Number(value.replace(/[০-৯]/g,digit=>String(digit.charCodeAt(0)-0x09e6)));
  return result>0&&result<=999999?result:null;
}

/** Only explicit counts/units are proposed. Prices and catalogue matches wait for review. */
export function parsePastedOrderLine(text:string):PastedOrderLine {
  const literal={text,name:text.trim(),quantity:null,unit:null};
  const value=text.trim(),joined=compact.exec(value);
  if(joined){const qty=quantity(joined[1]);return qty===null?literal:{text,name:joined[3].trim(),quantity:qty,unit:units[joined[2].toLowerCase()]};}
  const start=leading.exec(value);
  if(start){
    const qty=quantity(start[1]);if(qty===null)return literal;
    const rest=start[2].trim(),first=/^(\S+)(?:\s+(.+))?$/.exec(rest)!;
    const unit=units[first[1].toLowerCase()];
    if(unit&&!first[2])return literal;
    return {text,name:unit?first[2]:rest,quantity:qty,unit:unit||'pc'};
  }
  const end=trailing.exec(value);
  if(end){const qty=quantity(end[2]);if(qty!==null)return {text,name:end[1].trim(),quantity:qty,unit:'pc'};}
  return literal;
}

/** Produces a proposal only. Caller must review and use the ordinary audited order save. */
export function parsePastedOrder(sourceText:string,market:MarketCode='BD'):PastedOrderDraft {
  publicText(sourceText,12000,true,true);
  const rows=sourceText.replace(/\r\n?/g,'\n').split('\n').filter(line=>line.trim());
  if(rows.length>200)throw new Error('Paste at most 200 non-empty lines. Split a longer request.');
  const request=parseOrderMessage(sourceText,market);
  if(request)return {format:'mise-v1',sourceText,name:request.name,phone:request.phone,fulfilment:request.fulfilment,address:request.address,requestedTime:request.when,paymentPreference:request.payment,photoExpected:request.photo,shopCode:request.shopCode,shopName:request.shopName,lines:request.items.filter(line=>line.trim()).map(parsePastedOrderLine),warnings:[]};
  const draft:PastedOrderDraft={format:'free-text',sourceText,name:'',phone:'',fulfilment:null,address:'',requestedTime:'',paymentPreference:'',photoExpected:false,shopCode:'',shopName:'',lines:[],warnings:[]};
  if(rows.some(line=>/^#mise\b/i.test(line.trim()))){
    draft.warnings.push('The Mise message could not be verified. All lines are kept for manual review.');
    draft.lines=rows.map(parsePastedOrderLine);return draft;
  }
  const used=new Set<string>();
  for(const text of rows){
    const value=text.trim(),label=/^(name|নাম|phone|mobile|ফোন|মোবাইল|address|ঠিকানা|time|when|সময়|সময়|payment|পেমেন্ট|pickup|পিকআপ|দোকান থেকে|delivery|ডেলিভারি)\s*:\s*(.+)$/i.exec(value);
    let accepted=false;
    if(label){
      const key=label[1].toLowerCase(),content=label[2].trim();
      const group=/^(name|নাম)$/.test(key)?'name':/^(phone|mobile|ফোন|মোবাইল)$/.test(key)?'phone':/^(address|ঠিকানা)$/.test(key)?'address':/^(time|when|সময়|সময়)$/.test(key)?'time':/^(payment|পেমেন্ট)$/.test(key)?'payment':'fulfilment';
      if(!used.has(group)){
        if(group==='name'&&content.length<=80){draft.name=content;accepted=true;}
        if(group==='phone'){const phone=normalisePhone(content,market);if(phone){draft.phone=phone;accepted=true;}}
        if(group==='address'&&content.length<=250){draft.address=content;draft.fulfilment??='delivery';accepted=true;}
        if(group==='time'&&content.length<=120){draft.requestedTime=content;accepted=true;}
        if(group==='payment'&&content.length<=40){draft.paymentPreference=content;accepted=true;}
        if(group==='fulfilment'){
          const pickup=/^(pickup|পিকআপ|দোকান থেকে)$/.test(key);
          if(pickup&&content.length<=120){draft.fulfilment='pickup';draft.requestedTime=content;accepted=true;}
          if(!pickup&&content.length<=250){draft.fulfilment='delivery';draft.address=content;accepted=true;}
        }
        if(accepted)used.add(group);
      }
    }else if(!used.has('phone')&&/^[+০-৯\d ().-]{7,40}$/.test(value)){
      const phone=normalisePhone(value,market);if(phone){draft.phone=phone;used.add('phone');accepted=true;}
    }
    if(!accepted)draft.lines.push(parsePastedOrderLine(text));
  }
  return draft;
}
