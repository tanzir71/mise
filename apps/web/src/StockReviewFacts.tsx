import {useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import {stockQuantityText} from '@mise/core/stock-quantity';
import type {StockCommand,StockSaveInput} from '@mise/core/stock-commands';
import type {StockSourceItem,StockReviewSource} from '@mise/core/stock-review-source';
import type {StockReviewSupplier} from '@mise/core/stock-review-view';

/** Distinguish invisible saved code units without normalizing names or units. */
export const stockDisplayText=(value:string)=>value.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu,char=>JSON.stringify(char).slice(1,-1));
export function stockActionName(command:StockCommand):string {
 if(command.type==='stock.batch')return command.count?'Saved physical counts':'Saved stock updates';
 if(command.type==='stock.adjust')return command.change.reason==='count'?'Saved physical count':command.change.reason==='received'?'Stock received':command.change.reason==='used'?'Stock used':'Stock wasted';
 if(command.type==='stock.update')return command.moveId===null?'Saved item details':'Saved on-hand edit';
 return command.type==='stock.create'?'New stock item and opening count':command.type==='stock.undo'?'Undo original stock movement':command.type==='stock.archive'?'Archive stock item':'Restore stock item';
}
type StockFact=Pick<StockSourceItem,'name'|'unit'|'onHand'|'archivedAt'|'lastCountedAt'>;
export interface StockReviewRow {id:string;name:string;item:StockFact|null;before?:number}
export function StockReviewRows({rows,timezone}:{rows:StockReviewRow[];timezone:string}) {
 const [expanded,setExpanded]=useState(false);
 const list=(values:StockReviewRow[])=><ul className="stock-review-items">{values.map(row=><li key={row.id}><strong>{stockDisplayText(row.item?.name??row.name)}</strong>{row.item?<><span>{stockQuantityText(row.item.onHand)} {stockDisplayText(row.item.unit)}</span>{row.before!==undefined?<small>Previously {stockQuantityText(row.before)} {stockDisplayText(row.item.unit)}</small>:null}<small>{row.item.archivedAt===null?'Active':'Archived'}{row.item.lastCountedAt!==null?` · Counted ${new Date(row.item.lastCountedAt).toLocaleString('en-GB',{timeZone:timezone})}`:''}</small></>:<span>Not available online</span>}</li>)}</ul>;
 return <>{list(rows.slice(0,3))}{rows.length>3?<details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Remaining stock items ({stockQuantityText(rows.length-3)})</summary>{expanded?list(rows.slice(3)):null}</details>:null}</>;
}
export function StockReviewInputFacts({input,supplier,checked}:{input:StockSaveInput;supplier:StockReviewSupplier|null;checked:boolean}) {
 const unit=stockDisplayText(input.unit);
 return <dl className="stock-review-fields"><div><dt>Local name</dt><dd>{stockDisplayText(input.nameLocal)||'None'}</dd></div><div><dt>Category</dt><dd>{stockDisplayText(input.category)||'None'}</dd></div><div><dt>Aliases</dt><dd>{input.aliases.map(stockDisplayText).join(', ')||'None'}</dd></div><div><dt>Target</dt><dd>{stockQuantityText(input.target)} {unit}</dd></div><div><dt>Pack size</dt><dd>{stockQuantityText(input.packSize)} {unit}</dd></div><div><dt>Low-stock level</dt><dd>{input.lowAt===null?'Half the target':`${stockQuantityText(input.lowAt)} ${unit}`}</dd></div><div><dt>Supplier selection</dt><dd>{!input.supplierId?'None':supplier?<>{stockDisplayText(supplier.name)}{supplier.archived?' · Archived':''}</>:checked?'Unavailable online':'Check online to see the supplier'}</dd></div></dl>;
}
export function StockReviewNotes({command,names}:{command:StockCommand;names:ReadonlyMap<string,string>}) {
 const [expanded,setExpanded]=useState(false),notes=command.type==='stock.adjust'?[{id:command.change.id,note:command.change.note}]:command.type==='stock.batch'?command.changes.map(row=>({id:row.id,note:row.note})):[];
 if(!notes.some(row=>row.note))return null;
 return <details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Saved stock notes</summary>{expanded?<ul className="stock-review-notes">{notes.filter(row=>row.note).map(row=><li key={row.id}><strong>{stockDisplayText(names.get(row.id)??'Stock item')}</strong><pre className="order-review-source">{row.note.split('\n').map(stockDisplayText).join('\n')}</pre></li>)}</ul>:null}</details>;
}
export function CopyStockReview({source,command}:{source:StockReviewSource;command:StockCommand}) {
 const [manual,setManual]=useState(false),[notice,setNotice]=useState(''),text=[`Saved stock action · ${new Date(command.occurredAt).toLocaleString('en-GB')}`,...source.events.map(e=>`${stockDisplayText(e.after.item.name)}: ${stockQuantityText(e.after.item.onHand)} ${stockDisplayText(e.after.item.unit)}${e.before?` (previously ${stockQuantityText(e.before.onHand)})`:''}`),'',JSON.stringify(command,null,2)].join('\n');
 async function copy(){try{await navigator.clipboard.writeText(text);setNotice('Saved stock details copied.');setManual(false);}catch{setManual(true);setNotice('Select the saved details below to copy them.');}}
 return <><Button kind="secondary" onClick={()=>void copy()}>Copy saved stock details</Button>{notice?<p role="status">{notice}</p>:null}{manual?<label className="stock-review-copy">Saved stock details<textarea readOnly rows={6} value={text} onFocus={event=>event.currentTarget.select()}/></label>:null}</>;
}
