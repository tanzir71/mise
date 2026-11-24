import {createServer,type IncomingMessage} from 'node:http';
import {once} from 'node:events';
import {createStaffDeviceFixture} from '../staff-device-fixture';
import {deviceId} from '../device-pairing-fixture';
import {newInboxId} from '../../packages/core/inbox';
import {parseStaffOwnerAction,parseStaffOwnerContext} from '../../packages/core/staff-protocol';
import {deriveStaffPin} from '../../supabase/functions/_shared/staff-pin';
import type {AttendanceIntent} from '../../packages/core/staff-attendance';
import type {ScreenState} from '../../packages/core/device-screen-state';
export async function startStaffDeviceService(){
 const f=await createStaffDeviceFixture(process.cwd()),origins=process.env.MISE_E2E_ORIGIN||'http://127.0.0.1:4321',h=f.handlers(origins);let lose=false,prepared:ScreenState|null=null;
 const server=createServer(async(req:IncomingMessage,res)=>{try{
  const pieces:Buffer[]=[];let size=0;for await(const piece of req){const b=Buffer.from(piece);size+=b.length;if(size>8192)throw Error('Fixture body too large');pieces.push(b);}
  const path=new URL(req.url??'/',apiUrl).pathname,headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
  const body=Buffer.concat(pieces),request=new Request(apiUrl+req.url,{method:req.method,headers,...(body.length?{body:new Uint8Array(body)}:{})});
  const response=path.endsWith('/staff-device')?await h.staff(request):path.endsWith('/device-pin')?await h.pin(request):await h.access(request);
  if(lose&&path.endsWith('/staff-device')&&body.length&&JSON.parse(body.toString()).operation==='submit'){lose=false;req.socket.destroy();return;}
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"Fixture unavailable"}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const apiUrl='http://127.0.0.1:'+(server.address() as {port:number}).port;
 async function log(memberId:string,type:'in'|'out'='in'){
  const c=parseStaffOwnerContext(await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[f.scope.outletId,memberId]),f.scope,memberId),checkIn={v:1,id:newInboxId(),eventId:newInboxId(),memberId,outletId:f.scope.outletId,type,occurredAt:Date.now(),expectedLastId:c.latest?.id??null};
  const action=parseStaffOwnerAction({...f.scope,v:1,id:newInboxId(),eventId:checkIn.eventId,memberId,kind:'check-in',expected:c.current,latest:c.latest,draft:null,checkIn});await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[f.scope.outletId,JSON.stringify(action),'submit']);
 }
 async function prepare(signed=false){await f.seed();lose=false;
  await f.configure(deviceId(102),{name:'Mitu',role:'manager',station:'Order desk'});await f.configure(deviceId(104),{name:'Jamal Mia',role:'rider'});await f.configure(deviceId(105),{name:'Karim Uddin',nameLocal:'করিম উদ্দিন',role:'kitchen'});
  await f.configure(deviceId(111),{name:'Nadia Akter',role:'staff',station:'Counter'});await f.configure(deviceId(112),{name:'Tanvir',role:'rider',shift:{days:[0,1,2,3,4,5,6],start:1438,end:1439}});await f.configure(deviceId(113),{name:'Jewel',role:'kitchen',shift:{days:[0,1,2,3,4,5,6],start:0,end:1439}});
  for(const id of [102,104,111])await log(deviceId(id));if(signed)await log(deviceId(105));
  const {pairing}=await f.start(),claim=await f.request(pairing.code,pairing.id),device=await f.approve(pairing.id,claim),outcome=await f.poll(claim) as {outletNameJson:string};
  const credential={v:1 as const,connection:{apiUrl,publishableKey:'sb_publishable_test_only'},device,token:claim.secret};
  prepared={phase:'enrolled',credential,outletNameJson:outcome.outletNameJson};
  if(signed){const attemptId=newInboxId(),c=await f.asRole<{salt:string;businessId:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[attemptId,claim.secret,deviceId(105)]),proof=await deriveStaffPin('0042',c.salt,{businessId:c.businessId,memberId:deviceId(105)},f.pepper);
   const session=await f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[claim.secret,attemptId,proof,newInboxId(),newInboxId()]);prepared={phase:'signed-in',credential,outletNameJson:outcome.outletNameJson,attemptId,session} as ScreenState;
  }return prepared;
 }
 return {apiUrl,prepare,loseNextSubmit(){lose=true;},async disableMethod(){await f.configure(deviceId(105),{methods:[]});},async manualArrival(){await log(deviceId(113));},async submitOriginal(intent:AttendanceIntent){if(!prepared||prepared.phase!=='signed-in')throw Error('No signed fixture');return f.asRole(null,'service_role','select public.visit_staff_device($1,$2,$3,$4,null,600) data',[prepared.credential.token,prepared.session.token,'submit',JSON.stringify(intent)]);},
  async inspect(){const counts=(await f.db.query<{data:{checkIns:number;originals:number;financial:number}}> ('select json_build_object(\'checkIns\',(select count(*)::int from public.check_ins),\'originals\',(select count(*)::int from private.staff_device_actions),\'financial\',(select count(*)::int from public.sales)+(select count(*)::int from public.credit_entries)) data')).rows[0].data;return counts;},
  async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await f.db.close();}};
}
