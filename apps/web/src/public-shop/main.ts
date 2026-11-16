import 'virtual:mise-public-tokens.css';
import '@mise/ui/button.css';
import '@mise/ui/card.css';
import '@mise/ui/public-fonts.css';
import './public-shop.css';
import {defaultFlags,flagValue} from '@mise/core/flags';
import {decodeShopPayload} from '@mise/core/public-shop-decode';
import {normalisePublicPhone} from '@mise/core/public-phone';
import {formatMoney} from '@mise/core/money';
import {orderMessage,type PublicOrderDraft} from '@mise/core/public-order';
import type {PublicShopItem} from '@mise/core/public-shop';
import {el} from './dom';
import {icon,quantityIcon} from './icons';
import {words,type PublicLanguage} from './copy';
import {emptyMemory,memoryKey,readMemory,type CustomerMemory} from './memory';
import {publicHandOff,type PublicHandOff,publicAttemptProgress,type PublicAttempt} from './handoff';
import type {HandoffChoice} from '@mise/core/handoff-progress';

declare const __PUBLIC_PAYMENTS__:Record<string,string[]>;
type Voice={lang:string;interimResults:boolean;continuous:boolean;onresult:((event:{results:ArrayLike<ArrayLike<{transcript:string}>>})=>void)|null;onerror:(()=>void)|null;onend:(()=>void)|null;start:()=>void;stop:()=>void};
type VoiceConstructor=new()=>Voice;
const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById('public-'+id)! as T;
const controls=(selector:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
const pressed=(selector:string,value:string)=>controls(selector).forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.value===value)));
const root=document.getElementById('shop-root')!;
window.addEventListener('hashchange',()=>location.reload());
if(location.pathname.endsWith('/s'))history.replaceState(null,'',location.pathname+'/'+location.search+location.hash);
try{boot();}catch(error){get('shop').hidden=true;get('opening').hidden=true;get('error').hidden=false;get('error-detail').textContent=error instanceof Error?error.message:'Ask the shop for a fresh link.';}

function boot(){
  let flags='';try{flags=localStorage.getItem('mise.flags')||'';}catch{/* Private storage is optional. */}
  const shop=decodeShopPayload(location.hash.slice(1)),menu=shop.mode==='menu',quantities=new Map<string,number>();let memory:CustomerMemory;
  try{memory=readMemory(shop,localStorage);}catch{memory=emptyMemory();}
  const requested=new URLSearchParams(location.search).get('lang');let language:PublicLanguage=requested==='en'||requested==='bn'?requested:memory.language,fulfilment:'pickup'|'delivery'='delivery',when=0,payment='Cash',category='',query='',photo:string|null=null,photoLoading=false,recognition:Voice|null=null,recording=false,pending:PublicOrderDraft|null=null,timer:ReturnType<typeof setTimeout>|undefined;
  const w=()=>words[language],text=get<HTMLTextAreaElement>('list'),name=get<HTMLInputElement>('customer-name'),phone=get<HTMLInputElement>('customer-phone'),address=get<HTMLInputElement>('address'),time=get<HTMLInputElement>('custom-time'),timeSelect=get<HTMLSelectElement>('time-select'),file=get<HTMLInputElement>('photo-input'),message=get<HTMLTextAreaElement>('message'),review=get<HTMLDetailsElement>('review'),send=get<HTMLAnchorElement>('send'),retry=get<HTMLAnchorElement>('retry'),sent=get<HTMLButtonElement>('sent'),voice=get<HTMLButtonElement>('voice'),grid=get('menu-grid');
  let handoff:PublicHandOff|undefined,attempt:PublicAttempt|undefined,dirty=false;
  if(flagValue('handOffs',defaultFlags.handOffs,location.search,flags)){try{handoff=publicHandOff(shop,localStorage);}catch{handoff=publicHandOff(shop);}}
  const failed=get<HTMLButtonElement>('failed'),another=get<HTMLButtonElement>('another');failed.hidden=!handoff;get('manual').hidden=Boolean(handoff);
  name.value=memory.name;phone.value=memory.phone;address.value=memory.address;get('opening').hidden=true;get('shop').hidden=false;get('shop').classList.add(menu?'public-menu-shop':'public-list-shop');get('name').textContent=shop.name;get('summary').textContent=[shop.hours,shop.address].filter(Boolean).join(' · ');get('monogram').textContent=shop.name.trim().split(/\s+/).map(word=>Array.from(word)[0]).slice(0,2).join('').toUpperCase();get('contact').textContent=[shop.address,shop.phone].filter(Boolean).join(' · ');get<HTMLAnchorElement>('powered').href=import.meta.env.BASE_URL.replace(/app\/$/,'')+(shop.market==='BD'?'bd/':'intl/');document.title=shop.name+' — order on WhatsApp';
  for(const node of document.querySelectorAll<HTMLElement>('[data-icon]'))node.replaceChildren(icon(node.dataset.icon as Parameters<typeof icon>[0]));get('send-icon').append(icon(menu?'check':'send'));
  if(menu){document.getElementById('shop-order')!.prepend(get('fulfilment'));get('categories').hidden=false;get('menu').hidden=false;get('cart-items').hidden=false;get('subtotal').hidden=false;}
  get('delivery-note').textContent=shop.deliveryNote;get('delivery-note').hidden=!shop.deliveryNote;
  const speech=(window as unknown as {SpeechRecognition?:VoiceConstructor;webkitSpeechRecognition?:VoiceConstructor});const Voice=speech.SpeechRecognition||speech.webkitSpeechRecognition;voice.hidden=!Voice;
  const action=(label:string,value:string,key:string,kind='secondary')=>el('button',{type:'button',class:`button button-${kind}`,'data-action':key,'data-value':value},label);
  for(const value of __PUBLIC_PAYMENTS__[shop.market]||['Cash'])get('payments').append(action(value,value,'payment'));
  for(const value of ['',...new Set(shop.items.map(item=>item.category).filter(Boolean))])get('categories').append(action(value,value,'category'));
  function notify(value:string,bad=false){const node=get(bad?'error-message':'status');node.textContent=value;node.lang=/[\u0980-\u09ff]/.test(value)?'bn':'en';node.hidden=false;if(!bad)get('error-message').hidden=true;}
  function notice(value:string){notify(value+(handoff&&!handoff.durable?' '+w().unsaved:''));}
  function reviewDraft(value:PublicOrderDraft){pending=value;message.value=orderMessage(value);retry.href=`https://wa.me/${shop.phone.slice(1)}?text=${encodeURIComponent(message.value)}`;review.hidden=false;}
  function show(value:PublicAttempt){attempt=value;reviewDraft(value.draft);const done=publicAttemptProgress(value).sentAt!==undefined;sent.disabled=done;failed.disabled=done;another.hidden=!done;}
  function record(choice:HandoffChoice,value=attempt){if(handoff&&value){const state=handoff.choose(value,choice);if(value===attempt){sent.disabled=state.sentAt!==undefined;failed.disabled=sent.disabled;another.hidden=!sent.disabled;}}}
  function restore(value:PublicAttempt){const d=value.draft;name.value=d.name;phone.value=d.phone;address.value=d.address;fulfilment=d.fulfilment;payment=d.payment;text.value=value.form.text;quantities.clear();for(const [id,count] of value.form.quantities)quantities.set(id,count);time.value=value.form.customTime;chooseTime(value.form.when,false);pressed('[data-action=payment]',payment);pressed('[data-action=fulfilment]',fulfilment);get('address-row').hidden=fulfilment==='pickup';address.required=fulfilment==='delivery';translate();}
  function last(){const previous=memory.last;get<HTMLButtonElement>('last').disabled=!previous;get('last-hint').textContent=previous?new Intl.DateTimeFormat(language==='bn'?'bn-BD':'en',{day:'numeric',month:'short',timeZone:shop.timezone}).format(previous.at)+' · '+previous.draft.items.slice(0,3).join(', ').slice(0,90):w().noLast;get('greeting').textContent=memory.name?`${w().welcome}, ${memory.name}`:'';get('greeting').hidden=!memory.name;}
  function remember(completed?:CustomerMemory['last']){
    try{const previous=readMemory(shop,localStorage);memory={v:1,name:name.value.trim(),phone:normalisePublicPhone(phone.value,shop.market)||previous.phone,address:address.value,language,...(completed?{last:completed}:previous.last?{last:previous.last}:{})};localStorage.setItem(memoryKey(shop),JSON.stringify(memory));last();}catch{get('status').textContent='Details were not saved. You can still send or copy.';}
  }
  function translate(){
    document.documentElement.lang=language;
    for(const node of document.querySelectorAll<HTMLElement>('[data-copy]'))node.textContent=w()[node.dataset.copy as keyof typeof words.en];
    for(const node of document.querySelectorAll<HTMLInputElement>('[data-label]'))node.setAttribute('aria-label',w()[node.dataset.label as keyof typeof words.en]);
    for(const node of document.querySelectorAll<HTMLInputElement>('[data-placeholder]'))node.placeholder=w()[node.dataset.placeholder as keyof typeof words.en];
    get('list-label').textContent=menu?w().notes:w().need;get('entry-help').textContent=menu?w().noteHelp:w().write;if(menu)text.placeholder=w().noteHelp;pressed('[data-action=language]',language);voice.setAttribute('aria-label',recording?w().stop:w().voice);last();renderMenu();
    const quick=get('quick-items');quick.replaceChildren();if(!menu)for(const item of shop.items.filter(item=>item.available&&item.oftenBought))quick.append(action(`+ ${item.name} ${formatMoney(item.price,shop.currency)}`,item.id,'quick'));get('suggestions').hidden=menu||!quick.children.length;
    if(get('offline').dataset.ready) get('offline').textContent=w().offline;else get('offline').textContent=w().preparing;
  }
  function money(item:PublicShopItem,count:number){const amount=BigInt(item.price)*BigInt(count);return amount<=BigInt(Number.MAX_SAFE_INTEGER)?formatMoney(Number(amount),shop.currency):w().price;}
  function renderMenu(){
    if(!menu)return;const focus=document.activeElement?.id;pressed('[data-action=category]',category);controls('[data-action=category]').find(node=>node.dataset.value==='')!.textContent=w().all;
    const items=shop.items.filter(item=>(!category||item.category===category)&&(!query||[item.name,item.nameLocal,item.category].some(value=>value.normalize('NFKC').toLowerCase().includes(query))));
    grid.replaceChildren(...items.map(item=>{
      const count=quantities.get(item.id)||0,add=action('',item.id,'add');add.id='quantity-add-'+item.id;add.setAttribute('aria-label','Add '+item.name);add.append(quantityIcon(count?'plusLight':'plusDark'));add.disabled=count>=99;
      const minus=action('',item.id,'minus','ghost');minus.id='quantity-minus-'+item.id;minus.setAttribute('aria-label','Remove one '+item.name);minus.append(quantityIcon('minus'));
      return el('article',{class:`card public-menu-item${item.available?'':' public-item-unavailable'}`},el('div',{class:'public-item-image','aria-hidden':'true'}),el('div',{class:'public-item-copy'},el('h3',{},item.name),item.nameLocal?el('p',{class:'public-local-name',...(shop.market==='BD'?{lang:'bn'}:{})},item.nameLocal):null,el('p',{class:'public-item-unit'},item.unit)),el('footer',{},el('span',{class:'public-item-price'},formatMoney(item.price,shop.currency)),!item.available?el('span',{class:'public-caption'},w().unavailable):count?el('div',{class:'public-quantity'},minus,el('span',{'aria-live':'polite'},String(count)),add):add));
    }));if(!items.length)grid.append(el('p',{class:'public-caption'},'No matching items. Type your request below.'));
    const selected=shop.items.filter(item=>(quantities.get(item.id)||0)>0),rows=get('cart-items');rows.replaceChildren(...selected.map(item=>el('div',{},el('span',{},`${quantities.get(item.id)} × ${item.name}`),el('span',{},money(item,quantities.get(item.id)!)))));if(!selected.length)rows.append(el('p',{class:'public-caption'},w().empty));const sum=selected.reduce((sum,item)=>sum+BigInt(item.price)*BigInt(quantities.get(item.id)!),0n);get('total').textContent=sum<=BigInt(Number.MAX_SAFE_INTEGER)?formatMoney(Number(sum),shop.currency):w().price;
    if(focus?.startsWith('quantity-'))document.getElementById(focus)?.focus();
  }
  function prepare(fresh=false){
    if(photoLoading)throw new Error('Wait for the photo preview, or type your list.');const who=name.value.trim(),number=normalisePublicPhone(phone.value,shop.market);if(!who){name.focus();throw new Error('Write your name.');}if(!number){phone.focus();throw new Error('Enter a valid phone number. Use a country code outside the shop’s market.');}if(fulfilment==='delivery'&&!address.value.trim()){address.focus();throw new Error('Write the delivery address, or choose Pickup.');}
    const items=[...shop.items.filter(item=>(quantities.get(item.id)||0)>0).map(item=>`${quantities.get(item.id)} × ${item.name}`),...(text.value.trim()?text.value.trim().split(/\r?\n/):[])];if(!items.length&&photo)items.push(w().photoOnly);
    const current:PublicOrderDraft={shopCode:shop.code,shopName:shop.name,name:who,phone:number,fulfilment,address:fulfilment==='pickup'?'':address.value.trim(),when:when===3?time.value.trim():[w().now,w().hour,w().tomorrow][when],items,payment,photo:Boolean(photo),language};sent.disabled=false;if(handoff)show(handoff.prepare(current,{text:text.value,quantities:[...quantities].filter(([,n])=>n>0),when,customTime:time.value},fresh));else reviewDraft(current);dirty=false;remember();return retry.href;
  }
  function reviewed(){return !handoff||!attempt||dirty?prepare():retry.href;}
  async function copy(){let captured:PublicAttempt|undefined;try{reviewed();captured=attempt;const value=message.value;let copied=true;try{await navigator.clipboard.writeText(value);}catch{copied=false;}if(handoff&&captured)record({type:copied?'copy':'copy-failed'},captured);if(captured!==attempt)return;if(!copied)select();notice(copied?'Message copied. Paste it into the shop’s chat.':'Message selected. Copy it with your browser.');}catch(error){if(captured&&captured!==attempt)return;if(attempt)select();notify(error instanceof Error?error.message:'Review the request.',true);}}
  function select(){review.open=true;message.focus();message.select();}
  function chooseTime(value:number,focus=true){when=value;pressed('[data-action=time]',String(when));timeSelect.value=String(when);time.hidden=when!==3;if(when===3&&focus)time.focus();}
  root.addEventListener('click',event=>{
    const node=(event.target as Element).closest<HTMLElement>('[data-action]');if(!node||node.matches(':disabled'))return;const value=node.dataset.value||'',item=shop.items.find(item=>item.id===value);
    if(['language','last','quick','add','minus','payment','fulfilment','time','remove'].includes(node.dataset.action||''))dirty=true;
    try{switch(node.dataset.action){
      case 'send':send.href=reviewed();record({type:'open',channel:'whatsapp'});notice(pending?.photo?w().attach:'Continue in WhatsApp. Choose “I sent it” after sending.');break;
      case 'retry':record({type:'open',channel:'whatsapp'});notice(pending?.photo?w().attach:'Continue in WhatsApp. Choose “I sent it” after sending.');break;
      case 'copy':void copy();break;
      case 'failed':record({type:'failed'});select();notice('Message selected. Copy it with your browser.');break;
      case 'another':if(handoff&&attempt){if(dirty)prepare(true);else{const fresh=handoff.prepare(attempt.draft,attempt.form,true);restore(fresh);show(fresh);}notice('New attempt. Review before sending.');}break;
      case 'select':select();break;
      case 'sent':if(pending){record({type:'sent'});remember({draft:pending,at:Date.now()});sent.disabled=true;notice('Marked as sent on this device. The shop will confirm your request.');}break;
      case 'language':language=value as PublicLanguage;remember();{const url=new URL(location.href);url.searchParams.set('lang',language);history.replaceState(null,'',url.href);}translate();break;
      case 'photo':file.click();break;
      case 'remove':photo=null;file.value='';get('photo').hidden=true;get('photo').replaceChildren();break;
      case 'last':if(memory.last){text.value=[text.value.trim(),memory.last.draft.items.join('\n')].filter(Boolean).join('\n');notify(memory.last.draft.photo&&!photo?'Last request added. Add the photo again if needed.':'Last request added. Review before sending.');text.focus();}break;
      case 'quick':if(item){const next=[text.value.trim(),`1 × ${item.name}`].filter(Boolean).join('\n');if(next.length>4000)throw new Error('Keep the request within 4,000 characters.');text.value=next;text.focus();}break;
      case 'category':category=value;renderMenu();break;
      case 'add':case 'minus':if(item?.available){const count=(quantities.get(value)||0)+(node.dataset.action==='add'?1:-1);if(count>=0&&count<=99){quantities.set(value,count);renderMenu();}}break;
      case 'payment':payment=value;pressed('[data-action=payment]',value);break;
      case 'fulfilment':fulfilment=value as typeof fulfilment;pressed('[data-action=fulfilment]',value);get('address-row').hidden=value==='pickup';address.required=value==='delivery';break;
      case 'time':chooseTime(Number(value));break;
      case 'forget':{clearTimeout(timer);let cleared=true;try{localStorage.removeItem(memoryKey(shop));}catch{cleared=false;}if(handoff)cleared=handoff.forget()&&cleared;attempt=undefined;pending=null;review.hidden=true;sent.disabled=true;failed.disabled=true;another.hidden=true;memory=emptyMemory();name.value='';phone.value='';address.value='';last();notify(cleared?'Remembered details and the last request were cleared from this device.':'Saved details could not be removed. Reopen this page and try Forget again.',!cleared);break;}
      case 'voice':startVoice();break;
    }}catch(error){event.preventDefault();notify(error instanceof Error?error.message:'Review the request.',true);}
  });
  root.addEventListener('input',event=>{if(event.target===get('search')){query=(event.target as HTMLInputElement).value.normalize('NFKC').toLowerCase().trim();renderMenu();}else dirty=true;if([name,phone,address].includes(event.target as HTMLInputElement)){clearTimeout(timer);timer=setTimeout(()=>remember(),200);}});
  timeSelect.onchange=()=>{dirty=true;chooseTime(Number(timeSelect.value));};document.getElementById('shop-order')!.onsubmit=event=>event.preventDefault();
  file.onchange=()=>{
    const image=file.files?.[0];if(!image)return;if(!['image/jpeg','image/png','image/webp'].includes(image.type)||image.size>5000000){notify('Choose a JPEG, PNG or WebP photo smaller than 5 MB.',true);file.value='';return;}photoLoading=true;dirty=true;
    const reader=new FileReader();const failed=()=>{photoLoading=false;notify('The photo could not be previewed. Choose another, or type your list.',true);file.value='';};reader.onerror=failed;reader.onload=()=>{const url=String(reader.result),preview=el('img',{src:url,alt:'Selected photo preview',class:'public-photo-preview'});preview.onerror=failed;preview.onload=()=>{photoLoading=false;photo=url;const remove=action('','','remove','ghost');remove.setAttribute('aria-label',w().remove);remove.append(icon('close'));get('photo').replaceChildren(preview,el('span',{},image.name),remove);get('photo').hidden=false;notify(w().attach);};};reader.readAsDataURL(image);
  };
  function startVoice(){
    if(recording){recognition?.stop();return;}if(!Voice)return;
    try{recognition=new Voice();recognition.lang=language==='bn'?'bn-BD':'en-US';recognition.interimResults=false;recognition.continuous=false;recognition.onresult=event=>{const next=[text.value.trim(),event.results[0]?.[0]?.transcript.trim()].filter(Boolean).join('\n');if(next.length>4000){notify('Keep the request within 4,000 characters.',true);return;}text.value=next;dirty=true;notify('Voice added. Review the words before sending.');};recognition.onerror=()=>{notify('Voice is unavailable. Type your list instead.',true);text.focus();};recognition.onend=()=>{recording=false;voice.setAttribute('aria-pressed','false');voice.setAttribute('aria-label',w().voice);};recognition.start();recording=true;voice.setAttribute('aria-pressed','true');voice.setAttribute('aria-label',w().stop);}catch{notify('Voice is unavailable. Type your list instead.',true);text.focus();}
  }
  pressed('[data-action=payment]',payment);pressed('[data-action=fulfilment]',fulfilment);address.required=true;chooseTime(0);translate();
  if(handoff?.current){const saved=handoff.current,state=publicAttemptProgress(saved);if(state.sentAt===undefined){if(requested!=='en'&&requested!=='bn')language=saved.draft.language;restore(saved);dirty=language!==saved.draft.language;}show(saved);review.open=true;notice(state.sentAt!==undefined?'Marked as sent on this device. The shop will confirm your request.':state.status==='copied'?'Message copied. Mark sent after you finish.':state.status==='failed'?'Not confirmed. Copy or open WhatsApp again.':'Saved request. Review before sending.');if(saved.draft.photo)notice(get('status').textContent+' '+w().attach);}
  window.addEventListener('pagehide',()=>{clearTimeout(timer);recognition?.stop();});
  if('serviceWorker' in navigator)void navigator.serviceWorker.register(new URL('sw.js',location.href),{scope:new URL('./',location.href).pathname}).then(async registration=>{
    const worker=registration.installing||registration.waiting||registration.active;if(worker&&worker.state!=='activated')await new Promise<void>((resolve,reject)=>worker.addEventListener('statechange',()=>{if(worker.state==='activated')resolve();else if(worker.state==='redundant')reject(new Error('Offline setup failed.'));}));if(!navigator.serviceWorker.controller?.scriptURL.includes('/s/sw.js'))await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));get('offline').dataset.ready='true';get('offline').textContent=w().offline;
  }).catch(()=>{get('offline').textContent='Reconnect and reload to prepare offline access.';});else get('offline').textContent='Keep this page open if your browser cannot save it offline.';
}
