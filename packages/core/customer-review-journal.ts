import {parseCustomerReviewRequest,parseCustomerReviewSource,type CustomerReviewRequest} from './customer-review-source';
import {parsePreparedCustomerReview,type PreparedCustomerReview} from './customer-review-view';
import {parseCustomerResolutionReceipt,type CustomerResolutionReceipt} from './customer-review';
import {parseCustomerCommandReceipt,type CustomerCommandReceipt} from './customer-commands';
import {syncDownloadToken} from './sync-download';
import {syncHash} from './sync-read';
export type CustomerReviewQuote=Omit<PreparedCustomerReview,'token'>;
export interface CustomerReviewChoice {outcome:'withdrawn'|'replaced'}
export interface LocalCustomerReview {
 id:string;version:1;revision:number;uploadId:string;entryId:string;commandIndex:number;identityHash:string;commandHash:string;
 packet:CustomerReviewRequest;phase:'preparing'|'review'|'deciding'|'unconfirmed'|'confirmed';
 quote:CustomerReviewQuote|null;quoteHash:string|null;choice:CustomerReviewChoice|null;
 attempts:(CustomerReviewChoice&{quoteHash:string;at:number})[];receipt:CustomerCommandReceipt|CustomerResolutionReceipt|null;
}
export const localCustomerReviewTableNames=['customerReviews'] as const;
export async function customerReviewQuoteHash(quote:CustomerReviewQuote):Promise<string>{const {at,expiresAt,...values}=quote;void at;void expiresAt;return syncHash(new TextEncoder().encode(syncDownloadToken(values)));}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
function choice(value:unknown):CustomerReviewChoice {if(!object(value)||!exact(value,'outcome')||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the explicit original customer choice.');return {outcome:value.outcome as CustomerReviewChoice['outcome']};}
/** Display facts only. Tokens and runtime credentials are never durable. */
export function customerReviewQuote(value:PreparedCustomerReview):CustomerReviewQuote {const {token,...quote}=value;void token;return structuredClone(quote);}
export function parseCustomerReviewQuote(value:unknown,packet:CustomerReviewRequest,commandHash:string):CustomerReviewQuote {if(!object(value)||'token'in value||value.commandHash!==commandHash)throw Error('Keep the original comparison without credentials.');return customerReviewQuote(parsePreparedCustomerReview({...value,token:'x'.repeat(43)},packet));}
export function parseLocalCustomerReview(value:unknown):LocalCustomerReview {
 if(!object(value)||!exact(value,'id,version,revision,uploadId,entryId,commandIndex,identityHash,commandHash,packet,phase,quote,quoteHash,choice,attempts,receipt')||value.version!==1||!hash(value.id)||!hash(value.identityHash)||!hash(value.commandHash)||!id(value.uploadId)||!id(value.entryId)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||!Number.isSafeInteger(value.commandIndex)||(value.commandIndex as number)<0||!['preparing','review','deciding','unconfirmed','confirmed'].includes(value.phase as string)||!Array.isArray(value.attempts))throw Error('Keep the complete original saved customer review.');
 const packet=parseCustomerReviewRequest(value.packet,false),source=parseCustomerReviewSource(packet),quote=value.quote===null?null:parseCustomerReviewQuote(value.quote,packet,value.commandHash),selected=value.choice===null?null:choice(value.choice);
 if(value.entryId!==source.entryId||value.commandIndex!==source.commandIndex||(quote===null)!==(value.quoteHash===null)||value.quoteHash!==null&&!hash(value.quoteHash)||['review','deciding','unconfirmed'].includes(value.phase as string)&&!quote||['deciding','unconfirmed'].includes(value.phase as string)&&!selected)throw Error('Keep the original source position, displayed customer values and choice.');
 const attempts=value.attempts.map(attempt=>{if(!object(attempt)||!exact(attempt,'outcome,quoteHash,at')||!hash(attempt.quoteHash)||!time(attempt.at))throw Error('Keep every original customer review choice.');return {...choice({outcome:attempt.outcome}),quoteHash:attempt.quoteHash,at:attempt.at};});
 const receipt=value.receipt===null?null:object(value.receipt)&&value.receipt.type==='command.resolved'?parseCustomerResolutionReceipt(value.receipt,packet.command):parseCustomerCommandReceipt(value.receipt,packet.command);
 if((value.phase==='confirmed')!==(receipt!==null)||receipt?.type==='command.resolved'&&(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==value.commandHash))throw Error('A saved choice is not an actual source-bound server outcome.');
 return {...structuredClone(value),packet,quote,choice:selected,attempts,receipt} as unknown as LocalCustomerReview;
}
