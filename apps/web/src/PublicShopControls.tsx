import {useEffect,useRef,useState} from 'react';
import {Button,Card} from '@mise/ui/primitives.tsx';
import type {SetupSnapshot} from '@mise/core/models';
import type {PublicShopMetadata,PublicShopSource} from '@mise/core/public-shop-admin';
import {usePublicShopOwner} from './use-public-shop-owner';
import './public-shop-controls.css';
export function PublicShopControls({setup,sourceUrl}:{setup:SetupSnapshot;sourceUrl:string}){
 const [online,setOnline]=useState(navigator.onLine),owner=usePublicShopOwner(setup,online),ready=owner.ready,holder=useRef(ready);holder.current=ready;
 const [table,setTable]=useState(''),[expiry,setExpiry]=useState('never'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[rows,setRows]=useState<PublicShopMetadata[]>([]),[next,setNext]=useState<string|null>(null),[revision,setRevision]=useState(0),
  [share,setShare]=useState<{source:PublicShopSource;url:string;ticket:string}|null>(null),field=useRef<HTMLTextAreaElement>(null),running=useRef(false);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 useEffect(()=>{running.current=false;setBusy(false);setShare(null);setRows(ready?.page.links??[]);setNext(ready?.page.nextId??null);setMessage('');setError('');},[ready?.ticket]);
 const candidate=ready&&share?.ticket===ready.ticket&&share.source.sourceUrl===sourceUrl?share:null;
 let saved:ReturnType<NonNullable<typeof ready>['session']['saved']>|undefined,journalError=false;try{saved=ready?.session.saved();}catch{journalError=true;}
 const pending=saved?.publications.filter(p=>p.metadata===null)??[],withdrawals=saved?.revocations.filter(p=>p.metadata===null)??[];
 const selected=journalError?null:candidate;
 void revision;
 async function work(run:(current:NonNullable<typeof ready>)=>Promise<void>,reload=true){
  if(!ready||running.current||journalError)return;const current=ready;running.current=true;setBusy(true);setError('');setMessage('');
  try{await run(current);if(reload&&holder.current===current&&current.active()){const page=await current.session.page(null,50,current.signal);if(holder.current===current&&current.active()){setRows(page.links);setNext(page.nextId);setRevision(v=>v+1);}}}
  catch(e){if(holder.current===current&&current.active()){setShare(null);setRevision(v=>v+1);setError(e instanceof Error?e.message:'Keep the original publication and check it again.');}}
  finally{if(holder.current===current&&current.active()){running.current=false;setBusy(false);}}
 }
 async function publish(id?:string){return work(async current=>{
  const result=id?await current.session.resume(id,current.signal):await current.session.begin({sourceUrl,table:table.trim()||null,expiresAt:expiry==='7d'?Date.now()+604800000:null},current.signal);
  if(holder.current!==current||!current.active())return;
  if(result.metadata.revokedAt!==null){setShare(null);setMessage('This publication is disabled. Its original link is not reactivated.');}
  else if(result.source.sourceUrl!==sourceUrl){setShare(null);setMessage('The previous publication was checked. Enable a new link for the current shop snapshot.');}
  else{setShare({source:result.source,url:current.session.url(result.source),ticket:current.ticket});setMessage('Online ordering link confirmed. Preview it before sharing.');}
 });}
 async function revoke(id:string){setShare(null);return work(async current=>{await current.session.revoke(id,current.signal);if(holder.current===current&&current.active())setMessage('This ordering link is disabled. Existing orders and their trackers are retained.');});}
 async function copy(){if(!ready||!selected)return;let url:string;try{url=ready.session.url(selected.source);}catch{setShare(null);setError('Refresh access and check this original publication before sharing.');return;}try{await navigator.clipboard.writeText(url);if(holder.current===ready&&ready.active())setMessage('Ordering link copied.');}catch{field.current?.focus();field.current?.select();setMessage('Link selected. Use your browser’s Copy action.');}}
 const date=(at:number)=>new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short',timeZone:setup.outlet.timezone}).format(at);
 return <Card className="app-panel public-shop-controls" aria-label="Online ordering"><header><h2>Online ordering</h2><p>Customers can place an order on your page. Keep your published menu current; the message option remains available.</p></header>
  <div className="public-shop-controls-body"><p>Use this installation’s connection and verified owner or assigned-manager account. <a href={import.meta.env.BASE_URL+'settings/sync?flags=cloudSetup,publicOrders'}>Sync setup</a></p><p>This preview also requires online ordering to be configured on your installation’s backend. Publishing a link does not enable the service. <a href={import.meta.env.BASE_URL.replace(/app\/$/,'')+'docs/configure-services.md'}>Setup guide</a></p>
   {!online?<p role="status">Connect to check or disable an ordering link. Your existing message link is still available above.</p>:null}
   {owner.error?<p role="alert">{owner.error}</p>:null}{journalError?<p role="alert">Saved publication details need review. Keep this browser’s data and use your message link above.</p>:null}{owner.checking?<p aria-busy="true">Checking access…</p>:null}
   <Button kind="secondary" disabled={owner.checking||busy||!online} onClick={owner.refresh}>Refresh access</Button>
   {ready?<><form className="public-shop-publish-form" onSubmit={event=>{event.preventDefault();void publish();}}><label>Table label (optional)<input value={table} onChange={event=>setTable(event.target.value)} maxLength={40} disabled={busy} placeholder="For example, Table 4"/></label><label>Link duration<select value={expiry} onChange={event=>setExpiry(event.target.value)} disabled={busy}><option value="never">Until disabled</option><option value="7d">7 days</option></select></label><Button type="submit" disabled={busy||!sourceUrl||pending.length>0||withdrawals.length>0}>{busy?'Checking…':'Publish ordering link'}</Button></form>
    {!sourceUrl?<p>Generate and sync the shop link above before enabling online ordering.</p>:null}
    {selected?<div className="public-shop-shared-link"><label>Confirmed ordering link<textarea ref={field} readOnly rows={3} value={selected.url} onFocus={event=>event.target.select()}/></label><div className="shop-link-actions"><Button kind="secondary" onClick={()=>void copy()}>Copy ordering link</Button><a className="button button-secondary" href={selected.url} target="_blank" rel="noopener noreferrer">Preview ordering page</a></div><p>Only the shop’s public details and ordering capability are included. There is no API key or owner session in this link.</p></div>:null}
    {pending.map(p=><div key={p.source.id} className="public-shop-publication"><p>{p.source.table||'General ordering link'} · publication unconfirmed</p><div className="shop-link-actions"><Button kind="secondary" disabled={busy} onClick={()=>void publish(p.source.id)}>Check original publication</Button><Button kind="secondary" disabled={busy} onClick={()=>void revoke(p.source.id)}>Disable original publication</Button></div></div>)}
    {withdrawals.map(p=><div key={p.eventId} className="public-shop-publication"><p>Disabling this link is unconfirmed. Its original action is saved.</p><Button kind="secondary" disabled={busy} onClick={()=>void revoke(p.id)}>Retry disable</Button></div>)}
    <section aria-label="Published ordering links"><h3>Published ordering links</h3>{!rows.length?<p>No ordering links have been published for this outlet.</p>:rows.map(row=><div key={row.id} className="public-shop-publication"><div><strong>{row.table||'General ordering link'}</strong><p>{row.createdAt===null?'Closed before publication':`Published ${date(row.createdAt)}`}{row.revokedAt!==null?' · Disabled':row.expiresAt!==null?` · Expires ${date(row.expiresAt)}`:' · Until disabled'}</p></div><div className="shop-link-actions">{row.revokedAt===null&&saved?.publications.some(p=>p.source.id===row.id)&&!saved.revocations.some(p=>p.id===row.id)?<Button kind="secondary" disabled={busy} onClick={()=>void publish(row.id)}>Check and share</Button>:null}{row.revokedAt===null?<Button kind="secondary" disabled={busy} onClick={()=>void revoke(row.id)}>Disable link</Button>:null}</div></div>)}{next?<Button kind="secondary" disabled={busy} onClick={()=>void work(async current=>{const page=await current.session.page(next,50,current.signal);if(holder.current===current&&current.active()){setRows(old=>[...old,...page.links]);setNext(page.nextId);}},false)}>Load more links</Button>:null}</section>
   </>:null}{error?<p role="alert">{error}</p>:null}{message?<p role="status">{message}</p>:null}
  </div></Card>;
}
