import { replayHandoffProgress,type HandoffChoice,type HandoffProgress } from '@mise/core/handoff-progress';
import { validatePublicOrder,type PublicOrderDraft } from '@mise/core/public-order';
import { publicRecord,publicText,type PublicShop } from '@mise/core/public-shop';

export interface PublicHandoffForm {text:string;quantities:[string,number][];when:number;customTime:string}
interface Step extends HandoffChoice {at:number}
export interface PublicAttempt {edition:string;at:number;draft:PublicOrderDraft;form:PublicHandoffForm;steps:Step[]}
type StorageAccess=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
function form(value:unknown):PublicHandoffForm {
  const row=publicRecord(value,['text','quantities','when','customTime']);
  if(!Number.isInteger(row.when)||(row.when as number)<0||(row.when as number)>3||!Array.isArray(row.quantities)||row.quantities.length>20)throw Error('Review this request again.');
  const quantities:[string,number][]=row.quantities.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||!Number.isSafeInteger(pair[1])||pair[1]<1||pair[1]>99)throw Error('Review this request again.');return [publicText(pair[0],80,false,true),pair[1]];});
  if(new Set(quantities.map(pair=>pair[0])).size!==quantities.length)throw Error('Review this request again.');
  return {text:publicText(row.text,4000,true),quantities,when:row.when as number,customTime:publicText(row.customTime,120,true)};
}
export function publicAttemptProgress(attempt:PublicAttempt):HandoffProgress {
  return replayHandoffProgress(attempt.at,attempt.steps);
}
export function publicHandOff(shop:PublicShop,storage?:StorageAccess){
    let attempts:PublicAttempt[]=[],durable=Boolean(storage);
    const key=`mise.public-handoff.v1.${shop.code}.${shop.phone}`;
    try{
      const raw=storage?.getItem(key);if(raw){if(raw.length>1000000)throw Error('Review this request again.');
      const row=publicRecord(JSON.parse(raw),['v','attempts']);if(row.v!==1||!Array.isArray(row.attempts)||row.attempts.length>100)throw Error('Review this request again.');
      attempts=row.attempts.map(value=>{
        const a=publicRecord(value,['edition','at','draft','form','steps']),draft=validatePublicOrder(a.draft),input=form(a.form);
        if(draft.shopCode!==shop.code||typeof a.edition!=='string'||a.edition.length!==26||!Array.isArray(a.steps)||a.steps.length>1000)throw Error('Review this request again.');
        const attempt:PublicAttempt={edition:a.edition,at:a.at as number,draft,form:input,steps:a.steps as Step[]};
        if(attempt.edition===shop.edition&&(draft.shopName!==shop.name||input.quantities.some(([id])=>!shop.items.some(item=>item.id===id&&item.available))))throw Error('Review this request again.');
        publicAttemptProgress(attempt);return attempt;
      });
      if(attempts.reduce((sum,a)=>sum+a.steps.length,0)>1000)throw Error('Review this request again.');
    }}catch{attempts=[];durable=false;}
  function latest():PublicAttempt|undefined {const last=attempts.at(-1);return last?.edition===shop.edition?last:undefined;}
  function prepare(value:PublicOrderDraft,input:PublicHandoffForm,fresh=false):PublicAttempt {
    const draft=validatePublicOrder(value),fields=form(input);if(draft.shopCode!==shop.code||draft.shopName!==shop.name||fields.quantities.some(([id])=>!shop.items.some(item=>item.id===id&&item.available)))throw Error('Review this request again.');
    const current=latest();if(current&&!fresh&&JSON.stringify(current.draft)===JSON.stringify(draft))return current;
    const at=Math.max(0,Date.now()),attempt:PublicAttempt={edition:shop.edition,at,draft,form:fields,steps:[]};publicAttemptProgress(attempt);attempts.push(attempt);save();return attempt;
  }
  function choose(attempt:PublicAttempt,choice:HandoffChoice):HandoffProgress {
    if(!attempts.includes(attempt))throw Error('Review this request again.');
    const at=Math.max(Date.now(),attempt.steps.at(-1)?.at??attempt.at),steps=[...attempt.steps,{...choice,at}],next=replayHandoffProgress(attempt.at,steps);attempt.steps=steps;save();return next;
  }
  function forget():boolean {attempts=[];try{if(!storage)throw Error();storage.removeItem(key);durable=true;}catch{durable=false;}return durable;}
  function save(){try{const value=JSON.stringify({v:1,attempts:attempts});if(!storage||value.length>1000000||attempts.length>100||attempts.reduce((sum,a)=>sum+a.steps.length,0)>1000)throw Error();storage.setItem(key,value);durable=true;}catch{durable=false;}}
  return {key,get durable(){return durable;},get current(){return latest();},prepare,choose,forget} as const;
}

export type PublicHandOff=ReturnType<typeof publicHandOff>;
