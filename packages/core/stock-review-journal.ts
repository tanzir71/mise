import {parseStockReviewRequest,parseStockReviewSource,type StockReviewRequest} from './stock-review-source';
import {parsePreparedStockReview,type PreparedStockReview} from './stock-review-view';
import {parseStockResolutionReceipt,type StockResolutionReceipt} from './stock-review';
import {parseStockCommandReceipt,type StockCommandReceipt} from './stock-commands';
import {syncDownloadToken} from './sync-download';
import {syncHash} from './sync-read';
export type StockReviewQuote=Omit<PreparedStockReview,'token'>;
export interface StockReviewChoice {outcome:'withdrawn'|'replaced'}
export interface LocalStockReview {
 id:string;version:1;revision:number;uploadId:string;entryId:string;commandIndex:number;identityHash:string;commandHash:string;
 packet:StockReviewRequest;phase:'preparing'|'review'|'deciding'|'unconfirmed'|'confirmed';
 quote:StockReviewQuote|null;quoteHash:string|null;choice:StockReviewChoice|null;
 attempts:(StockReviewChoice&{quoteHash:string;at:number})[];receipt:StockCommandReceipt|StockResolutionReceipt|null;
}
export const localStockReviewTableNames=['stockReviews'] as const;
export async function stockReviewQuoteHash(quote:StockReviewQuote):Promise<string>{const {at,expiresAt,...values}=quote;void at;void expiresAt;return syncHash(new TextEncoder().encode(syncDownloadToken(values)));}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
function choice(value:unknown):StockReviewChoice {if(!object(value)||!exact(value,'outcome')||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the explicit original stock choice.');return {outcome:value.outcome as StockReviewChoice['outcome']};}
/** Display facts only. Tokens and runtime credentials are never durable. */
export function stockReviewQuote(value:PreparedStockReview):StockReviewQuote {const {token,...quote}=value;void token;return structuredClone(quote);}
export function parseStockReviewQuote(value:unknown,packet:StockReviewRequest,commandHash:string):StockReviewQuote {if(!object(value)||'token'in value||value.commandHash!==commandHash)throw Error('Keep the original comparison without credentials.');return stockReviewQuote(parsePreparedStockReview({...value,token:'x'.repeat(43)},packet));}
export function parseLocalStockReview(value:unknown):LocalStockReview {
 if(!object(value)||!exact(value,'id,version,revision,uploadId,entryId,commandIndex,identityHash,commandHash,packet,phase,quote,quoteHash,choice,attempts,receipt')||value.version!==1||!hash(value.id)||!hash(value.identityHash)||!hash(value.commandHash)||!id(value.uploadId)||!id(value.entryId)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||!Number.isSafeInteger(value.commandIndex)||(value.commandIndex as number)<0||!['preparing','review','deciding','unconfirmed','confirmed'].includes(value.phase as string)||!Array.isArray(value.attempts))throw Error('Keep the complete original saved stock review.');
 const packet=parseStockReviewRequest(value.packet,false),source=parseStockReviewSource(packet),quote=value.quote===null?null:parseStockReviewQuote(value.quote,packet,value.commandHash),selected=value.choice===null?null:choice(value.choice);
 if(value.entryId!==source.entryId||value.commandIndex!==source.commandIndex||(quote===null)!==(value.quoteHash===null)||value.quoteHash!==null&&!hash(value.quoteHash)||['review','deciding','unconfirmed'].includes(value.phase as string)&&!quote||['deciding','unconfirmed'].includes(value.phase as string)&&!selected)throw Error('Keep the original source position, displayed stock values and choice.');
 const attempts=value.attempts.map(attempt=>{if(!object(attempt)||!exact(attempt,'outcome,quoteHash,at')||!hash(attempt.quoteHash)||!time(attempt.at))throw Error('Keep every original stock review choice.');return {...choice({outcome:attempt.outcome}),quoteHash:attempt.quoteHash,at:attempt.at};});
 const receipt=value.receipt===null?null:object(value.receipt)&&value.receipt.type==='command.resolved'?parseStockResolutionReceipt(value.receipt,packet.command):parseStockCommandReceipt(value.receipt,packet.command);
 if((value.phase==='confirmed')!==(receipt!==null)||receipt?.type==='command.resolved'&&(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==value.commandHash))throw Error('A saved choice is not an actual source-bound server outcome.');
 return {...structuredClone(value),packet,quote,choice:selected,attempts,receipt} as unknown as LocalStockReview;
}
