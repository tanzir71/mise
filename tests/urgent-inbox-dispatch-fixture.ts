import {readFileSync} from 'node:fs';
import {createECDH,randomBytes,randomUUID,createHmac} from 'node:crypto';
import {generateRequestDetails,generateVAPIDKeys} from 'web-push';
import {vi} from 'vitest';
import {createPairingDatabase,deviceId,deviceUid} from './device-pairing-fixture';
import {newKitchenId} from '../packages/core/kitchen';
import {createOwnerTaskIntent,changeOwnerTaskIntent,parseOwnerTaskReceipt,type OwnerTask} from '../packages/core/owner-tasks';
import {parseUrgentInboxConsent,type UrgentInboxNotice} from '../packages/core/urgent-inbox';
import {createUrgentInboxPushStore,createUrgentInboxPushHandler} from '../supabase/functions/_shared/urgent-inbox-push-handler';
import {createUrgentInboxPushSender} from '../supabase/functions/_shared/urgent-inbox-push-sender';
import {createUrgentInboxNotificationsHandler,createUrgentInboxNotificationsStore} from '../supabase/functions/_shared/urgent-inbox-notifications-handler';
export async function urgentInboxDispatchFixture(){
 const f=await createPairingDatabase(undefined,true);await f.db.exec(readFileSync(new URL('./fixtures/kitchen-dispatch-platform.sql',import.meta.url),'utf8'));
 const key='C'.repeat(43),configId=deviceUid(811),keyId=deviceUid(812),vapid={subject:'https://desk.test/contact',...generateVAPIDKeys()},browser=createECDH('prime256v1');browser.generateKeys();const auth=randomBytes(16);
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/urgent-inbox-synthetic-only',expirationTime:null,keys:{p256dh:browser.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}};
 let tail=Promise.resolve();const serial=<T>(work:()=>Promise<T>)=>{const result=tail.then(work);tail=result.then(()=>{},()=>{});return result;};
 const serviceNames=new Set(['claim_urgent_inbox_dispatch','prepare_urgent_inbox_push','claim_urgent_inbox_push','finish_urgent_inbox_push']),ownerNames=new Set(['desk_push_context','register_urgent_inbox','inspect_urgent_inbox','read_urgent_inbox','withdraw_urgent_inbox','read_urgent_inbox_target']);
 const rpcImplementation:typeof fetch=async(url,init)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!,headers=new Headers(init?.headers),service=serviceNames.has(name),n=Number(headers.get('authorization')?.match(/^Bearer phone\.([1-5])\.signature$/)?.[1]);
  if(!(service&&headers.get('apikey')==='sb_secret_test_only'&&!headers.has('authorization')||ownerNames.has(name)&&headers.get('apikey')==='sb_publishable_test_only'&&n>=1&&n<=5))throw Error('Unexpected fixture RPC');
  const body=JSON.parse(String(init?.body)),keys=Object.keys(body);if(keys.some(k=>!/^p_[a-z0-9_]+$/.test(k)))throw Error('Unexpected named argument');
  try{return Response.json(await serial(()=>f.asRole(service?null:n,service?'service_role':'authenticated',`select public.${name}(${keys.map((k,i)=>k+'=> $'+(i+1)).join(',')}) data`,Object.values(body))));}
  catch(error){const code=(error as {code?:string}).code;return Response.json({error:'Private SQL failure'},{status:code==='42501'?403:code==='PT429'?429:code==='PT409'||code==='23505'?409:400});}
 };
 const rpc=vi.fn(rpcImplementation);
 const packets:{request:Request;at:number}[]=[],capture:typeof fetch=async(url,init)=>{packets.push({request:new Request(url,init),at:Date.now()});return new Response(null,{status:201});},transport=vi.fn(capture);
 const store=createUrgentInboxPushStore('https://rpc.test','sb_secret_test_only',rpc),send=createUrgentInboxPushSender(generateRequestDetails,vapid,transport),handler=createUrgentInboxPushHandler({key,applicationKey:vapid.publicKey,store,send});
 const ownerStore=createUrgentInboxNotificationsStore('https://rpc.test','sb_publishable_test_only',rpc);
 const owner=(input:unknown,n=1,enabled=true,applicationKey:string|undefined=vapid.publicKey)=>createUrgentInboxNotificationsHandler({store:ownerStore,origins:new Set(['https://desk.test']),enabled,applicationKey})(new Request('https://rpc.test/functions/v1/urgent-inbox-notifications',{method:'POST',headers:{origin:'https://desk.test',authorization:'Bearer phone.'+n+'.signature','Content-Type':'application/json'},body:JSON.stringify(input)}));
 const admin=<T=unknown>(query:string,args:unknown[]=[])=>serial(async()=>(await f.db.query<{data:T}>(query,args)).rows[0]?.data);
 async function reset(){await tail;await f.seed();await f.db.exec("truncate cron.job,net.http_request_queue,net._http_response,vault.secrets,private.urgent_inbox_dispatch_grants,private.owner_task_actions;update private.urgent_inbox_dispatch_state set enabled=false,revision=0,config_secret=null,key_secret=null,next_at=0,request_id=null,queued_at=null,signature=null,failures=0,outcome='not-configured';alter role anon nologin;grant all on all tables in schema net,cron to public;grant execute on all functions in schema net,cron to public;revoke all on vault.secrets,vault.decrypted_secrets from public,anon,authenticated,service_role;");await f.db.query('insert into vault.secrets(id,secret) values($1,$2),($3,$4)',[configId,JSON.stringify({apiUrl:'https://worker.test'}),keyId,key]);packets.length=0;rpc.mockReset().mockImplementation(rpcImplementation);transport.mockReset().mockImplementation(capture);}
 async function register(){const id=newKitchenId();await serial(()=>f.asRole(1,'authenticated','select public.register_desk_push($1,$2,$3,$4,$5,$6,$7,$8) data',[id,deviceId(11),subscription.endpoint,subscription.keys.p256dh,subscription.keys.auth,vapid.publicKey,null,newKitchenId()]));return id;}
 async function consent(subscriptionId:string){const id=newKitchenId(),eventId=newKitchenId(),response=await owner({action:'register',id,subscriptionId,eventId});if(!response.ok)throw Error('Consent fixture rejected');return {id,eventId,value:parseUrgentInboxConsent(await response.json())};}
 const scope={v:1 as const,businessId:deviceId(1),outletId:deviceId(11),memberId:deviceId(101),role:'owner' as const};
 async function task(urgent=true){const intent=createOwnerTaskIntent(scope,{kind:'failure',mode:'check',title:'Check this actual task',body:'PRIVATE CUSTOMER SOURCE বাংলা',urgent});return parseOwnerTaskReceipt(await serial(()=>f.asRole(1,'authenticated','select public.act_owner_task($1,$2,$3) data',[scope.outletId,'submit',JSON.stringify(intent)])),intent).after!;}
 async function resolve(t:OwnerTask){const intent=changeOwnerTaskIntent(scope,t,'fixed');return serial(()=>f.asRole(1,'authenticated','select public.act_owner_task($1,$2,$3) data',[scope.outletId,'submit',JSON.stringify(intent)]));}
 const configure=(enabled=true)=>admin('select private.configure_urgent_inbox_dispatch($1,$2,$3) data',[enabled,enabled?configId:null,enabled?keyId:null]);
 const dispatch=()=>admin<{state:string}>('select private.dispatch_urgent_inbox_work() data');
 async function queued(){return serial(async()=>(await f.db.query<{id:number;url:string;headers:Record<string,string>;body:Uint8Array;timeout_milliseconds:number}>('select * from net.http_request_queue order by id limit 1')).rows[0]);}
 async function bridge(){const row=await queued();if(!row)throw Error('No committed synthetic request');const response=await handler(new Request(row.url,{method:'POST',headers:row.headers,body:row.body as BodyInit}));await serial(()=>f.db.query('delete from net.http_request_queue where id=$1',[row.id]));return response;}
 async function request(limit=25,patch:{at?:number;nonce?:string;key?:string;purpose?:string;grant?:boolean}={}){const at=patch.at??Date.now(),nonce=patch.nonce??randomUUID();if(patch.grant!==false)await admin('insert into private.urgent_inbox_dispatch_grants select $1::uuid,revision,$2::bigint,$3::integer,$2::bigint+60000,null from private.urgent_inbox_dispatch_state where id',[nonce,at,limit]);const mac=createHmac('sha256',patch.key??key).update((patch.purpose??'mise:urgent-inbox:v1')+'\n'+at+'\n'+nonce+'\n'+limit).digest('hex');return new Request('https://worker.test/functions/v1/urgent-inbox-push',{method:'POST',headers:{authorization:`Bearer v1.${at}.${nonce}.${mac}`,'Content-Type':'application/json'},body:JSON.stringify({limit})});}
 const target=(notice:UrgentInboxNotice)=>owner({action:'target',notice});
 return {...f,key,configId,keyId,vapid,browser,auth,subscription,rpc,transport,packets,store,send,handler,owner,ownerStore,admin,reset,register,consent,task,resolve,configure,dispatch,queued,bridge,request,target};
}
