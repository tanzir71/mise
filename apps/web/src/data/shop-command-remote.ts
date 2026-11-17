import {parseShopCommand,parseShopCommandReceipt,type ShopCommandReceipt} from '@mise/core/shop-commands';
/** Runtime public configuration only. No token or command is persisted here. */
export function createShopCommandRemote(apiUrl:string,publishableKey:string,getJwt:()=>Promise<string>,send:typeof fetch=fetch){
  let root:URL;
  try{root=new URL(apiUrl);if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw Error();}
  catch{throw new Error('Cloud commands are not configured.');}
  return {async apply(value:unknown,signal?:AbortSignal):Promise<ShopCommandReceipt>{
    // Serialize before asking for Auth: edits during refresh cannot alter this intent.
    const command=parseShopCommand(value),body=JSON.stringify(command);
    if(new TextEncoder().encode(body).byteLength>32000)throw new Error('This reviewed change is too large. Shorten its text before sending.');
    let jwt:string;try{jwt=await getJwt();}catch{throw new Error('Sign in again to send this change.');}
    if(jwt.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt))throw new Error('Sign in again to send this change.');
    let response:Response;
    try{const timeout=AbortSignal.timeout(45000);response=await send(new URL('functions/v1/commands',root),{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{apikey:publishableKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body});}
    catch{throw new Error('Changes are unavailable. Keep the local copy and retry with the same command ID.');}
    if(!response.ok)throw new Error(response.status===401?'Sign in again to send this change.':response.status===403?'This change is unavailable for this account.':response.status===409?'A newer or conflicting change needs review. Keep the local copy.':response.status===400?'Check the reviewed customer or catalogue details.':'Changes are unavailable. Keep the local copy and retry with the same command ID.');
    try{return parseShopCommandReceipt(await response.json(),command);}catch{throw new Error('The change is unconfirmed. Keep the local copy and retry with the same command ID.');}
  }};
}
