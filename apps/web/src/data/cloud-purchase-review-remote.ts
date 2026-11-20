import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {commandReviewHeader,commandReviewBodyLimit} from '@mise/core/command-resolution';
import {parsePurchaseReviewRequest,parsePreparedPurchaseReview,parsePurchaseResolutionReceipt,reviewedPurchaseProposal,type PurchaseReviewRequest,type PurchaseReviewDecision,type PreparedPurchaseReview} from '@mise/core/purchase-review';
import {parsePurchaseCommandReceipt} from '@mise/core/purchase-commands';
import type {ShopCommandReceipt} from '@mise/core/shop-commands';
import {purchaseFingerprint} from '@mise/core/purchase-replay';
import {createPurchaseReviewRequest,bindCommandReceipt,CommandRequestError,type CommandAccount} from './command-request';
export function createCloudPurchaseReviewRemote(input:CloudConnection,account:CommandAccount,expected:{businessId:string;outletId:string;actorId:string},send:typeof fetch=fetch){
 const config=parseCloudConnection(input),scope={...expected},read=createPurchaseReviewRequest(config,account,'read',send),resolve=createPurchaseReviewRequest(config,account,'resolve',send);
 async function result(value:unknown,packet:PurchaseReviewRequest,guard:()=>void):Promise<ShopCommandReceipt>{
  const receipt=value&&typeof value==='object'&&'type'in value&&value.type==='command.resolved'?parsePurchaseResolutionReceipt(value,packet.command):parsePurchaseCommandReceipt(value,packet.command);
  if(receipt.type==='command.resolved'){
   if(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==await purchaseFingerprint(packet.command))throw new CommandRequestError('review');
   if(receipt.replacement&&receipt.replacement.commandHash!==await purchaseFingerprint(reviewedPurchaseProposal(packet.command,receipt.replacement.id)))throw new CommandRequestError('review');
  }
  guard();return bindCommandReceipt(receipt,guard);
 }
 function body(packet:PurchaseReviewRequest){if(packet.command.outletId!==scope.outletId)throw new CommandRequestError('review');const text=JSON.stringify(packet);if(new TextEncoder().encode(text).length>commandReviewBodyLimit)throw new CommandRequestError('review');return text;}
 const headers=(packet:PurchaseReviewRequest)=>({'Content-Type':'application/json',[commandReviewHeader]:packet.command.outletId});
 return {
  async prepare(value:PurchaseReviewRequest,signal?:AbortSignal):Promise<{done:true;receipt:ShopCommandReceipt}|{done:false;review:PreparedPurchaseReview}>{
   const packet=parsePurchaseReviewRequest(JSON.parse(JSON.stringify(value)),false),response=await read(body(packet),headers(packet),120000,signal);
   try{
    const v=response.value;if(!v||typeof v!=='object')throw Error();
    if('done'in v&&v.done===true&&'receipt'in v&&Object.keys(v).sort().join(',')==='done,receipt')return {done:true,receipt:await result(v.receipt,packet,response.guard)};
    if(!('done'in v)||v.done!==false||!('review'in v)||Object.keys(v).sort().join(',')!=='done,review')throw Error();
    const review=parsePreparedPurchaseReview(v.review,packet);
    if(review.commandHash!==await purchaseFingerprint(packet.command)||[review.businessId,review.outletId,review.actorId].join(',')!==[scope.businessId,scope.outletId,scope.actorId].join(','))throw new CommandRequestError('review');
    response.guard();return {done:false,review:bindCommandReceipt(review,response.guard)};
   }catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  },
  async resolve(value:PurchaseReviewDecision,signal?:AbortSignal):Promise<ShopCommandReceipt>{
   const packet=parsePurchaseReviewRequest(JSON.parse(JSON.stringify(value)),true),response=await resolve(body(packet),headers(packet),120000,signal);
   try{return await result(response.value,packet,response.guard);}catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  },
 };
}
