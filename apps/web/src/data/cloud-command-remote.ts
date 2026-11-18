import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {parseShopCommand,parseShopCommandReceipt,type ShopCommand,type ShopCommandReceipt} from '@mise/core/shop-commands';
import {stockBatchHeader,stockBatchBodyLimit} from '@mise/core/stock-commands';
import {purchaseBodyHeader,purchaseBodyLimit} from '@mise/core/purchase-commands';
import {orderBodyHeader,orderBodyLimit} from '@mise/core/order-commands';
import {handoffBodyHeader,handoffBodyLimit} from '@mise/core/handoff-commands';
import {inboxBodyHeader,inboxBodyLimit} from '@mise/core/inbox-commands';
import {linkBodyHeader,linkBodyLimit} from '@mise/core/link-commands';

export class CloudCommandError extends Error {constructor(readonly kind:'auth'|'review'|'retry',message:string){super(message);}}
/** Only domain intents leave the device. Recovery row changes are never a write API. */
export function createCloudCommandRemote(input:CloudConnection,getJwt:()=>Promise<string>,send:typeof fetch=fetch){
 const config=parseCloudConnection(input),root=new URL(config.apiUrl+'/');
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
  if(new TextEncoder().encode(body).byteLength>maximum)throw new CloudCommandError('review','This saved action is too large. Keep the local copy and review it.');
  signal?.throwIfAborted();const jwt=await getJwt();signal?.throwIfAborted();
  if(typeof jwt!=='string'||jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt))throw new CloudCommandError('auth','Verify your phone before sending local changes.');
  headers.Authorization='Bearer '+jwt;
  let response:Response;try{response=await send(new URL('functions/v1/commands',root),{method:'POST',headers,body,redirect:'error',cache:'no-store',credentials:'omit',signal:signal?AbortSignal.any([AbortSignal.timeout(deadline),signal]):AbortSignal.timeout(deadline)});}catch{throw new CloudCommandError('retry','The action could not be confirmed. Keep its original ID and try again.');}
  if(response.status===401||response.status===403)throw new CloudCommandError('auth','Sign in with an account allowed to change this shop.');
  if([400,409,413,415].includes(response.status))throw new CloudCommandError('review','Review this saved action before retrying. Keep the local copy and its original ID.');
  if(!response.ok)throw new CloudCommandError('retry','The action could not be confirmed. Keep its original ID and try again.');
  try{return parseShopCommandReceipt(await response.json(),command);}catch{throw new CloudCommandError('retry','The action receipt could not be confirmed. Keep its original ID and try again.');}
 };
}
