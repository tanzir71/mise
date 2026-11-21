import {parseClosingReviewRequest,parseClosingReviewSource,type ClosingReviewRequest} from './closing-review-source';
import {parsePreparedClosingReview,type PreparedClosingReview} from './closing-review-view';
import {parseClosingResolutionReceipt,parseSavedClosingReceipt,type ClosingResolutionReceipt} from './closing-review';
import type {ClosingCommandReceipt} from './closing-commands';
import {syncDownloadToken} from './sync-download';
import {syncHash} from './sync-read';

export type ClosingReviewQuote=Omit<PreparedClosingReview,'token'>;
export interface ClosingReviewChoice {outcome:'withdrawn'|'replaced'}
export interface LocalClosingReview {
 id:string;version:1;revision:number;uploadId:string;entryId:string;commandIndex:number;identityHash:string;commandHash:string;
 packet:ClosingReviewRequest;phase:'preparing'|'review'|'deciding'|'unconfirmed'|'confirmed';
 quote:ClosingReviewQuote|null;quoteHash:string|null;choice:ClosingReviewChoice|null;
 attempts:(ClosingReviewChoice&{quoteHash:string;at:number})[];receipt:ClosingCommandReceipt|ClosingResolutionReceipt|null;
}
export const localClosingReviewTableNames=['closingReviews'] as const;
export async function closingReviewQuoteHash(quote:ClosingReviewQuote):Promise<string>{const {at,expiresAt,...values}=quote;void at;void expiresAt;return syncHash(new TextEncoder().encode(syncDownloadToken(values)));}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
function choice(value:unknown):ClosingReviewChoice {if(!object(value)||!exact(value,'outcome')||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the explicit original closing choice.');return {outcome:value.outcome as ClosingReviewChoice['outcome']};}
/** Display facts only. Tokens and runtime credentials are never durable. */
export function closingReviewQuote(value:PreparedClosingReview):ClosingReviewQuote {const {token,...quote}=value;void token;return structuredClone(quote);}
export function parseClosingReviewQuote(value:unknown,packet:ClosingReviewRequest,commandHash:string):ClosingReviewQuote {if(!object(value)||'token'in value||value.commandHash!==commandHash)throw Error('Keep the original comparison without credentials.');return closingReviewQuote(parsePreparedClosingReview({...value,token:'x'.repeat(43)},packet));}
export function parseLocalClosingReview(value:unknown):LocalClosingReview {
 if(!object(value)||!exact(value,'id,version,revision,uploadId,entryId,commandIndex,identityHash,commandHash,packet,phase,quote,quoteHash,choice,attempts,receipt')||value.version!==1||!hash(value.id)||!hash(value.identityHash)||!hash(value.commandHash)||!id(value.uploadId)||!id(value.entryId)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||!Number.isSafeInteger(value.commandIndex)||(value.commandIndex as number)<0||!['preparing','review','deciding','unconfirmed','confirmed'].includes(value.phase as string)||!Array.isArray(value.attempts))throw Error('Keep the complete original saved closing review.');
 const packet=parseClosingReviewRequest(value.packet,false),source=parseClosingReviewSource(packet),quote=value.quote===null?null:parseClosingReviewQuote(value.quote,packet,value.commandHash),selected=value.choice===null?null:choice(value.choice);
 if(value.entryId!==source.entryId||value.commandIndex!==source.commandIndex||(quote===null)!==(value.quoteHash===null)||value.quoteHash!==null&&!hash(value.quoteHash)||['review','deciding','unconfirmed'].includes(value.phase as string)&&!quote||['deciding','unconfirmed'].includes(value.phase as string)&&!selected)throw Error('Keep the original source position, displayed closing values and choice.');
 const attempts=value.attempts.map(attempt=>{if(!object(attempt)||!exact(attempt,'outcome,quoteHash,at')||!hash(attempt.quoteHash)||!time(attempt.at))throw Error('Keep every original closing review choice.');return {...choice({outcome:attempt.outcome}),quoteHash:attempt.quoteHash,at:attempt.at};});
 const receipt=value.receipt===null?null:object(value.receipt)&&value.receipt.type==='command.resolved'?parseClosingResolutionReceipt(value.receipt,packet):parseSavedClosingReceipt(value.receipt,packet);
 if((value.phase==='confirmed')!==(receipt!==null)||receipt?.type==='command.resolved'&&(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==value.commandHash))throw Error('A saved choice is not an actual source-bound server outcome.');
 return {...structuredClone(value),packet,quote,choice:selected,attempts,receipt} as unknown as LocalClosingReview;
}
