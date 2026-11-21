import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {commandReviewHeader} from '@mise/core/command-resolution';
import {closingReviewBodyLimit as commandReviewBodyLimit,parseClosingReviewRequest,type ClosingReviewRequest,type ClosingReviewDecision} from '@mise/core/closing-review-source';
import {parsePreparedClosingReview,type PreparedClosingReview} from '@mise/core/closing-review-view';
import {parseClosingResolutionReceipt,parseSavedClosingReceipt,reviewedClosingProposal} from '@mise/core/closing-review';
import type {ShopCommandReceipt} from '@mise/core/shop-commands';
import {closingFingerprint} from '@mise/core/closing-replay';
import {createClosingReviewRequest,bindCommandReceipt,CommandRequestError,type CommandAccount} from './command-request';
export function createCloudClosingReviewRemote(input:CloudConnection,account:CommandAccount,expected:{businessId:string;outletId:string;actorId:string},send:typeof fetch=fetch){
 const config=parseCloudConnection(input),scope={...expected},read=createClosingReviewRequest(config,account,'read',send),resolve=createClosingReviewRequest(config,account,'resolve',send);
 async function result(value:unknown,packet:ClosingReviewRequest,guard:()=>void):Promise<ShopCommandReceipt>{
  const receipt=value&&typeof value==='object'&&'type'in value&&value.type==='command.resolved'?parseClosingResolutionReceipt(value,packet):parseSavedClosingReceipt(value,packet);
  if(receipt.type==='command.resolved'){
   if(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==await closingFingerprint(packet.command))throw new CommandRequestError('review');
   if(receipt.replacement&&receipt.replacement.commandHash!==await closingFingerprint(reviewedClosingProposal(packet.command,receipt.replacement.id,receipt.replacement.reviewJson)))throw new CommandRequestError('review');
  }
  guard();return bindCommandReceipt(receipt,guard);
 }
 function body(packet:ClosingReviewRequest){if(packet.command.outletId!==scope.outletId)throw new CommandRequestError('review');const text=JSON.stringify(packet);if(new TextEncoder().encode(text).length>commandReviewBodyLimit)throw new CommandRequestError('review');return text;}
 const headers=(packet:ClosingReviewRequest)=>({'Content-Type':'application/json',[commandReviewHeader]:packet.command.outletId});
 return {
  async prepare(value:ClosingReviewRequest,signal?:AbortSignal):Promise<{done:true;receipt:ShopCommandReceipt}|{done:false;review:PreparedClosingReview}>{
   const packet=parseClosingReviewRequest(JSON.parse(JSON.stringify(value)),false),response=await read(body(packet),headers(packet),120000,signal);
   try{
    const v=response.value;if(!v||typeof v!=='object')throw Error();
    if('done'in v&&v.done===true&&'receipt'in v&&Object.keys(v).sort().join(',')==='done,receipt')return {done:true,receipt:await result(v.receipt,packet,response.guard)};
    if(!('done'in v)||v.done!==false||!('review'in v)||Object.keys(v).sort().join(',')!=='done,review')throw Error();
    const review=parsePreparedClosingReview(v.review,packet);
    if(review.commandHash!==await closingFingerprint(packet.command)||[review.businessId,review.outletId,review.actorId].join(',')!==[scope.businessId,scope.outletId,scope.actorId].join(','))throw new CommandRequestError('review');
    response.guard();return {done:false,review:bindCommandReceipt(review,response.guard)};
   }catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  },
  async resolve(value:ClosingReviewDecision,signal?:AbortSignal):Promise<ShopCommandReceipt>{
   const packet=parseClosingReviewRequest(JSON.parse(JSON.stringify(value)),true),response=await resolve(body(packet),headers(packet),120000,signal);
   try{return await result(response.value,packet,response.guard);}catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  },
 };
}
