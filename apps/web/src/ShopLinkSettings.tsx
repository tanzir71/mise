import { useRef,useState,type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button,Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { formatMoney } from '@mise/core/money';
import type { AuditEvent,SetupSnapshot } from '@mise/core/models';
import { decodeShopPayload } from '@mise/core/public-shop-codec';
import { PUBLIC_SHOP_MAX_ITEMS,type PublicShop } from '@mise/core/public-shop';
import { reviewShopLink,type ShopLinkContext,type ShopLinkInput } from '@mise/core/shop-links';
import { db } from './data/db';
import './shop-link-settings.css';

function savedShop(link?:string):PublicShop|null {
  try {const url=new URL(link||'');return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname.endsWith('/app/s/')?decodeShopPayload(url.hash.slice(1)):null;}
  catch {return null;}
}
export function ShopLinkSettings({setup}:{setup:SetupSnapshot}){
  const records=useLiveQuery(()=>db.transaction('r',[db.businesses,db.outlets,db.members,db.items,db.categories,db.events],async()=>{
    const [current,items,categories]=await Promise.all([db.setup(),db.items.where('outletId').equals(setup.outlet.id).toArray(),db.categories.where('outletId').equals(setup.outlet.id).toArray()]);
    if(!current||current.outlet.id!==setup.outlet.id)return null;
    const event=await db.events.where('command').equals('shopLink.generate').filter(event=>event.outletId===current.outlet.id&&(event.after as {url?:unknown}|undefined)?.url===current.outlet.shopLink).first();
    return {context:{setup:current,items,categories},event};
  }),[setup.outlet.id]);
  if(records===undefined)return <p aria-busy="true">Opening shop link…</p>;
  if(!records)return <p role="alert">Your shop changed. Reopen Shop link from More.</p>;
  return <ShopLinkForm key={records.context.setup.outlet.id} context={records.context} event={records.event}/>;
}
function ShopLinkForm({context,event}:{context:ShopLinkContext;event?:AuditEvent}){
  const published=savedShop(context.setup.outlet.shopLink),url=published?context.setup.outlet.shopLink!:'',urlField=useRef<HTMLTextAreaElement>(null),busy=useRef(false);
  const [input,setInput]=useState<ShopLinkInput>(()=>({phone:published?.phone||context.setup.owner.phone,hours:published?.hours||'',deliveryNote:published?.deliveryNote||'',mode:published?.mode||'list',itemIds:published?.items.map(item=>item.id)||[]}));
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  function field<K extends keyof ShopLinkInput>(key:K,value:ShopLinkInput[K]){setInput(current=>({...current,[key]:value}));setMessage('');}
  function choose(id:string,checked:boolean){setInput(current=>({...current,itemIds:checked?[...new Set([...current.itemIds,id])]:current.itemIds.filter(value=>value!==id)}));setMessage('');}
  async function write(action:()=>Promise<unknown>,done:string){
    if(busy.current)return;busy.current=true;setSaving(true);setError('');setMessage('');
    try{await action();setMessage(done);}catch(error){setError(error instanceof Error?error.message:'The link could not be saved. Try again.');}
    finally{busy.current=false;setSaving(false);}
  }
  function generate(event:FormEvent){event.preventDefault();void write(()=>db.generateShopLink(input,reviewShopLink(context,input.itemIds),new URL(import.meta.env.BASE_URL,location.origin).href),'Shop link generated. Preview it before sharing.');}
  async function copy(){
    setError('');setMessage('');
    try{await navigator.clipboard.writeText(url);setMessage('Shop link copied.');}
    catch{urlField.current?.focus();urlField.current?.select();setMessage('Link selected. Use your browser’s Copy action, then paste it into the app you use.');}
  }
  async function share(){
    setError('');setMessage('');
    if(typeof navigator.share!=='function'){await copy();return;}
    try{await navigator.share({title:published!.name,text:`Order from ${published!.name}`,url});setMessage('Share sheet closed. Check the app you chose to confirm it was sent.');}
    catch(error){if(error instanceof Error&&error.name==='AbortError')setMessage('Sharing cancelled. You can copy the link whenever you’re ready.');else setError('Sharing did not open. Use Copy link below.');}
  }
  const removed=input.itemIds.filter(id=>!context.items.some(item=>item.id===id));
  const actionLabel=saving?'Saving…':url?'Regenerate after menu changes':'Generate shop link';
  return <div className="shop-link-settings"><header className="app-page-heading shop-link-page-heading"><div><h1>Settings › Shop link</h1><p>Your own ordering page. Customers send their request to your WhatsApp number.</p></div><div className="shop-link-actions">{url?<a className="button button-secondary" href={url} target="_blank" rel="noopener noreferrer"><MiseIcon name="eye" size={16}/>Preview</a>:null}<Button type="submit" form="shop-link-settings-form" disabled={saving||removed.length>0}><MiseIcon name="check" size={16}/>{actionLabel}</Button></div></header><div className="shop-link-grid"><form id="shop-link-settings-form" className="shop-link-form" onSubmit={generate}>
    <Card className="app-panel shop-link-result"><header><h2>Link &amp; sharing</h2><p>Put it anywhere customers already find you.</p></header>{published?<><div className="shop-link-result-details"><label>Published shop link<textarea ref={urlField} readOnly rows={3} value={url} onFocus={event=>event.target.select()}/></label><div className="shop-link-actions"><Button type="button" kind="secondary" onClick={()=>void copy()}><MiseIcon name="clipboard" size={16}/>Copy link</Button><Button type="button" kind="secondary" onClick={()=>void share()}><MiseIcon name="share" size={16}/>Share link</Button><Button type="button" kind="ghost" disabled={saving||!event} onClick={()=>{if(event)void write(()=>db.undoShopLink(event.id),'The previous link was restored. Copies already shared still work.');}}>Undo link change</Button></div><p>Generated {new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short',timeZone:published.timezone}).format(published.publishedAt)} · {published.items.length} public {published.items.length===1?'item':'items'}.</p></div></>:<p className="shop-link-result-details">Choose the public details and items, then generate your link.</p>}<div className="shop-link-result-details form-fields"><p>Customers see {context.setup.outlet.name} and its address from Business settings.</p><label>Public WhatsApp phone<input type="tel" autoComplete="tel" value={input.phone} maxLength={40} required onChange={event=>field('phone',event.target.value)}/></label></div></Card>
    <Card className="app-panel shop-link-selection"><header><h2>What’s for sale</h2><p>Choose up to {PUBLIC_SHOP_MAX_ITEMS} public items. Prices and availability are copied into the link.</p></header><div className="form-fields shop-link-selection-details"><label>Customer page style<select value={input.mode} onChange={event=>field('mode',event.target.value as ShopLinkInput['mode'])}><option value="list">Type what you need</option><option value="menu">Choose from a menu</option></select></label><p className="shop-link-count" aria-live="polite">{input.itemIds.length} of {PUBLIC_SHOP_MAX_ITEMS} selected</p><fieldset disabled={saving}><legend className="sr-only">Public catalogue items</legend>{context.items.map(item=><label key={item.id}><input type="checkbox" checked={input.itemIds.includes(item.id)} disabled={!input.itemIds.includes(item.id)&&input.itemIds.length>=PUBLIC_SHOP_MAX_ITEMS} onChange={event=>choose(item.id,event.target.checked)}/><span>{item.name}{item.nameLocal?<small lang={context.setup.business.marketCode==='BD'?'bn':undefined}>{item.nameLocal}</small>:null}<small>{formatMoney(item.price,context.setup.outlet.currency)} / {item.unit}{!item.available?' · Unavailable':''}</small></span></label>)}{removed.map(id=><label key={id}><input type="checkbox" checked onChange={()=>choose(id,false)}/><span>Removed item<small>Uncheck this selection before generating.</small></span></label>)}</fieldset>{!context.items.length?<p>Add items in Business data if you want a menu or suggested items.</p>:null}{input.itemIds.length?<Button type="button" kind="ghost" disabled={saving} onClick={()=>field('itemIds',[])}>Clear selection</Button>:null}</div></Card>
    <Card className="app-panel shop-link-hours"><header><h2>Hours &amp; delivery</h2><p>Tell customers when you’re open and how to collect their order.</p></header><div className="form-fields shop-link-hours-details"><label>Opening hours<textarea value={input.hours} maxLength={200} rows={2} placeholder="For example, 9 am–11 pm" onChange={event=>field('hours',event.target.value)}/></label><label>Delivery note<textarea value={input.deliveryNote} maxLength={400} rows={3} placeholder="Delivery area, charges or collection instructions" onChange={event=>field('deliveryNote',event.target.value)}/></label></div><footer><p>Regenerate after menu, price, availability or shop-detail changes. Existing copies keep their previous information.</p></footer></Card>
  </form><aside className="shop-link-preview"><p className="shop-link-preview-label">{published?'PUBLISHED PREVIEW':'CUSTOMER PREVIEW'}</p><Card className="app-panel shop-link-preview-card">{published?<><header><span className="shop-link-monogram" aria-hidden="true">{published.name.split(/\s+/).map(word=>word[0]).slice(0,2).join('').toUpperCase()}</span><h2>{published.name}</h2>{published.hours?<p>{published.hours}</p>:null}{published.address?<p>{published.address}</p>:null}</header>{published.items.slice(0,3).map(item=><div className="shop-link-preview-item" key={item.id}><span className="shop-link-item-placeholder" aria-hidden="true"/><span>{item.name}<small>{item.available?item.unit:'Unavailable'}</small></span><span>{formatMoney(item.price,published.currency)}</span></div>)}{!published.items.length?<p className="shop-link-preview-empty">Type what you need, or add a photo of your list.</p>:null}<footer><a className="button button-primary" href={url} target="_blank" rel="noopener noreferrer">Open customer page</a></footer></>:<p className="shop-link-preview-empty">Generate your link to see the published customer details here.</p>}</Card><Card className="app-panel shop-link-sharing-note"><h2>Share a request, confirm together</h2><p>Customers send a request on WhatsApp. Confirm prices, availability, delivery and payment with them in the conversation.</p><p>Only the listed public details and selected items are included. Customers, sales, khata, stock and team records stay on this device.</p><p>Undo is available for ten minutes. It cannot recall a link that has already been shared.</p></Card></aside></div>{error?<p className="form-error" role="alert">{error}</p>:null}{message?<p role="status">{message}</p>:null}</div>;
}
