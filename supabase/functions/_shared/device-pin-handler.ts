import {deriveStaffPin} from './staff-pin.ts';
import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';

export interface PinChallenge {allowed:true;attemptId:string;businessId:string;memberId:string;salt:string;pepperVersion:string;expiresAt:number}
export interface PinBackoff {allowed:false;retryAt:number}
export interface DeviceSession {id:string;token:string;deviceId:string;memberId:string;createdAt:number;expiresAt:number}
export interface DevicePinStore {
  begin(attemptId:string,deviceToken:string,memberId:string):Promise<unknown>;
  finish(deviceToken:string,attemptId:string,candidate:string,sessionId:string,eventId:string):Promise<unknown>;
}
const ulid=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/,secret=/^[A-Za-z0-9_-]{43}$/;
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
export function deviceAuthId(at=Date.now()):string{
  if(!time(at)||at>=281474976710656)throw new Error('Invalid server time.');
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let timestamp=BigInt(at),random=0n,prefix='',suffix='';
  for(const byte of crypto.getRandomValues(new Uint8Array(10)))random=(random<<8n)|BigInt(byte);
  for(let i=0;i<10;i++){prefix=alphabet[Number(timestamp&31n)]+prefix;timestamp>>=5n;}
  for(let i=0;i<16;i++){suffix=alphabet[Number(random&31n)]+suffix;random>>=5n;}
  return prefix+suffix;
}
export function createDevicePinHandler(deps:{store:DevicePinStore;peppers:ReadonlyMap<string,Uint8Array>;origins:ReadonlySet<string>;newId?:()=>string;now?:()=>number}){
  // Copy secrets/config once; requests cannot alter another request's auth context.
  const peppers=new Map([...deps.peppers].map(([version,key])=>[version,new Uint8Array(key)])),origins=new Set(deps.origins),newId=deps.newId??deviceAuthId,now=deps.now??Date.now;
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
    const deviceToken=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if(!deviceToken)return reply(401,{error:'Check the device and PIN, then try again.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    let input:unknown;try{input=await readAuthBody(request);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Enter a member and four digits.'});}
    if(!object(input)||!['memberId,pin','attemptId,memberId,pin'].includes(Object.keys(input).sort().join(','))||input.attemptId!==undefined&&(typeof input.attemptId!=='string'||!ulid.test(input.attemptId))||typeof input.memberId!=='string'||!ulid.test(input.memberId)||typeof input.pin!=='string'||!/^[0-9]{4}$/.test(input.pin))return reply(400,{error:'Enter a member and four digits.'});
    try{
      // A screen may durably choose its attempt ID before sending a PIN. A
      // concurrent reset can retire that ID even before this request reaches SQL.
      const attemptId=typeof input.attemptId==='string'?input.attemptId:newId(),challenge=await deps.store.begin(attemptId,deviceToken,input.memberId);
      if(challenge===null)return reply(401,{error:'Check the device and PIN, then try again.'});
      if(!object(challenge))throw new Error('Invalid verification response');
      if(challenge.allowed===false&&time(challenge.retryAt))return reply(429,{error:'Too many tries. Wait before trying again.',retryAt:challenge.retryAt},{'Retry-After':String(Math.max(1,Math.min(900,Math.ceil((challenge.retryAt-now())/1000))))});
      if(challenge.allowed!==true||challenge.attemptId!==attemptId||challenge.memberId!==input.memberId||typeof challenge.businessId!=='string'||!ulid.test(challenge.businessId)||typeof challenge.salt!=='string'||!/^[0-9a-f]{32}$/.test(challenge.salt)||typeof challenge.pepperVersion!=='string'||!time(challenge.expiresAt)||challenge.expiresAt<=now())throw new Error('Invalid verification response');
      const pepper=peppers.get(challenge.pepperVersion);if(!pepper)throw new Error('PIN secret unavailable');
      const candidate=await deriveStaffPin(input.pin,challenge.salt,{businessId:challenge.businessId,memberId:input.memberId},pepper);
      const sessionId=newId(),session=await deps.store.finish(deviceToken,attemptId,candidate,sessionId,newId());
      if(session===null)return reply(401,{error:'Check the device and PIN, then try again.'});
      if(!object(session)||session.id!==sessionId||session.memberId!==input.memberId||typeof session.deviceId!=='string'||!ulid.test(session.deviceId)||typeof session.token!=='string'||!secret.test(session.token)||!time(session.createdAt)||!time(session.expiresAt)||session.expiresAt-session.createdAt!==43200000||session.expiresAt<=now())throw new Error('Invalid session response');
      return reply(200,{session:{id:session.id,token:session.token,deviceId:session.deviceId,memberId:session.memberId,createdAt:session.createdAt,expiresAt:session.expiresAt}});
    }catch{return reply(503,{error:'Sign-in is unavailable. Ask the owner to check this device.'});}
  };
}
/** Server adapter: the service key stays in the apikey header, never a client response. */
export function createDevicePinStore(apiUrl:string,serviceKey:string,send:typeof fetch=fetch):DevicePinStore{
  const root=new URL(apiUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw new Error('Device sign-in is not configured.');
  async function rpc(name:string,args:Record<string,unknown>){
    const response=await send(new URL(`rest/v1/rpc/${name}`,root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify(args)});
    if(!response.ok)throw new Error('Device sign-in unavailable');return response.json();
  }
  return {begin:(attemptId,deviceToken,memberId)=>rpc('begin_staff_pin',{p_attempt_id:attemptId,p_device_token:deviceToken,p_member_id:memberId}),
    finish:(deviceToken,attemptId,candidate,sessionId,eventId)=>rpc('finish_staff_pin',{p_device_token:deviceToken,p_attempt_id:attemptId,p_candidate:candidate,p_session_id:sessionId,p_event_id:eventId})};
}
