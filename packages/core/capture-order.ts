import type {OrderLineInput} from './order-lines';
import {syncDownloadToken} from './sync-download';

/** Confirmation follows the actual final line, not its row position or OCR
 * confidence. Any changed name, dose/note, quantity, price or swap needs a check. */
export function captureOrderLineToken(line:OrderLineInput):string{
 return syncDownloadToken({itemId:line.itemId??null,name:line.name.trim(),unit:line.unit.trim(),qty:line.qty,unitPrice:line.unitPrice,note:line.note?.trim()??'',unavailable:line.unavailable??false,substitution:line.substitution?{from:line.substitution.from.trim(),accepted:line.substitution.accepted}:null});
}
export function assertCapturedLinesConfirmed(lines:readonly OrderLineInput[],confirmed:readonly string[]):void{
 if(!lines.length||lines.length>200||confirmed.length!==lines.length||lines.some((line,index)=>captureOrderLineToken(line)!==confirmed[index]))throw new Error('Check every final line against the image before creating this unpaid order.');
}
