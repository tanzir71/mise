import {createServer,type IncomingMessage} from 'node:http';
import {once} from 'node:events';
import {createStaffStockNativeFixture,stockTaskChoices} from '../staff-stock-native-fixture';
import {deviceId as id} from '../device-pairing-fixture';
import {newInboxId} from '../../packages/core/inbox';
import {deriveStaffPin} from '../../supabase/functions/_shared/staff-pin';
import type {ScreenState} from '../../packages/core/device-screen-state';
import {staffStockIntentHash,type StaffStockIntent,type StaffStockPrepared} from '../../packages/core/staff-stock-actions';
export async function startStaffStockService(){
 const f=await createStaffStockNativeFixture(process.cwd()),origin=process.env.MISE_E2E_ORIGIN||'http://127.0.0.1:4321',h=f.handlers(origin),stock=f.stockHandlers(origin);let lose=false,prepared:Extract<ScreenState,{phase:'signed-in'}>|null=null;
 const server=createServer(async(req:IncomingMessage,res)=>{try{
  const pieces:Buffer[]=[];let size=0;for await(const piece of req){const b=Buffer.from(piece);size+=b.length;if(size>64*1024*1024)throw Error('Fixture body too large');pieces.push(b);}
  const path=new URL(req.url??'/',apiUrl).pathname,headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
  const body=Buffer.concat(pieces),request=new Request(apiUrl+req.url,{method:req.method,headers,...(body.length?{body:new Uint8Array(body)}:{})});
  const response=path.endsWith('/staff-stock-actions')?await stock.actions(request):path.endsWith('/staff-stock')?await stock.read(request):path.endsWith('/staff-device')?await h.staff(request):path.endsWith('/device-pin')?await h.pin(request):await h.access(request);
  if(lose&&path.endsWith('/staff-stock-actions')&&body.length&&JSON.parse(body.toString()).operation==='commit'){lose=false;req.socket.destroy();return;}
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"Fixture unavailable"}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const apiUrl='http://127.0.0.1:'+(server.address() as {port:number}).port;
 async function prepare(mode:'normal'|'thousand'|'large'='normal'){
  await f.seed();lose=false;await f.configure(id(105),{name:'Karim Uddin',role:'kitchen',permissions:stockTaskChoices});await f.configure(id(104),{name:'Jamal Mia',role:'rider'});await f.stock(mode==='thousand'?1000:mode==='large'?1:6);
  if(mode==='normal')for(const [i,name,unit,onHand,target,category]of [[0,'Chicken','kg',14,20,'Meat'],[1,'Basmati rice','kg',38,50,'Dry goods'],[2,'Yogurt','kg',3,8,'Dairy'],[3,'Mustard oil','L',19,12,'Oil'],[4,'Potatoes','kg',25,20,'Vegetables'],[5,'Borhani mix','L',6,10,'Dry goods']] as const){await f.db.query('update public.stock_items set name=$1::json,name_local=$2::json,unit=$3::json,on_hand=$4,target=$5,low_at=$5,category=$6::json where id=$7',[JSON.stringify(name),JSON.stringify(i===0?'মুরগি':''),JSON.stringify(unit),onHand,target,JSON.stringify(category),id(301+i)]);}
  if(mode==='large')await f.db.query('update public.stock_items set name=$1::json,unit=$2::json where id=$3',[JSON.stringify('ন'.repeat(1000000)),JSON.stringify('\ud800'.repeat(1000000)),id(301)]);
  const {pairing}=await f.start(),claim=await f.request(pairing.code,pairing.id),device=await f.approve(pairing.id,claim),outcome=await f.poll(claim) as {outletNameJson:string};
  const attemptId=newInboxId(),c=await f.asRole<{salt:string;businessId:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[attemptId,claim.secret,id(105)]),proof=await deriveStaffPin('0042',c.salt,{businessId:c.businessId,memberId:id(105)},f.pepper),session=await f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[claim.secret,attemptId,proof,newInboxId(),newInboxId()]);
  prepared={phase:'signed-in',credential:{v:1,connection:{apiUrl,publishableKey:'sb_publishable_test_only'},device,token:claim.secret},outletNameJson:outcome.outletNameJson,attemptId,session} as Extract<ScreenState,{phase:'signed-in'}>;return prepared;
 }
 return {apiUrl,prepare,loseNextCommit(){lose=true;},async choices(enabled:boolean,methods=['order_phone'] as ('order_phone')[]){await f.configure(id(105),{permissions:{...stockTaskChoices,updateStock:enabled},methods});},async inspect(){return {...await f.quantities(),financial:(await f.db.query<{n:number}>('select ((select count(*) from public.sales)+(select count(*) from public.credit_entries))::integer n')).rows[0].n};},
  async delayedCommit(intent:StaffStockIntent,quote:StaffStockPrepared){if(!prepared)throw Error();return f.asRole(null,'service_role','select public.finish_staff_stock_action($1,$2,$3,$4,$5,$6) data',[prepared.credential.token,prepared.session.token,quote.review.id,quote.token,quote.reviewHash,await staffStockIntentHash(intent)]);},
  async storedHash(){return (await f.db.query<{source_hash:string}>('select source_hash from private.staff_stock_receipts order by command_id limit 1')).rows[0]?.source_hash??null;},
  async denyAllWork(){await f.configure(id(105),{permissions:{...stockTaskChoices,updateStock:false},methods:[]});await f.db.query('update public.members set permissions=$1::jsonb where id=$2',[JSON.stringify({'orders.read':false,'orders.acknowledge':false,'orders.ready':false}),id(105)]);},
  async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await f.db.close();}};
}
