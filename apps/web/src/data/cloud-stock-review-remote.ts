import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {commandReviewHeader} from '@mise/core/command-resolution';
import {stockReviewBodyLimit as commandReviewBodyLimit,parseStockReviewRequest,type StockReviewRequest,type StockReviewDecision} from '@mise/core/stock-review-source';
import {parsePreparedStockReview,type PreparedStockReview} from '@mise/core/stock-review-view';
import {parseStockResolutionReceipt,reviewedStockProposal} from '@mise/core/stock-review';
import {parseStockCommandReceipt} from '@mise/core/stock-commands';
import type {ShopCommandReceipt} from '@mise/core/shop-commands';
import {stockFingerprint} from '@mise/core/stock-replay';
import {createStockReviewRequest,bindCommandReceipt,CommandRequestError,type CommandAccount} from './command-request';
export function createCloudStockReviewRemote(input:CloudConnection,account:CommandAccount,expected:{businessId:string;outletId:string;actorId:string},send:typeof fetch=fetch){
 const config=parseCloudConnection(input),scope={...expected},read=createStockReviewRequest(config,account,'read',send),resolve=createStockReviewRequest(config,account,'resolve',send);
 async function result(value:unknown,packet:StockReviewRequest,guard:()=>void):Promise<ShopCommandReceipt>{
  const receipt=value&&typeof value==='object'&&'type'in value&&value.type==='command.resolved'?parseStockResolutionReceipt(value,packet.command):parseStockCommandReceipt(value,packet.command);
  if(receipt.type==='command.resolved'){
   if(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==await stockFingerprint(packet.command))throw new CommandRequestError('review');
   if(receipt.replacement&&receipt.replacement.commandHash!==await stockFingerprint(reviewedStockProposal(packet.command,receipt.replacement.id,receipt.replacement.revisions)))throw new CommandRequestError('review');
  }
  guard();return bindCommandReceipt(receipt,guard);
 }
 function body(packet:StockReviewRequest){if(packet.command.outletId!==scope.outletId)throw new CommandRequestError('review');const text=JSON.stringify(packet);if(new TextEncoder().encode(text).length>commandReviewBodyLimit)throw new CommandRequestError('review');return text;}
 const headers=(packet:StockReviewRequest)=>({'Content-Type':'application/json',[commandReviewHeader]:packet.command.outletId});
 return {
  async prepare(value:StockReviewRequest,signal?:AbortSignal):Promise<{done:true;receipt:ShopCommandReceipt}|{done:false;review:PreparedStockReview}>{
   const packet=parseStockReviewRequest(JSON.parse(JSON.stringify(value)),false),response=await read(body(packet),headers(packet),120000,signal);
   try{
    const v=response.value;if(!v||typeof v!=='object')throw Error();
    if('done'in v&&v.done===true&&'receipt'in v&&Object.keys(v).sort().join(',')==='done,receipt')return {done:true,receipt:await result(v.receipt,packet,response.guard)};
    if(!('done'in v)||v.done!==false||!('review'in v)||Object.keys(v).sort().join(',')!=='done,review')throw Error();
    const review=parsePreparedStockReview(v.review,packet);
    if(review.commandHash!==await stockFingerprint(packet.command)||[review.businessId,review.outletId,review.actorId].join(',')!==[scope.businessId,scope.outletId,scope.actorId].join(','))throw new CommandRequestError('review');
    response.guard();return {done:false,review:bindCommandReceipt(review,response.guard)};
   }catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  },
  async resolve(value:StockReviewDecision,signal?:AbortSignal):Promise<ShopCommandReceipt>{
   const packet=parseStockReviewRequest(JSON.parse(JSON.stringify(value)),true),response=await resolve(body(packet),headers(packet),120000,signal);
   try{return await result(response.value,packet,response.guard);}catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  },
 };
}
