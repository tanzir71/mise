import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {commandReviewHeader,commandReviewBodyLimit,reviewedOrderProposal} from '@mise/core/command-resolution';
import {parseOrderReviewRequest,parsePreparedOrderReview,type OrderReviewRequest,type OrderReviewDecision,type PreparedOrderReview} from '@mise/core/order-review';
import {parseShopCommandReceipt,type ShopCommandReceipt} from '@mise/core/shop-commands';
import {orderFingerprint} from '@mise/core/order-replay';
import {createOrderReviewRequest,bindCommandReceipt,CommandRequestError,type CommandAccount} from './command-request';

export function createCloudOrderReviewRemote(input:CloudConnection,account:CommandAccount,expected:{businessId:string;outletId:string;actorId:string},send:typeof fetch=fetch){
 const config=parseCloudConnection(input),scope={...expected},read=createOrderReviewRequest(config,account,'read',send),resolve=createOrderReviewRequest(config,account,'resolve',send);
 async function result(value:unknown,packet:OrderReviewRequest,guard:()=>void):Promise<ShopCommandReceipt>{
  const receipt=parseShopCommandReceipt(value,packet.command);
  if(receipt.type==='command.resolved'){
   if(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==await orderFingerprint(packet.command))throw new CommandRequestError('review');
   if(receipt.replacement){const proposed=reviewedOrderProposal(packet.command,packet.command.type==='order.create'?null:receipt.replacement.revision,receipt.replacement.id);if(receipt.replacement.commandHash!==await orderFingerprint(proposed))throw new CommandRequestError('review');}
  }
  guard();return bindCommandReceipt(receipt,guard);
 }
 function body(packet:OrderReviewRequest){if(packet.command.outletId!==scope.outletId)throw new CommandRequestError('review');const text=JSON.stringify(packet);if(new TextEncoder().encode(text).length>commandReviewBodyLimit)throw new CommandRequestError('review');return text;}
 const headers=(packet:OrderReviewRequest)=>({'Content-Type':'application/json',[commandReviewHeader]:packet.command.outletId});
 return {
  async prepare(value:OrderReviewRequest,signal?:AbortSignal):Promise<{done:true;receipt:ShopCommandReceipt}|{done:false;review:PreparedOrderReview}>{
   const packet=parseOrderReviewRequest(JSON.parse(JSON.stringify(value)),false),response=await read(body(packet),headers(packet),120000,signal);
   try{
    const v=response.value;if(!v||typeof v!=='object')throw Error();
    if('done'in v&&v.done===true&&'receipt'in v&&Object.keys(v).sort().join(',')==='done,receipt')return {done:true,receipt:await result(v.receipt,packet,response.guard)};
    if(!('done'in v)||v.done!==false||!('review'in v)||Object.keys(v).sort().join(',')!=='done,review')throw Error();
    const review=parsePreparedOrderReview(v.review,packet,await orderFingerprint(packet.command),scope);response.guard();return {done:false,review:bindCommandReceipt(review,response.guard)};
   }catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  },
  async resolve(value:OrderReviewDecision,signal?:AbortSignal):Promise<ShopCommandReceipt>{
   const packet=parseOrderReviewRequest(JSON.parse(JSON.stringify(value)),true),response=await resolve(body(packet),headers(packet),120000,signal);
   try{return await result(response.value,packet,response.guard);}catch(error){if(error instanceof CommandRequestError)throw error;throw new CommandRequestError('retry');}
  }
 };
}
