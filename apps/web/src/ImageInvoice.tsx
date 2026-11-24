import {useMemo,useRef,useState,type ReactNode} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link} from 'react-router-dom';
import {Button,Card} from '@mise/ui/primitives.tsx';
import {Modal} from '@mise/ui/Modal.tsx';
import type {SetupSnapshot,StockItem,Supplier} from '@mise/core/models';
import {formatMoney,moneyInputValue,parseMoney} from '@mise/core/money';
import {orderLineTotal} from '@mise/core/order-lines';
import {stockNameKey,stockUnit,parseStockQuantity,stockQuantityText} from '@mise/core/stock-quantity';
import {parseOcrInvoice} from '@mise/core/ocr-invoice';
import {ocrWarning,ocrLineNeedsReview,type OcrRead} from '@mise/core/ocr';
import {marketPacks} from '@mise/core/packs';
import {db} from './data/db';
import {recordImageInvoice,savedImageReceipt,undoImageInvoice,type ImageInvoiceInput,type ImageReceipt,type SavedImageReview} from './data/image-capture';
import {CaptureHeader,CapturePhoto} from './CaptureSource';
import {errorText,khataDate} from './khata-data';
import packageAsset from './assets/capture/package.svg';
import editAsset from './assets/capture/edit.svg';
import cameraAsset from './assets/capture/camera.svg';
import warningAsset from './assets/capture/warning.svg';
import successAsset from './assets/capture/success.svg';
import checkAsset from './assets/inbox/check.svg';

type InvoiceReceipt=ImageReceipt&{kind:'invoice'};
type Line={key:string;name:string;unit:string;qty:string;price:string;stockId:string;revision?:number;unclear:boolean;printedAmount?:number};
interface Props {setup:SetupSnapshot;review:SavedImageReview;read?:OcrRead;initialReceipt?:InvoiceReceipt;embedded?:boolean;tools?:ReactNode;disabled?:boolean;onRecorded?:(receipt:InvoiceReceipt)=>void}
export function ImageInvoice(props:Props){
 const [receipt,setReceipt]=useState(props.initialReceipt),[error,setError]=useState(''),[saving,setSaving]=useState(false),busy=useRef(false);
 const data=useLiveQuery(async()=>{const [items,suppliers]=await Promise.all([db.stockItems.where('outletId').equals(props.setup.outlet.id).toArray(),db.suppliers.where('outletId').equals(props.setup.outlet.id).toArray()]);return {items,suppliers};},[props.setup.outlet.id]);
 async function undo(){if(busy.current)return;busy.current=true;setSaving(true);setError('');try{setReceipt(await undoImageInvoice(db,props.review));}catch(error){setError(errorText(error));}finally{busy.current=false;setSaving(false);}}
 if(receipt){const allReversed=receipt.reversedMoveIds.length===receipt.moves.length,undone=receipt.purchase.voidedAt!==undefined&&allReversed;return <section className="capture-page"><CaptureHeader mode="invoice" title={undone?'Invoice undone':'Invoice recorded'}/><div className="capture-content"><CapturePhoto review={props.review}/><Card className="capture-invoice-card"><header><strong>{receipt.purchase.supplierName}</strong><span>{receipt.purchase.reference||'Checked invoice'}</span></header>{receipt.purchase.lines.map((line,index)=><div className="capture-invoice-row" key={index}><span>{line.name} · {stockQuantityText(line.qty)} {line.unit}</span><span>{formatMoney(line.lineTotal,receipt.purchase.currency)}</span></div>)}<footer><strong>{formatMoney(receipt.purchase.total,receipt.purchase.currency)}</strong><span>{receipt.purchase.voidedAt!==undefined?'Invoice undone':receipt.purchase.methodName==='Due'?'Due':`Paid ${receipt.purchase.methodName}`}</span></footer></Card><Card className="capture-entry"><h2>Original receipt</h2><p>{khataDate(receipt.purchase.createdAt,props.setup,true)} · {receipt.moves.length-receipt.reversedMoveIds.length} stock receipts still recorded.</p><p>{undone?'Stock quantities and the invoice are undone. Stock item names stay in your list.':'Opening or refreshing this receipt does not receive the stock again.'}</p><Link to={`/inbox/${props.review.itemId}`}>Original image in Inbox</Link><Link to="/stock">Open stock</Link></Card>{error?<p role="alert" className="form-error">{error}</p>:null}</div><footer className="capture-actions">{!undone?<Button kind="secondary" disabled={saving} onClick={()=>void undo()}>{saving?'Checking original…':receipt.purchase.voidedAt!==undefined?'Undo remaining stock':'Undo invoice and stock receipt'}</Button>:null}<Link className="button button-ghost" to="/inbox/capture/invoice">Record another invoice</Link></footer></section>;}
 if(!data)return <p aria-busy="true">Opening current stock and suppliers…</p>;
 return <InvoiceEditor {...props} items={data.items} suppliers={data.suppliers} onSaved={receipt=>{setReceipt(receipt);props.onRecorded?.(receipt);}}/>;
}
function InvoiceEditor({setup,review,read,embedded,tools,disabled,items,suppliers,onSaved}:Props&{items:StockItem[];suppliers:Supplier[];onSaved:(receipt:InvoiceReceipt)=>void}){
 const parsed=useMemo(()=>read?parseOcrInvoice(read,setup.outlet.currency):undefined,[read,setup.outlet.currency]),activeItems=items.filter(item=>item.archivedAt===undefined),activeSuppliers=suppliers.filter(supplier=>supplier.archivedAt===undefined);
 function chooseStock(name:string,unit:string){const matches=activeItems.filter(item=>stockUnit(item.unit)===stockUnit(unit)&&[item.name,...item.aliases].some(value=>stockNameKey(value)===stockNameKey(name)));return matches.length===1?matches[0]:undefined;}
 function blank():Line{return {key:crypto.randomUUID(),name:'',unit:'pcs',qty:'1',price:'',stockId:'new',unclear:true};}
 const [lines,setLines]=useState<Line[]>(()=>parsed?.items.length?parsed.items.map(item=>{const stock=chooseStock(item.name,item.unit);return {key:crypto.randomUUID(),name:item.name,unit:item.unit,qty:String(item.quantity),price:moneyInputValue(item.unitPrice,setup.outlet.currency),stockId:stock?.id??'new',revision:stock?.revision,unclear:ocrLineNeedsReview(item.source),printedAmount:item.printedAmount};}):[blank()]);
 const guessedSupplier=parsed?.otherLines.find(value=>value.source.text.trim().length<=120)?.source.text.trim()??'',matchedSupplier=activeSuppliers.filter(supplier=>stockNameKey(supplier.name)===stockNameKey(guessedSupplier));
 const [supplierId,setSupplierId]=useState(matchedSupplier.length===1?matchedSupplier[0].id:''),[supplierName,setSupplierName]=useState(guessedSupplier),[reference,setReference]=useState(()=>parsed?.otherLines.map(value=>/^invoice\s+(.+)$/i.exec(value.source.text.trim())?.[1]).find(Boolean)??''),[note,setNote]=useState(''),[paid,setPaid]=useState('Due'),[printed,setPrinted]=useState(()=>parsed?.totals.length===1?moneyInputValue(parsed.totals[0].amount,setup.outlet.currency):''),[noTotal,setNoTotal]=useState(false),[counted,setCounted]=useState(false),[editor,setEditor]=useState<string>(),[error,setError]=useState(''),[saving,setSaving]=useState(false),busy=useRef(false);
 const wallets=marketPacks[setup.business.marketCode]['pay/wallets'].filter(value=>value!=='Cash'),editing=lines.find(line=>line.key===editor);
 function patch(key:string,change:Partial<Line>){setLines(before=>before.map(line=>line.key===key?{...line,...change,unclear:true}:line));setCounted(false);setError('');}
 let total:number|null=null;try{total=lines.reduce((sum,line)=>{const price=parseMoney(line.price,setup.outlet.currency),qty=parseStockQuantity(line.qty);if(price===null||qty===null||!line.name.trim())throw Error();const next=sum+orderLineTotal(price,qty);if(!Number.isSafeInteger(next))throw Error();return next;},0);}catch{/* Incomplete editable lines stay unsaved. */}
 const printedAmount=noTotal?null:parseMoney(printed,setup.outlet.currency),addsUp=!noTotal&&printedAmount!==null&&printedAmount===total,changedStock=lines.some(line=>{const item=activeItems.find(item=>item.id===line.stockId);return line.stockId!=='new'&&(!item||item.revision!==line.revision||stockUnit(item.unit)!==stockUnit(line.unit));});
 function refreshStock(){setLines(before=>before.map(line=>{const item=activeItems.find(item=>item.id===line.stockId);return item?{...line,revision:item.revision}:line;}));setCounted(false);setError('Current quantities refreshed. Check the selected stock and quantities again.');}
 async function inspect(){if(busy.current)return;busy.current=true;setSaving(true);setError('');try{const receipt=await savedImageReceipt(db,review);if(receipt?.kind==='invoice')onSaved(receipt);else setError(receipt?'This image already created an order. Open its original in Inbox.':'No invoice was recorded from this image yet. Your draft is still here.');}catch(error){setError(errorText(error));}finally{busy.current=false;setSaving(false);}}
 async function save(){if(busy.current||disabled)return;busy.current=true;setSaving(true);setError('');try{
  if(!counted||total===null||!noTotal&&!addsUp)throw new Error('Check the invoice total and count the received quantities first.');
  const input:ImageInvoiceInput={supplierId:supplierId||undefined,supplierName,reference,note,paid:paid==='Due'?'due':paid==='Cash'?'cash':paid==='Card'?'card':'wallet',...(wallets.includes(paid)?{wallet:paid}:{}),counted,lines:lines.map(line=>{const qty=parseStockQuantity(line.qty),unitPrice=parseMoney(line.price,setup.outlet.currency);if(qty===null||unitPrice===null)throw new Error('Enter every quantity and unit price.');return {name:line.name,unit:line.unit,qty,unitPrice,stock:line.stockId==='new'?{type:'new'}:{type:'existing',id:line.stockId,revision:line.revision??-1}};})};onSaved(await recordImageInvoice(db,review,input));
 }catch(error){setError(errorText(error));}finally{busy.current=false;setSaving(false);}}
 const blocked=saving||disabled;
 const body=<>
  <Card className="capture-invoice-card" data-node-id="106:507">
   <header><button type="button" disabled={blocked} onClick={()=>setEditor('supplier')}><strong>{supplierId?activeSuppliers.find(supplier=>supplier.id===supplierId)?.name||supplierName:supplierName||'Choose supplier'}</strong><span>{supplierId?'Saved supplier':'Check supplier'}</span></button></header>
   {lines.map((line,index)=>{
    let amount:number|null=null;
    try{const price=parseMoney(line.price,setup.outlet.currency),qty=parseStockQuantity(line.qty);if(price!==null&&qty!==null)amount=orderLineTotal(price,qty);}catch{/* Keep missing values editable. */}
    return <button className="capture-invoice-row" type="button" disabled={blocked} key={line.key} aria-label={`Edit invoice line ${index+1}: ${line.name||'New item'}`} onClick={()=>setEditor(line.key)}>
     <span><strong>{line.name||'New item'} · {line.qty||'—'} {line.unit}</strong>{line.unclear?<small className="capture-warning"><img src={warningAsset} alt=""/>{ocrWarning}</small>:null}</span>
     <span>{amount===null?'Price':formatMoney(amount,setup.outlet.currency)}</span>
    </button>;
   })}
   <footer><button type="button" className="capture-total-edit" disabled={blocked} aria-label="Check or edit invoice total" onClick={()=>setEditor('totals')}><strong>Total {total===null?'—':formatMoney(total,setup.outlet.currency)}</strong></button><span className={addsUp?'capture-positive':'capture-warning'}>{addsUp?<img src={successAsset} alt=""/>:null}{addsUp?'Adds up':noTotal?'No printed total':printedAmount===null?'Check invoice total':'Total differs'}</span></footer>
  </Card>
  <div className="capture-invoice-controls">
   <div className="capture-payment"><span>Payment</span><div role="group" aria-label="Invoice payment">{['Cash',...wallets,'Due','Card'].map(value=><Button key={value} kind={paid===value?'primary':'secondary'} aria-pressed={paid===value} disabled={blocked} onClick={()=>{setPaid(value);setCounted(false);}}>{value==='Due'?'Pay later (due)':value==='Cash'?'Paid cash':value}</Button>)}</div></div>
   <p className="capture-stock-summary"><img src={packageAsset} alt=""/><span>Stock: {lines.map(line=>`${line.stockId==='new'?line.name:activeItems.find(item=>item.id===line.stockId)?.name||line.name} +${line.qty} ${line.unit}`).join(', ')}. Purchases: {total===null?'check prices':formatMoney(total,setup.outlet.currency)} {paid==='Due'?'due':`paid ${paid}`}.</span></p>
   {lines.some(line=>line.stockId==='new')?<p className="capture-help">New stock items start at zero before this receipt. Choose an existing item in the line editor if you already track it.</p>:null}
   <label className="capture-confirm-line"><input type="checkbox" checked={counted} disabled={blocked||changedStock} onChange={event=>setCounted(event.target.checked)}/><span>I checked the invoice and counted these received quantities</span></label>
   {changedStock?<div role="alert"><p className="capture-warning">Stock changed while you reviewed. Check the current quantities again.</p><Button kind="secondary" disabled={blocked} onClick={refreshStock}>Refresh current quantities</Button></div>:null}
   {error?<p role="alert" className="form-error">{error}</p>:null}
   <details className="capture-review-tools"><summary>Source lines, reader and saved receipt</summary>
    {parsed?.otherLines.length?<><h2>Check source lines not placed in the invoice</h2>{parsed.otherLines.map(({source},index)=><p dir="auto" key={index}>{source.text}</p>)}<p>Check that no item or charge is missing. Add it as a line before saving.</p></>:null}
    <Button kind="ghost" disabled={blocked} onClick={refreshStock}>Refresh current quantities</Button><Button kind="ghost" disabled={blocked} onClick={()=>void inspect()}>Check saved receipt</Button>{tools}
   </details>
  </div>
  <footer className="capture-actions"><Button disabled={blocked||changedStock||total===null||!counted||!noTotal&&!addsUp||!lines.length||lines.length>200} onClick={()=>void save()}><img src={checkAsset} alt=""/>{saving?'Recording…':'Add to stock and purchases'}</Button><div><Button kind="ghost" disabled={blocked} onClick={()=>setEditor(lines[0]?.key??'supplier')}><img src={editAsset} alt=""/>Fix a line</Button><Link className="button button-ghost" to="/inbox/capture/invoice"><img src={cameraAsset} alt=""/>Choose another image</Link></div></footer>
 </>;
 const modal=<Modal open={Boolean(editor)} variant="sheet" title={editor==='supplier'?'Invoice details':editor==='totals'?'Invoice total':`Invoice line ${lines.findIndex(line=>line.key===editor)+1}`} closeLabel="Close invoice editor" onClose={()=>setEditor(undefined)}>
  <fieldset disabled={blocked} className="capture-line-editor">
   {editor==='supplier'?<>
    <label>Saved supplier<select value={supplierId} onChange={event=>{setSupplierId(event.target.value);const supplier=activeSuppliers.find(supplier=>supplier.id===event.target.value);if(supplier)setSupplierName(supplier.name);setCounted(false);}}><option value="">Enter a supplier name</option>{activeSuppliers.map(supplier=><option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
    <label>Supplier name<input maxLength={120} value={supplierName} disabled={Boolean(supplierId)} onChange={event=>{setSupplierName(event.target.value);setCounted(false);}}/></label>
    <label>Invoice reference<input maxLength={120} value={reference} onChange={event=>{setReference(event.target.value);setCounted(false);}}/></label>
    <label>Invoice note<textarea rows={3} value={note} onChange={event=>{setNote(event.target.value);setCounted(false);}}/></label>
   </>:editor==='totals'?<>
    <label>Printed invoice total ({setup.outlet.currency})<input aria-label="Printed invoice total" inputMode="decimal" value={printed} disabled={noTotal} onChange={event=>{setPrinted(event.target.value);setCounted(false);}}/></label>
    <label className="capture-confirm-line"><input type="checkbox" checked={noTotal} onChange={event=>{setNoTotal(event.target.checked);setCounted(false);}}/><span>No total is printed on this source</span></label>
    <p>Calculated total: {total===null?'complete every line first':formatMoney(total,setup.outlet.currency)}. Compare with the original image before confirming.</p>
   </>:editing?<>
    <label>Item name<input maxLength={120} value={editing.name} onChange={event=>patch(editing.key,{name:event.target.value})}/></label>
    <label>Quantity<input inputMode="decimal" value={editing.qty} onChange={event=>patch(editing.key,{qty:event.target.value})}/></label>
    <label>Unit<input maxLength={24} value={editing.unit} onChange={event=>patch(editing.key,{unit:event.target.value})}/></label>
    <label>Unit price ({setup.outlet.currency})<input inputMode="decimal" value={editing.price} onChange={event=>patch(editing.key,{price:event.target.value})}/></label>
    <label>Stock item<select value={editing.stockId} onChange={event=>{const item=activeItems.find(item=>item.id===event.target.value);patch(editing.key,{stockId:event.target.value,revision:item?.revision});}}><option value="new">Create a new stock item</option>{activeItems.filter(item=>stockUnit(item.unit)===stockUnit(editing.unit)).map(item=><option key={item.id} value={item.id}>{item.name} · {stockQuantityText(item.onHand)} {item.unit} now</option>)}</select></label>
    {editing.printedAmount!==undefined?<p>Read line amount: {formatMoney(editing.printedAmount,setup.outlet.currency)}. Compare it with the saved original.</p>:null}
    <Button kind="ghost" onClick={()=>{setLines(before=>before.filter(line=>line.key!==editing.key));setCounted(false);setEditor(undefined);}}>Remove this line</Button>
   </>:null}
   <Button kind="secondary" disabled={lines.length>=200} onClick={()=>{const line=blank();setLines(before=>[...before,line]);setCounted(false);setEditor(line.key);}}>Add invoice line</Button>
   <Button onClick={()=>setEditor(undefined)}>Review invoice</Button>
  </fieldset>
 </Modal>;
 return embedded?<div className="capture-invoice-review">{body}{modal}</div>:<section className="capture-page" data-node-id="106:484"><CaptureHeader mode="invoice"/><div className="capture-content"><CapturePhoto review={review}/>{body}</div>{modal}</section>;
}
