import {useRef,useState,type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {Button,Card} from '@mise/ui/primitives.tsx';
import {MiseIcon} from '@mise/ui/MiseIcon.tsx';
import {parsePastedOrder,pastedOrderInput,type PastedOrderDraft} from '@mise/core/paste-order';
import {decodeShopPayload} from '@mise/core/public-shop-decode';
import type {OrderInput} from '@mise/core/orders';
import type {Order,OrderLine,SetupSnapshot} from '@mise/core/models';
import {OrderForm} from './OrderForm';
import {OrderPricing,type OrderPriceDraft} from './OrderPricing';
import {errorText} from './khata-data';

type Review={parsed:PastedOrderDraft;input:OrderInput;notes:string[];price:OrderPriceDraft};
export function PasteOrder({setup,onSaved,onCancel}:{setup:SetupSnapshot;onSaved:(order:Order)=>void;onCancel:()=>void}){
  const [text,setText]=useState(''),[error,setError]=useState(''),[reading,setReading]=useState(false),[review,setReview]=useState<Review|null>(null),[stage,setStage]=useState<'paste'|'price'|'details'>('paste');
  const field=useRef<HTMLTextAreaElement>(null),busy=useRef(false);
  async function clipboard(){
    if(busy.current)return;busy.current=true;setReading(true);setError('');const before=text;
    try{const value=await navigator.clipboard.readText();if(field.current?.value!==before)throw new Error('The request changed while the clipboard opened. Paste it by hand.');setText(value);field.current?.focus();}
    catch(error){setError(error instanceof Error&&error.message.startsWith('The request changed')?error.message:'Clipboard access did not open. Paste or type the request below.');field.current?.focus();}
    finally{busy.current=false;setReading(false);}
  }
  function prepare(event:FormEvent){
    event.preventDefault();setError('');
    try{
      const parsed=parsePastedOrder(text,setup.business.marketCode),input=pastedOrderInput(parsed),notes=[...parsed.warnings,'Review the customer, quantities, units and prices. This draft is unsaved; check payment separately.'];
      if(parsed.shopCode){notes.push(`Request for ${parsed.shopName} · ${parsed.shopCode}.`);try{if(setup.outlet.shopLink&&decodeShopPayload(new URL(setup.outlet.shopLink).hash.slice(1)).code!==parsed.shopCode)notes.push('This request has a different shop code. Check that it was meant for your shop.');}catch{notes.push('The shop code could not be matched. Check the original request.');}}
      if(parsed.requestedTime)notes.push(`Requested time: ${parsed.requestedTime}. Choose a schedule manually if needed.`);
      if(parsed.paymentPreference)notes.push(`Requested payment: ${parsed.paymentPreference}. Confirm any payment yourself.`);
      if(parsed.photoExpected)notes.push('A separate photo is expected. Check WhatsApp for it; only text is imported here.');
      if(parsed.lines.some(line=>line.quantity===null))notes.push('Unclear counts start at 1 pc. Correct each one before creating the order.');
      if(parsed.lines.some(line=>line.name.length>120))notes.push('Use Edit to shorten long item names. The complete original request is retained.');
      if(!parsed.lines.length)notes.push('No item lines were found. Add the requested items by hand.');
      const lines:OrderLine[]=input.lines.map(line=>({...line,id:crypto.randomUUID(),note:'',unavailable:false,lineTotal:null}));
      setReview({parsed,input,notes,price:{lines,currency:setup.outlet.currency,deliveryFee:0,discount:0,sourceText:text,customerName:parsed.name,reviewNotes:notes}});
      setStage(setup.business.businessType==='corner_shop'&&lines.length?'price':'details');
    }catch(error){setError(errorText(error));field.current?.focus();}
  }
  function priced(lines:OrderLine[]){
    setReview(before=>before?{...before,input:{...before.input,lines:lines.map(line=>({name:line.name,qty:line.qty,unit:line.unit,unitPrice:line.unitPrice,note:line.note,unavailable:line.unavailable,...(line.substitution?{substitution:{from:line.substitution.from,accepted:line.substitution.accepted}}:{})}))}}:before);setStage('details');
  }
  if(review&&stage==='price')return <OrderPricing draft={review.price} onReviewed={priced} onBack={()=>setStage('paste')}/>;
  if(review&&stage==='details')return <OrderForm setup={setup} initial={review.input} reviewNotes={review.notes} onSaved={onSaved} onCancel={()=>setStage('paste')}/>;
  return <form className="order-form order-paste" onSubmit={prepare}><header className="app-page-heading"><h1>Paste order</h1><p>Turn a customer’s message into an editable draft.</p></header><Card className="order-form-card"><label className="order-field">Order message<textarea aria-label="Order message" ref={field} rows={8} value={text} onChange={event=>setText(event.target.value)} aria-describedby="paste-help"/></label><p id="paste-help" className="order-pricing-help">Paste in Bangla or English. Up to 12,000 characters and 200 non-empty lines. Unknown lines stay as written.</p><div className="order-paste-actions"><Button type="button" kind="secondary" disabled={reading} onClick={()=>void clipboard()}><MiseIcon name="clipboard" size={16}/>{reading?'Opening clipboard…':'Read clipboard'}</Button><Button type="submit" disabled={reading}>Review draft</Button><Link className="button button-ghost" to="/orders/new">Enter by hand</Link><Button type="button" kind="ghost" onClick={onCancel}>Cancel</Button></div></Card>{error?<p className="form-error" role="alert">{error}</p>:null}</form>;
}
