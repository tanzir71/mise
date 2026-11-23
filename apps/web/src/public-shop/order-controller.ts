import {publicOrderShopSource,type PublicOrderingLink} from '@mise/core/public-order-link';
import {publicSubmissionMessage,type PublicOrderIntent} from '@mise/core/public-order-submission';
import {customerViewerUrl} from '@mise/core/customer-link-url';
import {createPublicOrderSession,type CustomerOrderFields,type SavedPublicOrder} from './order-session';
import {PublicOrderError} from './order-remote';
import {el} from './dom';
import './order-controls.css';
const words={
 en:{title:'Place your order',send:'Place order',retry:'Send original request',check:'Check original request',close:'Close unfinished request',another:'Start a new order',tracker:'Open tracking',copy:'Copy saved request',source:'Original request',initial:'The shop confirms availability, delivery fees and payment. Nothing is charged here.',saved:'Saved on this device. Check before sending another order.',pending:'The original request is unfinished. Retry it or close it before starting another.',closing:'Closure is saved on this device. Check or retry closure before starting another order.',closed:'This request was closed before an order was created.',created:'The shop received this order.',checking:'Checking the original request…',sending:'Sending the original request…',photo:'Send photos using the message option. They are not uploaded with an online order.',unavailable:'Online ordering is unavailable in this browser. Use the message option.',unconfirmed:'The request is unconfirmed. Check it before sending another order.',review:'Keep the original request and review it with the shop.',missing:'This request could not be checked. Contact the shop before sending another.',limited:'The shop is busy. Keep the original request and retry shortly.',copied:'Original request copied.',selected:'Original request selected. Use your browser’s Copy action.',message:'Send a message',charge:'Nothing is charged here. The shop confirms your order.'},
 bn:{title:'অর্ডার দিন',send:'অর্ডার দিন',retry:'আগের অনুরোধটি পাঠান',check:'আগের অনুরোধ দেখুন',close:'অসম্পূর্ণ অনুরোধ বন্ধ করুন',another:'নতুন অর্ডার শুরু করুন',tracker:'অর্ডারের অবস্থা দেখুন',copy:'সেভ করা অনুরোধ কপি',source:'আগের অনুরোধ',initial:'পণ্য, ডেলিভারি খরচ ও পেমেন্ট দোকান নিশ্চিত করবে। এখানে টাকা নেওয়া হয় না।',saved:'এই ডিভাইসে সেভ আছে। আরেকটি অর্ডার পাঠানোর আগে যাচাই করুন।',pending:'আগের অনুরোধ অসম্পূর্ণ। আবার পাঠান বা বন্ধ করে নতুন অর্ডার শুরু করুন।',closing:'বন্ধ করার অনুরোধ সেভ আছে। নতুন অর্ডারের আগে বন্ধ হয়েছে কিনা যাচাই করুন।',closed:'অর্ডার তৈরি হওয়ার আগে অনুরোধটি বন্ধ হয়েছে।',created:'দোকান অর্ডারটি পেয়েছে।',checking:'আগের অনুরোধ যাচাই হচ্ছে…',sending:'আগের অনুরোধ পাঠানো হচ্ছে…',photo:'ছবি মেসেজে পাঠান। অনলাইন অর্ডারের সঙ্গে ছবি আপলোড হয় না।',unavailable:'এই ব্রাউজারে অনলাইন অর্ডার সম্ভব হচ্ছে না। মেসেজ ব্যবহার করুন।',unconfirmed:'অনুরোধ নিশ্চিত নয়। আরেকটি অর্ডার দেওয়ার আগে যাচাই করুন।',review:'আগের অনুরোধটি রেখে দোকানের সঙ্গে যাচাই করুন।',missing:'অনুরোধ যাচাই করা যায়নি। আরেকটি পাঠানোর আগে দোকানে যোগাযোগ করুন।',limited:'দোকানে অনেক অনুরোধ আসছে। কিছুক্ষণ পরে আগেরটি আবার চেষ্টা করুন।',copied:'আগের অনুরোধ কপি হয়েছে।',selected:'অনুরোধ বাছাই করা আছে। ব্রাউজার দিয়ে কপি করুন।',message:'মেসেজ পাঠান',charge:'এখানে টাকা নেওয়া হয় না। দোকান অর্ডার নিশ্চিত করবে।'},
};
export async function mountPublicOrdering(link:PublicOrderingLink,deps:{parent:HTMLElement;language:()=> 'en'|'bn';capture:()=>{fields:CustomerOrderFields;photo:boolean};restore:(intent:PublicOrderIntent)=>void;original:(intent:PublicOrderIntent|null,message?:string)=>void}){
 const source=publicOrderShopSource(link.sourceUrl),base=source.url.pathname.slice(0,-2),language=()=>words[deps.language()],
  panel=el('section',{class:'public-online-order','aria-label':'Online order'}),heading=el('h2'),help=el('p',{class:'public-caption'}),status=el('p',{role:'status'}),error=el('p',{role:'alert',class:'public-error-message',hidden:true}),
  button=()=>el('button',{type:'button',class:'button button-secondary'}),submit=button(),check=button(),close=button(),another=button(),copy=button(),tracker=el('a',{class:'button button-primary',hidden:true}),
  text=el('textarea',{readOnly:true,rows:'5','aria-label':language().source,hidden:true}),honey=el('input',{type:'text',id:'public-order-website',name:'website',tabindex:'-1',autocomplete:'off'}),
  honeyRow=el('div',{class:'public-order-honey','aria-hidden':'true'},el('label',{for:'public-order-website'},'Website'),honey);
 submit.className='button button-primary';panel.append(heading,help,honeyRow,submit,status,error,el('div',{class:'public-order-recovery'},check,close,copy,another),text,tracker);deps.parent.prepend(panel);
 let session:Awaited<ReturnType<typeof createPublicOrderSession>>|null=null,original:SavedPublicOrder|null=null,busy=false,active=true,fresh=false;
 const controller=new AbortController(),originalHash=location.hash;
 function render(){
  const w=language(),done=original?.outcome?.state==='created',closed=original?.outcome?.state==='closed';
  heading.textContent=link.table?`${link.table} · ${w.title}`:w.title;help.textContent=w.initial;
  submit.textContent=original&&!fresh?w.retry:w.send;submit.hidden=Boolean(original&&!fresh&&(done||closed||original.closeRequested));
  check.textContent=w.check;close.textContent=w.close;another.textContent=w.another;copy.textContent=w.copy;tracker.textContent=w.tracker;
  for(const b of [submit,check,close,another,copy])b.disabled=busy||!session;
  check.hidden=!original||fresh;close.hidden=!original||fresh||Boolean(done||closed);copy.hidden=!original||fresh;another.hidden=!original||fresh||!done&&!closed;
  tracker.hidden=!original||fresh||!done||Boolean(original.outcome?.link?.revokedAt);text.hidden=!original||fresh;
  if(original&&!fresh){text.value=publicSubmissionMessage(original.submission.intent);status.textContent=closed?w.closed:done?w.created:original.closeRequested?w.closing:original.outcome?.state==='pending'?w.pending:w.saved;
   if(done&&original.outcome?.link?.revokedAt===null)tracker.href=customerViewerUrl(source.url.origin,base,{apiUrl:link.apiUrl,kind:'order',token:original.submission.trackingToken},{checkout:true});
  }else status.textContent='';
  text.setAttribute('aria-label',w.source);deps.original(original&&!fresh&&!closed?original.submission.intent:null,original&&!fresh&&!closed?text.value:'');
  const fallback=document.getElementById('public-send');if(fallback){fallback.classList.replace('button-primary','button-secondary');const label=fallback.querySelector('[data-copy]');if(label)label.textContent=w.message;}
  const charge=deps.parent.querySelector('[data-copy="noCharge"]');if(charge)charge.textContent=w.charge;
  const forget=document.querySelector('[data-action="forget"]');if(forget)forget.textContent=deps.language()==='bn'?'ফর্মের তথ্য মুছুন':'Clear form details';
 }
 async function refresh(){if(session){const saved=await session.saved();original=saved.attempts.at(-1)??null;}if(active)render();}
 async function action(kind:'submit'|'inspect'|'close'){
  if(busy||!session||!active)return;busy=true;error.hidden=true;render();status.textContent=kind==='submit'?language().sending:language().checking;
  try{
   if((!original||fresh)&&kind==='submit'){
    const capture=deps.capture();if(capture.photo)throw Error(language().photo);original=await session.prepare(capture.fields,honey.value);fresh=false;render();
   }
   if(!original)throw Error(language().review);
   const result=await session.call(original.submission.intent.id,kind,controller.signal);if(!active)return;original=result.attempt;
   render();if(result.outcome.state==='created'&&result.outcome.link?.revokedAt===null&&kind!=='close')location.assign(tracker.href);
  }catch(e){if(active){try{await refresh();}catch{/* Keep the original in memory if storage cannot be read. */}error.hidden=false;error.textContent=e instanceof PublicOrderError?language()[e.kind]:e instanceof Error?e.message:language().unconfirmed;}}
  finally{busy=false;if(active)render();}
 }
 submit.onclick=()=>void action('submit');check.onclick=()=>void action('inspect');close.onclick=()=>void action('close');another.onclick=()=>{fresh=true;deps.original(null);render();};
 copy.onclick=async()=>{if(!original)return;text.hidden=false;let copied=false;try{await navigator.clipboard.writeText(text.value);copied=true;}catch{text.focus();text.select();}status.textContent=copied?language().copied:language().selected;};
 const changed=()=>render();document.getElementById('shop-root')?.addEventListener('mise-public-language',changed);
 const stop=()=>{active=false;controller.abort();session?.stop();document.getElementById('shop-root')?.removeEventListener('mise-public-language',changed);};window.addEventListener('pagehide',stop,{once:true});
 // A history restore retains this stopped session. Reload from the offline cache
 // and recover its journal before enabling actions again.
 window.addEventListener('pageshow',(event:PageTransitionEvent)=>{if(event.persisted&&!active)location.reload();});
 try{if(!navigator.locks)throw Error();session=await createPublicOrderSession(link,{storage:localStorage,locks:navigator.locks,isCurrent:()=>active&&location.hash===originalHash});const recovered=(await session.saved()).attempts.at(-1);original=recovered??null;render();if(recovered&&(!recovered.outcome||recovered.outcome.state==='pending'))deps.restore(recovered.submission.intent);}
 catch{error.hidden=false;error.textContent=language().unavailable;render();}
 return {refresh:changed,stop};
}
