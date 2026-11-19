import {createClient,type Session} from '@supabase/supabase-js';
import {cloudAuthStorageKey,normalisePhoneCode,parseCloudConnection,type CloudConnection,type KeyStorage} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import {publishOperatorAuth} from './operator-auth';
import type {CommandAuthorization} from './command-request';
export interface PhoneAuthState {phase:'checking'|'signed-out'|'code'|'signed-in'|'offline'|'closed';phone:string|null;userId:string|null;message:string;busy:boolean;resendAt:number;persistent:boolean}
const initial:PhoneAuthState={phase:'checking',phone:null,userId:null,message:'',busy:false,resendAt:0,persistent:true};
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const phone=(v:unknown):v is string=>typeof v==='string'&&/^\+[1-9]\d{6,14}$/.test(v);
const token=(v:unknown):v is string=>typeof v==='string'&&v.length<=8192&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v);
const authMessage=(error:unknown,fallback:string)=>object(error)&&error.status===429?'Too many requests. Wait a minute before trying again.':fallback;
class PhoneAuthProblem extends Error {}
/** One project/shop scoped client. Session values never enter shop tables or backups. */
export async function createPhoneAuth(input:CloudConnection,scope:string,options:{storage:KeyStorage;send?:typeof fetch;now?:()=>number}){
 const config=parseCloudConnection(input),key=await cloudAuthStorageKey(config,scope),send=options.send??fetch,now=options.now??Date.now;
 let state=Object.freeze({...initial}),closed=false,memoryOnly=false,pendingPhone:string|null=null,verifiedToken:string|null=null,lastToken:string|null=null,checking:Promise<void>|null=null,working=false;
 const listeners=new Set<()=>void>(),memory=new Map<string,string>(),lifetime=new AbortController();
 let identityGeneration=0,authorizationGeneration=0,noticedAccount:string|null=null;
 const emit=(update:Partial<PhoneAuthState>)=>{if(closed&&update.phase!=='closed')return;const previous=state;state=Object.freeze({...state,...update});
  if(previous.phase!==state.phase||previous.userId!==state.userId){authorizationGeneration++;const generation=++identityGeneration;if(state.phase==='signed-in'&&state.userId){void operatorAccountHash(state.userId).then(hash=>{if(generation===identityGeneration&&!closed)publishOperatorAuth(key,hash);}).catch(()=>{if(generation===identityGeneration)publishOperatorAuth(key,null);});}else if(['signed-out','closed','code'].includes(state.phase))publishOperatorAuth(key,null);}
  for(const listener of listeners)listener();};
 const ensure=()=>{if(closed)throw new PhoneAuthProblem('This sign-in was closed. Open Sync setup again.');};
 const storage={getItem:(name:string)=>{if(closed)return null;if(memoryOnly)return memory.get(name)??null;try{const value=options.storage.getItem(name);if(value===null)memory.delete(name);else memory.set(name,value);return value;}catch{memoryOnly=true;emit({persistent:false});return memory.get(name)??null;}},setItem:(name:string,value:string)=>{if(closed)return;memory.set(name,value);if(memoryOnly)return;try{options.storage.setItem(name,value);}catch{memoryOnly=true;emit({persistent:false});}},removeItem:(name:string)=>{memory.delete(name);try{options.storage.removeItem(name);}catch{memoryOnly=true;emit({persistent:false});}}};
 try{const raw=storage.getItem(key+'.challenge'),saved=raw?JSON.parse(raw):null;if(object(saved)&&phone(saved.phone)&&typeof saved.sentAt==='number'&&Number.isSafeInteger(saved.sentAt)&&saved.sentAt<=now()+300000&&now()-saved.sentAt<=600000){pendingPhone=saved.phone;emit({phone:pendingPhone,resendAt:saved.sentAt+60000});}else if(raw)storage.removeItem(key+'.challenge');}catch{storage.removeItem(key+'.challenge');}
 const guardedFetch:typeof fetch=async(url,init)=>{ensure();const target=new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url);if(target.origin!==config.apiUrl||!target.pathname.startsWith('/auth/v1/'))throw new PhoneAuthProblem('Use the configured sign-in connection.');return send(url,{...init,redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.any([AbortSignal.timeout(15000),lifetime.signal,...(init?.signal?[init.signal]:[])])});};
 const client=createClient(config.apiUrl,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:key,storage},global:{fetch:guardedFetch}});
 async function inspectSession(){
  ensure();const {data,error}=await client.auth.getSession();ensure();
  if(error){emit({phase:'offline',message:'Connect to the internet to check your sign-in.'});return;}
  const session=data.session;
  if(!session){verifiedToken=null;lastToken=null;emit({phase:pendingPhone?'code':'signed-out',phone:pendingPhone,userId:null,message:''});return;}
  if(!token(session.access_token))throw new PhoneAuthProblem('Sign in again with your phone.');lastToken=session.access_token;
  if(verifiedToken===session.access_token&&state.phase==='signed-in')return;
  const result=await client.auth.getUser(session.access_token);ensure();
  if(result.error){verifiedToken=null;emit({phase:result.error.status===401||result.error.status===403?'signed-out':'offline',userId:null,phone:null,message:result.error.status===401||result.error.status===403?'Sign in again with your phone.':'Connect to the internet to check your sign-in.'});return;}
  const user=result.data.user,p=typeof user?.phone==='string'?'+'+user.phone.replace(/^\+/,''):null;
  if(!user||!phone(p)||!user.phone_confirmed_at||user.is_anonymous===true||user.id!==session.user.id||pendingPhone&&pendingPhone!==p){verifiedToken=null;emit({phase:'signed-out',userId:null,phone:null,message:'Use a verified phone account for Mise.'});return;}
  verifiedToken=session.access_token;pendingPhone=null;storage.removeItem(key+'.challenge');emit({phase:'signed-in',phone:p,userId:user.id,message:'Phone verified.',resendAt:0});
 }
 function check(){if(checking)return checking;checking=inspectSession().catch(()=>{if(!closed)emit({phase:'offline',message:'Connect to the internet to check your sign-in.'});}).finally(()=>{checking=null;});return checking;}
 const subscription=client.auth.onAuthStateChange((event,session)=>{if(closed)return;const account=session?.user.id??null;if(event==='SIGNED_OUT'||account!==noticedAccount)authorizationGeneration++;noticedAccount=account;if(event==='SIGNED_OUT'){verifiedToken=null;pendingPhone=null;emit({phase:'signed-out',phone:null,userId:null,message:'',resendAt:0});}else setTimeout(()=>{if(!closed)void check();},0);}).data.subscription;
 const storageChanged=(event:StorageEvent)=>{if(event.key===key||event.key===null){authorizationGeneration++;if(event.newValue===null){memory.delete(key);memory.delete(key+'-user');}verifiedToken=null;pendingPhone=null;void check();}};
 if(typeof window!=='undefined')window.addEventListener('storage',storageChanged);
 async function work(run:()=>Promise<void>){ensure();if(working)throw new PhoneAuthProblem('Wait for the current sign-in request.');working=true;emit({busy:true,message:''});try{await run();ensure();}catch(error){throw error instanceof PhoneAuthProblem?error:new PhoneAuthProblem('Phone sign-in could not finish. Keep your local copy and try again.');}finally{working=false;if(!closed)emit({busy:false});}}
 return {
  key,get closed(){return closed;},getSnapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},check,
  async sendCode(value:string){if(!phone(value))throw new PhoneAuthProblem('Enter a valid phone number.');if(state.phase==='signed-in')throw new PhoneAuthProblem('Sign out before using a different phone.');if(now()<state.resendAt)throw new PhoneAuthProblem('Wait a minute before requesting another code.');await work(async()=>{
   let settings:unknown;try{const response=await guardedFetch(new URL('auth/v1/settings',config.apiUrl+'/'),{headers:{apikey:config.publishableKey}});if(!response.ok)throw new PhoneAuthProblem();settings=await response.json();}catch{throw new PhoneAuthProblem('Could not check phone sign-in. Check the connection and try again.');}ensure();
   if(!object(settings)||!object(settings.external)||settings.external.phone!==true||settings.phone_autoconfirm===true)throw new PhoneAuthProblem('Phone sign-in is not ready for this connection. You can keep working on this device.');
   const result=await client.auth.signInWithOtp({phone:value,options:{channel:'sms',shouldCreateUser:true}});ensure();
   if(result.error){if(result.error.status===429)emit({resendAt:now()+60000});throw new PhoneAuthProblem(authMessage(result.error,'Could not send a code. Check the number and try again.'));}
   const sentAt=now();pendingPhone=value;storage.setItem(key+'.challenge',JSON.stringify({phone:value,sentAt}));emit({phase:'code',phone:value,userId:null,resendAt:sentAt+60000,message:'Code requested. Enter it when your SMS arrives.'});
  });},
  async verifyCode(value:string){const code=normalisePhoneCode(value),originalPhone=pendingPhone;if(!originalPhone)throw new PhoneAuthProblem('Request a code for your phone first.');await work(async()=>{const result=await client.auth.verifyOtp({phone:originalPhone,token:code,type:'sms'});ensure();if(result.error)throw new PhoneAuthProblem(authMessage(result.error,'The code was not accepted. Check it or request a new one.'));if(checking)await checking;await check();ensure();if(state.phase!=='signed-in')throw new PhoneAuthProblem(state.message||'Your phone sign-in could not be verified.');});},
  resetCode(){ensure();if(working||state.phase==='signed-in')return;pendingPhone=null;storage.removeItem(key+'.challenge');emit({phase:'signed-out',phone:null,userId:null,message:''});},
  async jwt(){ensure();const result=await client.auth.getSession();ensure();const session:Session|null=result.data.session;if(result.error||!session||!token(session.access_token))throw new PhoneAuthProblem('Sign in again to continue.');if(verifiedToken!==session.access_token)await check();ensure();if(state.phase!=='signed-in'||verifiedToken!==session.access_token)throw new PhoneAuthProblem('Verify your phone sign-in before continuing.');return session.access_token;},
  async commandAuthorization():Promise<CommandAuthorization>{
   try{
   ensure();await check();ensure();if(state.phase!=='signed-in'||!state.userId)throw new PhoneAuthProblem('Verify your phone sign-in before continuing.');
   const generation=authorizationGeneration,originalUser=state.userId,result=await client.auth.getSession();ensure();const session=result.data.session;
   if(result.error||!session||!token(session.access_token)||session.user.id!==originalUser)throw new PhoneAuthProblem('Sign in again with the original account.');
   const verified=await client.auth.getUser(session.access_token);ensure();const user=verified.data.user,p=typeof user?.phone==='string'?'+'+user.phone.replace(/^\+/,''):null;
   if(verified.error||!user||user.id!==originalUser||!phone(p)||!user.phone_confirmed_at||user.is_anonymous===true)throw new PhoneAuthProblem('Verify your phone sign-in before continuing.');
   const current=await client.auth.getSession();ensure();if(current.error||current.data.session?.access_token!==session.access_token||current.data.session.user.id!==originalUser||state.phase!=='signed-in'||state.userId!==originalUser||generation!==authorizationGeneration)throw new PhoneAuthProblem('The signed-in account changed. Keep the local action and retry.');
   return {jwt:session.access_token,userId:user.id,generation};
   }catch(error){throw error instanceof PhoneAuthProblem?error:new PhoneAuthProblem('Phone sign-in could not be verified. Keep the original local action.');}
  },
  assertCommandAuthorization(value:CommandAuthorization):void {
   ensure();if(state.phase!=='signed-in'||state.userId!==value.userId||authorizationGeneration!==value.generation)throw new PhoneAuthProblem('The signed-in account changed. Keep the local action unconfirmed.');
   let saved:unknown;try{const raw=storage.getItem(key);if(!raw||raw.length>32768)throw Error();saved=JSON.parse(raw);}catch{throw new PhoneAuthProblem('Review this device sign-in before confirming the action.');}
   if(!object(saved)||saved.access_token!==value.jwt||!object(saved.user)||saved.user.id!==value.userId)throw new PhoneAuthProblem('The signed-in account changed. Keep the local action unconfirmed.');
  },
  async close(forget=true){if(closed&&!forget)return;const wasClosed=closed;closed=true;const previous=lastToken;let removed=true;verifiedToken=null;pendingPhone=null;lifetime.abort();subscription.unsubscribe();if(typeof window!=='undefined')window.removeEventListener('storage',storageChanged);if(forget)for(const name of [key,key+'-user',key+'-code-verifier',key+'.challenge'])try{options.storage.removeItem(name);if(options.storage.getItem(name)!==null)removed=false;}catch{removed=false;}memory.clear();emit({phase:'closed',phone:null,userId:null,busy:false,message:removed?'Sign-in closed on this device.':'This browser could not remove its saved sign-in. Try again.',resendAt:0});if(!wasClosed)await client.auth.dispose();if(forget&&previous&&!wasClosed)try{await send(new URL('auth/v1/logout?scope=local',config.apiUrl+'/'),{method:'POST',redirect:'error',cache:'no-store',credentials:'omit',headers:{apikey:config.publishableKey,Authorization:'Bearer '+previous},signal:AbortSignal.timeout(5000)});}catch{/* Local credentials are already forgotten; offline shop data stays available. */}if(!removed)throw new PhoneAuthProblem('This browser could not remove its saved sign-in. Try again.');}
 };
}
export type PhoneAuth=Awaited<ReturnType<typeof createPhoneAuth>>;
let cached:{identity:string;value:Promise<PhoneAuth>}|null=null;
export function getPhoneAuth(config:CloudConnection,scope:string){const identity=JSON.stringify([parseCloudConnection(config),scope]);if(cached?.identity===identity)return cached.value;const previous=cached;const value=(async()=>{if(previous)await(await previous.value).close();return createPhoneAuth(config,scope,{storage:localStorage});})();cached={identity,value};return value;}
export async function forgetPhoneAuth(){const previous=cached;if(previous)await(await previous.value).close();if(cached===previous)cached=null;}
