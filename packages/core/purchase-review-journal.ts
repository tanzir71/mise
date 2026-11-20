import {parsePurchaseReviewRequest,parsePreparedPurchaseReview,parsePurchaseResolutionReceipt,type PurchaseReviewRequest,type PreparedPurchaseReview,type PurchaseResolutionReceipt} from './purchase-review';
import {parsePurchaseCommandReceipt,type PurchaseCommandReceipt} from './purchase-commands';
import {syncDownloadToken} from './sync-download';
import {syncHash} from './sync-read';
export type PurchaseReviewQuote=Omit<PreparedPurchaseReview,'token'>;
export interface PurchaseReviewChoice {outcome:'withdrawn'|'replaced'}
export interface LocalPurchaseReview {
 id:string;version:1;revision:number;uploadId:string;entryId:string;commandIndex:number;identityHash:string;commandHash:string;
 packet:PurchaseReviewRequest;phase:'preparing'|'review'|'deciding'|'unconfirmed'|'confirmed';
 quote:PurchaseReviewQuote|null;quoteHash:string|null;choice:PurchaseReviewChoice|null;
 attempts:(PurchaseReviewChoice&{quoteHash:string;at:number})[];receipt:PurchaseCommandReceipt|PurchaseResolutionReceipt|null;
}
export const localPurchaseReviewTableNames=['purchaseReviews'] as const;
export async function purchaseReviewQuoteHash(quote:PurchaseReviewQuote):Promise<string>{const {at,expiresAt,...values}=quote;void at;void expiresAt;return syncHash(new TextEncoder().encode(syncDownloadToken(values)));}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
function choice(value:unknown):PurchaseReviewChoice {if(!object(value)||!exact(value,'outcome')||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the explicit original invoice choice.');return {outcome:value.outcome as PurchaseReviewChoice['outcome']};}
export function purchaseReviewQuote(value:PreparedPurchaseReview):PurchaseReviewQuote {const {token,...quote}=value;void token;return structuredClone(quote);}
/** Display data only. No server token, Auth session or connection is durable. */
export function parsePurchaseReviewQuote(value:unknown,packet:PurchaseReviewRequest,commandHash:string):PurchaseReviewQuote {if(!object(value)||'token'in value||value.commandHash!==commandHash)throw Error('Keep the original comparison without credentials.');return purchaseReviewQuote(parsePreparedPurchaseReview({...value,token:'x'.repeat(43)},packet));}
export function parseLocalPurchaseReview(value:unknown):LocalPurchaseReview {
 if(!object(value)||!exact(value,'id,version,revision,uploadId,entryId,commandIndex,identityHash,commandHash,packet,phase,quote,quoteHash,choice,attempts,receipt')||value.version!==1||!hash(value.id)||!hash(value.identityHash)||!hash(value.commandHash)||!id(value.uploadId)||!id(value.entryId)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||!Number.isSafeInteger(value.commandIndex)||(value.commandIndex as number)<0||!['preparing','review','deciding','unconfirmed','confirmed'].includes(value.phase as string)||!Array.isArray(value.attempts))throw Error('Keep the complete original saved invoice review.');
 const packet=parsePurchaseReviewRequest(value.packet,false),quote=value.quote===null?null:parsePurchaseReviewQuote(value.quote,packet,value.commandHash),selected=value.choice===null?null:choice(value.choice);
 if((quote===null)!==(value.quoteHash===null)||value.quoteHash!==null&&!hash(value.quoteHash)||['review','deciding','unconfirmed'].includes(value.phase as string)&&!quote||['deciding','unconfirmed'].includes(value.phase as string)&&!selected)throw Error('Keep the exact displayed invoice values and choice.');
 const attempts=value.attempts.map(attempt=>{if(!object(attempt)||!exact(attempt,'outcome,quoteHash,at')||!hash(attempt.quoteHash)||!Number.isSafeInteger(attempt.at)||(attempt.at as number)<0)throw Error('Keep every original invoice review choice.');return {...choice({outcome:attempt.outcome}),quoteHash:attempt.quoteHash,at:attempt.at as number};});
 const receipt=value.receipt===null?null:object(value.receipt)&&value.receipt.type==='command.resolved'?parsePurchaseResolutionReceipt(value.receipt,packet.command):parsePurchaseCommandReceipt(value.receipt,packet.command);
 if((value.phase==='confirmed')!==(receipt!==null)||receipt?.type==='command.resolved'&&(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==value.commandHash))throw Error('A saved choice is not an actual source-bound server outcome.');
 return {...structuredClone(value),packet,quote,choice:selected,attempts,receipt} as unknown as LocalPurchaseReview;
}
