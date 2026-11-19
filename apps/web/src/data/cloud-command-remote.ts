import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {parseShopCommand,parseShopCommandReceipt,type ShopCommand,type ShopCommandReceipt} from '@mise/core/shop-commands';
import {stockBatchHeader,stockBatchBodyLimit} from '@mise/core/stock-commands';
import {purchaseBodyHeader,purchaseBodyLimit} from '@mise/core/purchase-commands';
import {orderBodyHeader,orderBodyLimit} from '@mise/core/order-commands';
import {handoffBodyHeader,handoffBodyLimit} from '@mise/core/handoff-commands';
import {inboxBodyHeader,inboxBodyLimit} from '@mise/core/inbox-commands';
import {linkBodyHeader,linkBodyLimit} from '@mise/core/link-commands';
import {createCommandRequest,bindCommandReceipt,CommandRequestError,type CommandAccount} from './command-request';

export {CommandRequestError as CloudCommandError} from './command-request';
/** Only domain intents leave the device. Recovery row changes are never a write API. */
export function createCloudCommandRemote(input:CloudConnection,account:CommandAccount,send:typeof fetch=fetch){
 const config=parseCloudConnection(input),request=createCommandRequest(config,account,send);
 return async(value:ShopCommand,signal?:AbortSignal):Promise<ShopCommandReceipt>=>{
  // Canonicalize and freeze caller-owned inputs before waiting for Auth.
  const command=parseShopCommand(JSON.parse(JSON.stringify(parseShopCommand(value)))),body=JSON.stringify(command),headers:Record<string,string>={apikey:config.publishableKey,'Content-Type':'application/json'};
  let maximum=32000,deadline=45000;
  if(command.type==='stock.batch'){headers[stockBatchHeader]=command.outletId;maximum=stockBatchBodyLimit;deadline=120000;}
  else if(command.type==='purchase.record'){headers[purchaseBodyHeader]=command.outletId;maximum=purchaseBodyLimit;deadline=120000;}
  else if(command.type==='order.create'||command.type==='order.update'){headers[orderBodyHeader]=command.outletId;maximum=orderBodyLimit;deadline=120000;}
  else if(command.type==='handoff.prepare'||command.type==='supplier-message.record'){headers[handoffBodyHeader]=command.outletId;maximum=handoffBodyLimit;deadline=120000;}
  else if(command.type==='inbox.capture'){headers[inboxBodyHeader]=command.outletId;maximum=inboxBodyLimit;deadline=120000;}
  else if(command.type==='shopLink.generate'){headers[linkBodyHeader]=command.outletId;maximum=linkBodyLimit;deadline=120000;}
  if(new TextEncoder().encode(body).byteLength>maximum)throw new CommandRequestError('review');
  const responseValue=await request(body,headers,deadline,signal);
  try{return bindCommandReceipt(parseShopCommandReceipt(responseValue.value,command),responseValue.guard);}catch{throw new CommandRequestError('retry');}
 };
}
