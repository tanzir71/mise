import {parseStockCommand,stockWritePlan,type StockSaveInput} from './stock-commands';
import {parseStockReviewRevisions,type StockReviewRevision} from './stock-review';
import {parseStockReviewSource,parseStockReviewItem,parseStockReviewMove,type StockReviewRequest,type StockSourceItem,type StockSourceMove} from './stock-review-source';
import {stockAtoms,stockNumber,stockUnit} from './stock-quantity';
import {syncDownloadToken} from './sync-download';
export type StockReviewProjection=Omit<StockSourceItem,'updatedAt'>;
export interface StockReviewSupplier {id:string;name:string;archived:boolean}
export interface PreparedStockReview {
 v:1;id:string;replacementId:string;commandId:string;commandHash:string;sourceHash:string;businessId:string;outletId:string;actorId:string;token:string;at:number;expiresAt:number;
 current:{stateHash:string;timezone:string;items:{stockItemId:string;item:StockSourceItem|null}[];input:StockSaveInput|null;suppliers:{saved:StockReviewSupplier|null;current:StockReviewSupplier|null};undo:{move:StockSourceMove;reversed:boolean;laterCount:boolean;restoredCountAt:number|null}|null};
 proposal:{enabled:false;reason:'unit'|'unavailable'|'clock'|'expired'|'count'}|{enabled:true;revisions:StockReviewRevision[];items:StockReviewProjection[];input:StockSaveInput|null};
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
export function stockReviewInput(item:{name:string;nameLocal:string;unit:string;category:string;aliases:string[];onHand:number;target:number;packSize:number;lowAt?:number;supplierId?:string}):StockSaveInput{
 return {name:item.name,nameLocal:item.nameLocal,unit:item.unit,category:item.category,aliases:[...item.aliases],onHand:item.onHand,target:item.target,packSize:item.packSize,lowAt:item.lowAt??null,supplierId:item.supplierId??null};
}
export function stockReviewProjection(item:StockSourceItem):StockReviewProjection{const {updatedAt,...result}=item;void updatedAt;return result;}
export function parsePreparedStockReview(value:unknown,input:StockReviewRequest):PreparedStockReview{
 const c=input.command,plan=stockWritePlan(c),source=parseStockReviewSource(input);
 if(!object(value)||!exact(value,'v,id,replacementId,commandId,commandHash,sourceHash,businessId,outletId,actorId,token,at,expiresAt,current,proposal')||value.v!==1||value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||value.outletId!==c.outletId||value.sourceHash!==input.sourceHash||!hash(value.commandHash)||!id(value.businessId)||!id(value.actorId)||source.events.some(e=>e.actorId!==value.actorId)||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||value.expiresAt<=value.at||value.expiresAt-value.at>300000||!object(value.current)||!object(value.proposal))throw Error('Review the original stock action again.');
 const current=value.current;
 if(!exact(current,'stateHash,timezone,items,input,suppliers,undo')||!hash(current.stateHash)||typeof current.timezone!=='string'||current.timezone.length>128||!Array.isArray(current.items)||current.items.length!==plan.rows.length||!object(current.suppliers)||!exact(current.suppliers,'saved,current'))throw Error('Keep the complete current stock comparison.');
 try{new Intl.DateTimeFormat('en',{timeZone:current.timezone});}catch{throw Error('Keep the current stock timezone.');}
 const items=current.items.map((row,index)=>{const p=plan.rows[index];if(!object(row)||!exact(row,'stockItemId,item')||row.stockItemId!==p.itemId)throw Error('Keep every original stock destination.');const item=row.item===null?null:parseStockReviewItem(row.item);if(item&&(item.id!==p.itemId||item.outletId!==c.outletId))throw Error('Keep the current scoped stock item.');return {stockItemId:p.itemId,item};});
 let currentInput:StockSaveInput|null=null;
 if(current.input!==null){if(!('input'in c)||!items[0].item)throw Error('Keep metadata only for the original item edit.');const parsed=parseStockCommand({...c,input:current.input});if(!('input'in parsed))throw Error();currentInput=parsed.input;const item=items[0].item;if(currentInput.name!==item.name||currentInput.unit!==item.unit||currentInput.onHand!==item.onHand)throw Error('Keep the current item fields together.');}
 if('input'in c&&!!items[0].item!==(currentInput!==null))throw Error('Keep the full current item input.');
 const supplier=(value:unknown,expected:string|null):StockReviewSupplier|null=>{if(value===null)return null;if(!expected||!object(value)||!exact(value,'id,name,archived')||value.id!==expected||typeof value.name!=='string'||!value.name.trim()||value.name.length>120||typeof value.archived!=='boolean')throw Error('Keep the actual selected supplier and current name.');return {id:expected,name:value.name,archived:value.archived};};
 const suppliers={saved:supplier(current.suppliers.saved,'input'in c?c.input.supplierId:null),current:supplier(current.suppliers.current,currentInput?.supplierId??null)};
 if(suppliers.saved&&suppliers.current&&suppliers.saved.id===suppliers.current.id&&!same(suppliers.saved,suppliers.current))throw Error('Keep one current name for the same linked supplier.');
 let undo:PreparedStockReview['current']['undo']=null;
 if(current.undo!==null){if(c.type!=='stock.undo'||!object(current.undo)||!exact(current.undo,'move,reversed,laterCount,restoredCountAt')||typeof current.undo.reversed!=='boolean'||typeof current.undo.laterCount!=='boolean'||current.undo.restoredCountAt!==null&&!time(current.undo.restoredCountAt))throw Error('Keep the original undo comparison.');const move=parseStockReviewMove(current.undo.move);if(move.id!==c.undoMoveId||move.stockItemId!==c.stockItemId||move.outletId!==c.outletId)throw Error('Keep the original movement being undone.');undo={move,reversed:current.undo.reversed,laterCount:current.undo.laterCount,restoredCountAt:current.undo.restoredCountAt as number|null};}
 const proposal=value.proposal;
 if(proposal.enabled===false){if(!exact(proposal,'enabled,reason')||!['unit','unavailable','clock','expired','count'].includes(proposal.reason as string))throw Error('Keep the unavailable stock proposal.');}
 else{
  if(proposal.enabled!==true||!exact(proposal,'enabled,revisions,items,input')||!Array.isArray(proposal.items)||proposal.items.length!==plan.rows.length||c.occurredAt>value.at+300000)throw Error('Keep the complete reviewed stock proposal.');
  const revisions=parseStockReviewRevisions(proposal.revisions,c);
  if('input'in c&&c.input.supplierId&&(!suppliers.saved||suppliers.saved.archived))throw Error('Keep the available saved supplier selection.');
  if(c.type==='stock.undo'&&(!undo||undo.reversed||undo.laterCount||undo.move.undoOf!==null||undo.move.reason==='undo'||value.at<undo.move.createdAt||value.at-undo.move.createdAt>86400000||c.occurredAt<undo.move.createdAt||undo.move.eventId!==source.events[0].undoOf||stockAtoms(undo.move.delta,true)!==-stockAtoms(source.events[0].after.move!.delta,true)))throw Error('Keep the original movement and actual undo deadline.');
  for(let i=0;i<plan.rows.length;i++){
   const p=plan.rows[i],before=items[i].item,recorded=source.events[i],projection=proposal.items[i];
   if(c.type==='stock.create'?before!==null:before===null)throw Error('Keep the current stock identity and presence.');
   if(revisions[i].revision!==(before?.revision??0)||before&&(before.unit!==recorded.after.item.unit||before.createdAt!==recorded.before!.createdAt))throw Error('Keep the actual current predecessor and original unit.');
   if(before?.archivedAt!==null&&before!==null&&!(c.type==='stock.archive'||c.type==='stock.restore'||c.type==='stock.update'&&c.moveId===null))throw Error('Restore this item before applying its stock movement.');
   if(!object(projection)||!exact(projection,'id,outletId,revision,name,unit,onHand,eventId,createdAt,lastCountedAt,archivedAt'))throw Error('Keep all reviewed stock values.');
   const after=parseStockReviewItem({...projection,updatedAt:Math.max(value.at,c.occurredAt,before?.createdAt??c.occurredAt)}),beforeAtoms=stockAtoms(before?.onHand??0),expectedAtoms=p.reason==='count'?stockAtoms(p.quantity!):p.reason==='received'?beforeAtoms+stockAtoms(p.quantity!):p.reason==='used'||p.reason==='waste'?beforeAtoms-stockAtoms(p.quantity!):p.reason==='undo'?beforeAtoms-stockAtoms(undo!.move.delta,true):beforeAtoms;
   const archive=c.type==='stock.archive'?c.occurredAt:c.type==='stock.restore'?null:before?.archivedAt??null,lastCountedAt=c.type==='stock.undo'?undo!.restoredCountAt:p.reason==='count'?c.occurredAt:before?.lastCountedAt??null;
   if(after.id!==p.itemId||after.outletId!==c.outletId||after.revision!==revisions[i].revision+1||after.eventId!==(i===0?input.replacementId:p.eventId)||after.name!==('input'in c?c.input.name.trim():before!.name)||after.unit!==recorded.after.item.unit||stockAtoms(after.onHand)!==expectedAtoms||after.createdAt!==(before?.createdAt??c.occurredAt)||after.archivedAt!==archive||after.lastCountedAt!==lastCountedAt)throw Error('Keep the exact original quantity, unit, identities and physical time.');
  }
  let expectedInput:StockSaveInput|null=null;
  if('input'in c){const v=c.input;expectedInput={name:v.name.trim(),nameLocal:v.nameLocal.trim(),unit:stockUnit(v.unit),category:v.category.trim(),aliases:[...new Set(v.aliases.map(a=>a.trim()).filter(Boolean))],onHand:c.type==='stock.update'&&c.moveId===null?items[0].item!.onHand:v.onHand,target:v.target,packSize:v.packSize,lowAt:v.lowAt??stockNumber(stockAtoms(v.target)/2n),supplierId:v.supplierId};}
  // Metadata is a single item. Batches expose only quantities/units rather
  // than repeating every unrelated alias array in a 1,000-line comparison.
  if(!same(proposal.input,expectedInput))throw Error('Keep every original item input field in the proposal.');
 }
 return structuredClone({...value,current:{stateHash:current.stateHash,timezone:current.timezone,items,input:currentInput,suppliers,undo}}) as unknown as PreparedStockReview;
}
