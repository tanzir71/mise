import {useMemo,useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import {formatMoney} from '@mise/core/money';
import type {ClosingCommand} from '@mise/core/closing-commands';
import type {ClosingReviewSource} from '@mise/core/closing-review-source';
import type {DayClosing} from '@mise/core/models';

export const closingActionName=(command:ClosingCommand)=>command.type==='closing.record'?'Saved cash count':'Saved closing undo';
/** Display invisible code units literally; the complete original is copied. */
const displayText=(value:string)=>value.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu,char=>JSON.stringify(char).slice(1,-1));
function Literal({value}:{value:string}){
 const [expanded,setExpanded]=useState(false);
 if(value.length<=250)return <>{value?displayText(value):'None'}</>;
 return <details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Full saved text ({value.length.toLocaleString('en')} characters)</summary>{expanded?<pre className="order-review-source">{displayText(value)}</pre>:null}</details>;
}
export function ClosingTotals({summary}:{summary:DayClosing['summary']}){
 const money=(amount:number)=>formatMoney(amount,summary.currency);
 return <dl className="closing-review-fields">
  <div><dt>Day</dt><dd>{summary.day} · {summary.timezone}</dd></div>
  <div><dt>Recorded cash</dt><dd className="money">{money(summary.expectedCash)}</dd></div>
  <div><dt>Sales</dt><dd className="money">{money(summary.sales)}</dd></div>
  <div><dt>Cash receipts</dt><dd className="money">{money(summary.cashSales)}</dd></div>
  <div><dt>Cash khata collections</dt><dd className="money">{money(summary.cashCollections)}</dd></div>
  <div><dt>Cash refunds</dt><dd className="money">{money(summary.cashRefunds)}</dd></div>
 </dl>;
}
export function ClosingFacts({closing}:{closing:Omit<DayClosing,'updatedAt'>}){
 const money=(amount:number)=>formatMoney(amount,closing.currency);
 return <>
  <dl className="closing-review-fields">
   <div><dt>Counted day</dt><dd>{closing.day} · {closing.timezone}</dd></div>
   <div><dt>Currency</dt><dd>{closing.currency}</dd></div>
   <div><dt>Counted cash</dt><dd className="money">{money(closing.countedCash)}</dd></div>
   <div><dt>Recorded before closing</dt><dd className="money">{money(closing.expectedCash)}</dd></div>
   <div><dt>Difference</dt><dd className="money">{money(closing.difference)}</dd></div>
   <div><dt>Added as walk-in sales</dt><dd className="money">{money(closing.addedWalkIn)}</dd></div>
   <div><dt>Closing</dt><dd>{closing.voidedAt===undefined?'Saved':'Undone'}</dd></div>
   <div><dt>Recorded by</dt><dd><Literal value={closing.createdByName}/></dd></div>
   <div><dt>Count time</dt><dd>{new Date(closing.createdAt).toLocaleString('en-GB',{timeZone:closing.timezone})}</dd></div>
   <div><dt>Note</dt><dd><Literal value={closing.note}/></dd></div>
  </dl>
  <details><summary>Saved day totals</summary><ClosingTotals summary={closing.summary}/></details>
 </>;
}
export function CopyClosingReview({source,command}:{source:ClosingReviewSource;command:ClosingCommand}){
 const [manual,setManual]=useState(false),[notice,setNotice]=useState(''),text=useMemo(()=>JSON.stringify({action:closingActionName(command),command,source},null,2),[source,command]);
 async function copy(){try{await navigator.clipboard.writeText(text);setManual(false);setNotice('Saved closing details copied.');}catch{setManual(true);setNotice('Select the saved details below to copy them.');}}
 return <><Button kind="secondary" onClick={()=>void copy()}>Copy saved closing details</Button>{notice?<p role="status">{notice}</p>:null}{manual?<label className="closing-review-copy">Saved closing details<textarea readOnly rows={6} value={text} onFocus={event=>event.currentTarget.select()}/></label>:null}</>;
}
