import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash,parseOperatorContext,parseOperatorPage,parseOperatorPosition,OperatorContextError,type OperatorContext,type OperatorPosition} from '@mise/core/operators';
/** Runtime original-JWT metadata reads. Never persist the UUID, key or JWT in an operator row. */
export function createOperatorRemote(input:CloudConnection,getAuth:()=>Promise<{jwt:string;userId:string}>,send:typeof fetch=fetch){
 const config=parseCloudConnection(input),root=new URL(config.apiUrl+'/');
 async function guarded<T>(run:()=>Promise<T>):Promise<T>{try{return await run();}catch(error){if(error instanceof OperatorContextError)throw error;throw new OperatorContextError('The outlet review is unconfirmed. Keep local work and try again.',error&&typeof error==='object'&&'kind'in error&&error.kind==='auth'?'auth':'retry');}}
 async function call(name:string,body:Record<string,unknown>,signal?:AbortSignal){
  signal?.throwIfAborted();const auth=await getAuth(),accountHash=await operatorAccountHash(auth.userId);signal?.throwIfAborted();
  if(typeof auth.jwt!=='string'||auth.jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth.jwt))throw new OperatorContextError('Verify your phone before choosing an outlet.','auth');
  let response:Response;try{response=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',headers:{apikey:config.publishableKey,Authorization:'Bearer '+auth.jwt,'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});}catch{throw new OperatorContextError('Outlet access is unconfirmed. Keep local work and try again.','retry');}
  if([401,403].includes(response.status))throw new OperatorContextError('Sign in with an account allowed to open this outlet.','auth');if(!response.ok)throw new OperatorContextError('Outlet access is unconfirmed. Keep local work and try again.','retry');
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??'')||Number(response.headers.get('Content-Length')??0)>1048576)throw new OperatorContextError('The outlet review is incomplete.');
  const reader=response.body?.getReader();if(!reader)throw new OperatorContextError('The outlet review is incomplete.');let bytes=0;const chunks:Uint8Array[]=[];
  try{while(true){signal?.throwIfAborted();const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1048576)throw new OperatorContextError('Read a smaller page of outlet choices.');chunks.push(part.value);}}catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const buffer=new Uint8Array(bytes);let at=0;for(const chunk of chunks){buffer.set(chunk,at);at+=chunk.length;}
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}catch{throw new OperatorContextError('The outlet review could not be verified.');}return {value,accountHash};
 }
 return {
  list(after:OperatorPosition|null=null,limit=50,signal?:AbortSignal){return guarded(async()=>{after=parseOperatorPosition(after);if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new OperatorContextError('Read between one and fifty outlet choices.');const {value,accountHash}=await call('operator_contexts',{p_after:after,p_limit:limit},signal);return parseOperatorPage(value,accountHash,after,limit);});},
  select(input:OperatorContext,signal?:AbortSignal){return guarded(async()=>{const selected=parseOperatorContext(input),{value,accountHash}=await call('operator_context',{p_business_id:selected.businessId,p_outlet_id:selected.outletId,p_actor_id:selected.actorId},signal),context=parseOperatorContext(value);if(context.accountHash!==accountHash||context.accountHash!==selected.accountHash||context.businessId!==selected.businessId||context.outletId!==selected.outletId||context.actorId!==selected.actorId)throw new OperatorContextError('The original account or member changed. Review access again.');return context;});}
 };
}
