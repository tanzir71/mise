import {deriveStaffPin} from './staff-pin.ts';

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
class BodyTooLarge extends Error {}
class BodyTimedOut extends Error {}
async function body(request:Request):Promise<unknown>{
  if(Number(request.headers.get('content-length')||0)>2048)throw new BodyTooLarge();
  const reader=request.body?.getReader();if(!reader)throw new Error('Missing body');
  const chunks:Uint8Array[]=[];let length=0,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BodyTimedOut()),5000);});
  try{while(true){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>2048)throw new BodyTooLarge();chunks.push(part.value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{clearTimeout(timer);reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function createDevicePinHandler(deps:{store:DevicePinStore;peppers:ReadonlyMap<string,Uint8Array>;origins:ReadonlySet<string>;newId?:()=>string;now?:()=>number}){
  // Copy secrets/config once; requests cannot alter another request's auth context.
  const peppers=new Map([...deps.peppers].map(([version,key])=>[version,new Uint8Array(key)])),origins=new Set(deps.origins),newId=deps.newId??deviceAuthId,now=deps.now??Date.now;
  return async(request:Request):Promise<Response>=>{
    const origin=request.headers.get('origin');
    const headers=new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','Vary':'Origin'});
    if(origin&&origins.has(origin))headers.set('Access-Control-Allow-Origin',origin);
    const reply=(status:number,value:unknown,extra:Record<string,string>={})=>{const result=new Headers(headers);for(const [k,v] of Object.entries(extra))result.set(k,v);return new Response(JSON.stringify(value),{status,headers:result});};
    if(origin&&!origins.has(origin))return reply(403,{error:'This origin is not allowed.'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:new Headers([...headers,['Access-Control-Allow-Methods','POST, OPTIONS'],['Access-Control-Allow-Headers','authorization, content-type, apikey']])});
    if(request.method!=='POST')return reply(405,{error:'Use POST.'},{Allow:'POST, OPTIONS'});
    const deviceToken=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if(!deviceToken)return reply(401,{error:'Check the device and PIN, then try again.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    let input:unknown;try{input=await body(request);}catch(error){return reply(error instanceof BodyTooLarge?413:error instanceof BodyTimedOut?408:400,{error:'Enter a member and four digits.'});}
    if(!object(input)||Object.keys(input).sort().join(',')!=='memberId,pin'||typeof input.memberId!=='string'||!ulid.test(input.memberId)||typeof input.pin!=='string'||!/^[0-9]{4}$/.test(input.pin))return reply(400,{error:'Enter a member and four digits.'});
    try{
      const attemptId=newId(),challenge=await deps.store.begin(attemptId,deviceToken,input.memberId);
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
