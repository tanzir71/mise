import {estimateDelay,estimateFinished} from '@mise/core/order-estimates';
import type {CustomerOrder} from '@mise/core/customer-links';
const words={en:{arrival:'Arriving',ready:'Ready around',unknownArrival:'Arrival time has not been set',unknownReady:'Ready time has not been set',help:'Contact the shop for an estimate.',withdrawn:'The shop withdrew this estimate.',updated:'Estimate updated',original:'First estimated by',late:'Running about',minutes:'minutes late at the last check.',lateHelp:'The estimated time has passed. Contact the shop for an update.'},bn:{arrival:'পৌঁছানোর সম্ভাব্য সময়',ready:'প্রস্তুত হওয়ার সম্ভাব্য সময়',unknownArrival:'পৌঁছানোর সময় জানানো হয়নি',unknownReady:'প্রস্তুত হওয়ার সময় জানানো হয়নি',help:'সময় জানতে দোকানে যোগাযোগ করুন।',withdrawn:'দোকান আগের সময়টি প্রত্যাহার করেছে।',updated:'সময় সংশোধন করা হয়েছে',original:'প্রথমে জানানো সময়',late:'শেষবার যাচাইয়ের সময় প্রায়',minutes:'মিনিট দেরি হয়েছে।',lateHelp:'জানানো সময় পেরিয়ে গেছে। নতুন খবর জানতে দোকানে যোগাযোগ করুন।'}};
export function CustomerOrderEstimate({order,language}:{order:CustomerOrder;language:'en'|'bn'}){
 if(estimateFinished(order.status))return null;
 const c=words[language],estimate=order.estimate,delay=estimateDelay(estimate,order.status,order.estimateObservedAt??NaN),time=(at:number)=>new Intl.DateTimeFormat(language==='bn'?'bn-BD':'en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:order.timezone}).format(at),number=(n:number)=>new Intl.NumberFormat(language==='bn'?'bn-BD':'en-GB').format(n);
 return <>{delay!==null?<aside className="customer-order-delay" role="status" aria-label={language==='bn'?'দেরির খবর':'Delay notice'}><strong>{c.late} {number(delay)} {c.minutes}</strong><p>{c.lateHelp}</p></aside>:null}<div className="customer-order-estimate" aria-live="polite">
  <strong>{estimate?.start!=null?`${order.type==='delivery'?c.arrival:c.ready} ${time(estimate.start)} – ${time(estimate.end!)}`:estimate?c.withdrawn:order.type==='delivery'?c.unknownArrival:c.unknownReady}</strong>
  {estimate?.note?<span>{estimate.note}</span>:null}{estimate?.firstEnd!=null&&(estimate.end===null||estimate.end!==estimate.firstEnd)?<span>{c.original} {time(estimate.firstEnd)}</span>:null}
  <span>{estimate?`${c.updated} ${time(estimate.updatedAt)}`:c.help}</span>
 </div></>;
}
