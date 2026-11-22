import {useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import {sameKitchenSession,type KitchenScreenState,type KitchenTap} from '@mise/core/kitchen-screen';
import type {KitchenTicket} from '@mise/core/kitchen-tickets';

function savedTime(tap:KitchenTap){
  try{return new Intl.DateTimeFormat('en-GB',{timeZone:tap.source.timezone,dateStyle:'medium',timeStyle:'short'}).format(tap.action.occurredAt);}
  catch{return new Date(tap.action.occurredAt).toISOString();}
}
export function KitchenTapReview({state,now,online,busy,onCheck,onClose,onCopy}:{state:KitchenScreenState;now:number;online:boolean;busy:boolean;
  onCheck:(tap:KitchenTap)=>void;onClose:(tap:KitchenTap)=>void;onCopy:(ticket:KitchenTicket)=>void}){
  const [expanded,setExpanded]=useState(false),[limit,setLimit]=useState(20);
  if(!state.taps.length)return null;
  const pending=state.taps.filter(tap=>!tap.receipt&&!tap.closure),finished=state.taps.filter(tap=>tap.receipt||tap.closure),rows=[...pending,...finished].slice(0,limit);
  return <section className="kitchen-saved-taps" aria-label="Saved preparation taps">
    <Button kind="ghost" aria-expanded={expanded} aria-controls="kitchen-tap-review" onClick={()=>setExpanded(value=>!value)}>Saved taps · {state.taps.length}</Button>
    <div id="kitchen-tap-review" hidden={!expanded}>{expanded?<>
      <h2>Saved taps</h2><p>Check the original confirmation before recording a new tap on the current ticket.</p>
      <ul className="kitchen-review-list">{rows.map(tap=>{
        const kind=tap.action.type==='kitchen.acknowledge'?'Got it':'Ready',current=state.tickets.find(ticket=>ticket.id===tap.action.orderId);
        const allowed=now<state.access.expiresAt&&state.access.permissions.includes(tap.action.type==='kitchen.acknowledge'?'orders.acknowledge':'orders.ready');
        return <li key={tap.action.id} className="kitchen-review-item">
          <h3>{tap.source.number} · {kind}</h3><p>{sameKitchenSession(tap.access,state.access)?'This PIN session':'Earlier PIN session'} · {savedTime(tap)}</p>
          <p>{tap.receipt?`${kind} was accepted. The original confirmation is saved.`:tap.closure?'Closed after review. The original ticket is kept.':tap.closeIntents?.length?'Close request saved on this screen · waiting for confirmation.':'Confirmation is still needed. The original tap is kept.'}</p>
          {current&&current.contentHash!==tap.action.contentHash?<p>The ticket has changed. Review the current ticket before recording a new tap.</p>:null}
          <details><summary>Original ticket</summary><p>{tap.source.type.replaceAll('_',' ')}{tap.source.table?' · Table '+tap.source.table:''}</p>
            <ul>{tap.source.lines.map(line=><li key={line.id}><strong>{line.qty}× {line.name}</strong>{line.unit?' · '+line.unit:''}{line.note?<p>{line.note}</p>:null}{line.unavailable?<p>Unavailable</p>:null}{line.substitution?<p>Swap from {line.substitution.from} · {line.substitution.accepted?'Accepted':'Awaiting customer acceptance'}</p>:null}</li>)}</ul>
          </details>
          <div className="kitchen-review-actions"><Button kind="ghost" onClick={()=>onCopy(tap.source)}>Copy original ticket</Button>
            {!tap.receipt&&!tap.closure?<><Button kind="ghost" disabled={busy||!online} onClick={()=>onCheck(tap)}>Check confirmation</Button><Button kind="secondary" disabled={busy||!allowed} onClick={()=>onClose(tap)}>Close saved tap</Button></>:null}
          </div>
        </li>;
      })}</ul>
      {limit<state.taps.length?<Button kind="ghost" onClick={()=>setLimit(value=>value+20)}>Show more saved taps</Button>:null}
    </>:null}</div>
  </section>;
}
