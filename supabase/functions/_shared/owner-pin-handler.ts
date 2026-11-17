import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {deviceAuthId} from './device-pin-handler.ts';
import {createStaffPin,type PinCredential} from './staff-pin.ts';
export class OwnerPinDenied extends Error {constructor(readonly status:401|403=403){super('PIN administration is not authorized.');}}
export interface OwnerPinStore {
  context(jwt:string,outletId:string,memberId:string,action:'set'|'clear'):Promise<unknown>;
  set(jwt:string,outletId:string,memberId:string,eventId:string,credential:PinCredential):Promise<unknown>;
  clear(jwt:string,outletId:string,memberId:string,eventId:string):Promise<unknown>;
}
const ulid=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export function createOwnerPinHandler(deps:{store:OwnerPinStore;pepper?:Uint8Array;origins:ReadonlySet<string>;newId?:()=>string}){
  const pepper=deps.pepper?new Uint8Array(deps.pepper):undefined,origins=new Set(deps.origins),newId=deps.newId??deviceAuthId;
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
    const header=request.headers.get('authorization')||'',jwt=header.length<=8192?header.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
    if(!jwt)return reply(401,{error:'Sign in again to manage staff PINs.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    let input:unknown;try{input=await readAuthBody(request);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the PIN request.'});}
    if(!object(input)||(input.action!=='set'&&input.action!=='clear')||typeof input.outletId!=='string'||!ulid.test(input.outletId)||typeof input.memberId!=='string'||!ulid.test(input.memberId))return reply(400,{error:'Choose a staff member and PIN action.'});
    const expected=input.action==='set'?'action,memberId,outletId,pin':'action,memberId,outletId';
    if(Object.keys(input).sort().join(',')!==expected||(input.action==='set'&&(typeof input.pin!=='string'||!/^[0-9]{4}$/.test(input.pin))))return reply(400,{error:'Check the PIN request.'});
    try{
      const context=await deps.store.context(jwt,input.outletId,input.memberId,input.action);
      if(!object(context)||context.outletId!==input.outletId||context.memberId!==input.memberId||typeof context.businessId!=='string'||!ulid.test(context.businessId)||typeof context.configured!=='boolean')throw new Error('Invalid PIN context');
      const eventId=newId();
      if(input.action==='clear'){
        const result=await deps.store.clear(jwt,input.outletId,input.memberId,eventId);
        if(!object(result)||result.memberId!==input.memberId||result.cleared!==true)throw new Error('Invalid PIN removal result');
        return reply(200,{memberId:result.memberId,cleared:true});
      }
      if(!pepper)throw new Error('PIN secret unavailable');
      const credential=await createStaffPin(input.pin as string,{businessId:context.businessId,memberId:input.memberId},pepper);
      const result=await deps.store.set(jwt,input.outletId,input.memberId,eventId,credential);
      if(!object(result)||result.memberId!==input.memberId||result.revision!==eventId||typeof result.changedAt!=='number'||!Number.isSafeInteger(result.changedAt)||result.changedAt<0||result.changedAt>8640000000000000)throw new Error('Invalid PIN update result');
      return reply(200,{memberId:result.memberId,revision:result.revision,changedAt:result.changedAt});
    }catch(error){return error instanceof OwnerPinDenied?reply(error.status,{error:'Only the shop owner can manage this PIN.'}):reply(503,{error:'PIN settings are unavailable. Try again later.'});}
  };
}
/** Forward the caller's JWT per request; never substitute the service identity. */
export function createOwnerPinStore(apiUrl:string,publishableKey:string,send:typeof fetch=fetch):OwnerPinStore{
  const root=new URL(apiUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw new Error('PIN administration is not configured.');
  async function rpc(jwt:string,name:string,args:Record<string,unknown>){
    const response=await send(new URL(`rest/v1/rpc/${name}`,root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{apikey:publishableKey,Authorization:`Bearer ${jwt}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
    if(response.status===401||response.status===403)throw new OwnerPinDenied(response.status);
    if(!response.ok)throw new Error('PIN administration unavailable');return response.json();
  }
  return {context:(jwt,outletId,memberId,action)=>rpc(jwt,'staff_pin_context',{p_outlet_id:outletId,p_member_id:memberId,p_action:action}),
    set:(jwt,outletId,memberId,eventId,c)=>rpc(jwt,'set_staff_pin',{p_outlet_id:outletId,p_member_id:memberId,p_event_id:eventId,p_salt:c.salt,p_verifier:c.verifier,p_pepper_version:c.pepperVersion}),
    clear:(jwt,outletId,memberId,eventId)=>rpc(jwt,'clear_staff_pin',{p_outlet_id:outletId,p_member_id:memberId,p_event_id:eventId})};
}
