import {parseMoneyReviewRequest,parsePreparedMoneyReview,parseMoneyResolutionReceipt,type MoneyReviewRequest,type PreparedMoneyReview,type MoneyResolutionReceipt} from './money-review';
import {parseMoneyCommandReceipt,type MoneyCommandReceipt} from './money-commands';
import {syncDownloadToken} from './sync-download';
import {syncHash} from './sync-read';

export type MoneyReviewQuote=Omit<PreparedMoneyReview,'token'>;
export interface MoneyReviewChoice {outcome:'withdrawn'|'replaced';confirmCredit:boolean}
export interface LocalMoneyReview {
 id:string;version:1;revision:number;uploadId:string;entryId:string;commandIndex:number;identityHash:string;commandHash:string;
 packet:MoneyReviewRequest;phase:'preparing'|'review'|'deciding'|'unconfirmed'|'confirmed';
 quote:MoneyReviewQuote|null;quoteHash:string|null;choice:MoneyReviewChoice|null;
 attempts:(MoneyReviewChoice&{quoteHash:string;at:number})[];
 receipt:MoneyCommandReceipt|MoneyResolutionReceipt|null;
}
export const localMoneyReviewTableNames=['moneyReviews'] as const;
export async function moneyReviewQuoteHash(quote:MoneyReviewQuote):Promise<string>{
 const {at,expiresAt,...values}=quote;void at;void expiresAt;
 return syncHash(new TextEncoder().encode(syncDownloadToken(values)));
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
function choice(value:unknown):MoneyReviewChoice {
 if(!object(value)||!exact(value,'outcome,confirmCredit')||!['withdrawn','replaced'].includes(value.outcome as string)||typeof value.confirmCredit!=='boolean'||value.outcome==='withdrawn'&&value.confirmCredit)throw Error('Keep the explicit original financial choice.');
 return {outcome:value.outcome as MoneyReviewChoice['outcome'],confirmCredit:value.confirmCredit};
}
export function moneyReviewQuote(value:PreparedMoneyReview):MoneyReviewQuote {const {token,...quote}=value;void token;return structuredClone(quote);}
/** Display data only. No server token, Auth session or connection is durable. */
export function parseMoneyReviewQuote(value:unknown,packet:MoneyReviewRequest,commandHash:string):MoneyReviewQuote {
 if(!object(value)||'token'in value||value.commandHash!==commandHash)throw Error('Keep the original comparison without credentials.');
 return moneyReviewQuote(parsePreparedMoneyReview({...value,token:'x'.repeat(43)},packet));
}
export function parseLocalMoneyReview(value:unknown):LocalMoneyReview {
 if(!object(value)||!exact(value,'id,version,revision,uploadId,entryId,commandIndex,identityHash,commandHash,packet,phase,quote,quoteHash,choice,attempts,receipt')||value.version!==1||!hash(value.id)||!hash(value.identityHash)||!hash(value.commandHash)||!id(value.uploadId)||!id(value.entryId)||!Number.isSafeInteger(value.revision)||(value.revision as number)<0||!Number.isSafeInteger(value.commandIndex)||(value.commandIndex as number)<0||!['preparing','review','deciding','unconfirmed','confirmed'].includes(value.phase as string)||!Array.isArray(value.attempts))throw Error('Keep the complete original saved money review.');
 const packet=parseMoneyReviewRequest(value.packet,false),quote=value.quote===null?null:parseMoneyReviewQuote(value.quote,packet,value.commandHash),selected=value.choice===null?null:choice(value.choice);
 if((quote===null)!==(value.quoteHash===null)||value.quoteHash!==null&&!hash(value.quoteHash)||['review','deciding','unconfirmed'].includes(value.phase as string)&&!quote||['deciding','unconfirmed'].includes(value.phase as string)&&!selected||selected?.confirmCredit&&packet.command.type!=='sale.credit')throw Error('Keep the exact displayed financial values and choice.');
 const attempts=value.attempts.map(attempt=>{
  if(!object(attempt)||!exact(attempt,'outcome,confirmCredit,quoteHash,at')||!hash(attempt.quoteHash)||!Number.isSafeInteger(attempt.at)||(attempt.at as number)<0)throw Error('Keep every original financial review choice.');
  const selected=choice({outcome:attempt.outcome,confirmCredit:attempt.confirmCredit});if(selected.confirmCredit&&packet.command.type!=='sale.credit')throw Error('This action has no credit override.');
  return {...selected,quoteHash:attempt.quoteHash,at:attempt.at as number};
 });
 const receipt=value.receipt===null?null:object(value.receipt)&&value.receipt.type==='command.resolved'?parseMoneyResolutionReceipt(value.receipt,packet.command):parseMoneyCommandReceipt(value.receipt,packet.command);
 if((value.phase==='confirmed')!==(receipt!==null)||receipt?.type==='command.resolved'&&(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==value.commandHash))throw Error('A saved choice is not an actual source-bound server outcome.');
 return {...structuredClone(value),packet,quote,choice:selected,attempts,receipt} as unknown as LocalMoneyReview;
}
