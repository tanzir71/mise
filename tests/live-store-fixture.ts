import {deviceId} from './device-pairing-fixture';
import {customerKhataFixture} from './customer-khata-fixture';
import {decodeCommandRecord,encodeCommandRecord} from '../packages/core/cloud-records';
import {recordSaleCommand} from '../packages/core/sales';
import {saveOrderCommand} from '../packages/core/orders';
import type {Business,Outlet,Member,SetupSnapshot} from '../packages/core/models';
import {parseLivePage,type LivePeriod} from '../packages/core/live-store';
export async function liveStoreFixture(root?:string){
 const f=await customerKhataFixture(root);let setup:SetupSnapshot;
 const load=async<T>(table:'businesses'|'outlets'|'members',id:string)=>decodeCommandRecord(table,(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(t) data from public.'+table+' t where id=$1',[id])).rows[0].data) as unknown as T;
 async function seed(){await f.seed();await f.db.query('insert into public.outlets(id,business_id,name,timezone,currency,created_at,updated_at) values($1,$2,\'"Third outlet"\',\'Asia/Dhaka\',\'BDT\',1,1)',[deviceId(13),deviceId(1)]);setup={business:await load<Business>('businesses',deviceId(1)),outlet:await load<Outlet>('outlets',deviceId(11)),owner:await load<Member>('members',deviceId(101))};}
 async function insert(table:'sales'|'orders'|'events',value:unknown,business=setup.business.id,executor:Pick<typeof f.db,'query'>=f.db){const r=encodeCommandRecord(table,value as never,business),keys=Object.keys(r.values);await executor.query('insert into public.'+r.table+'('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(r.values));}
 async function sale(expression='100',outlet=11,currency='BDT',at=Date.now()-1000){const branch={...setup,outlet:{...setup.outlet,id:deviceId(outlet),currency}},command=recordSaleCommand({expression,method:'cash'},{setup:branch,items:[],wallets:[]},at);await f.db.transaction(async sql=>{await insert('sales',command.sale,setup.business.id,sql);await insert('events',command.event,setup.business.id,sql);});return command.sale;}
 async function order(outlet=11,at=Date.now()-1000,patch:Parameters<typeof saveOrderCommand>[0]|null=null){const branch={...setup,outlet:{...setup.outlet,id:deviceId(outlet)}},command=saveOrderCommand(patch??{source:'phone',sourceText:'Literal customer text',name:'Synthetic customer',phone:'',type:'pickup',address:'',table:'',lines:[{name:'Rice',unit:'kg',qty:1,unitPrice:10000}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup:branch,items:[],sequence:1},null,0,at);await f.db.transaction(async sql=>{await insert('orders',command.order,setup.business.id,sql);await insert('events',command.event,setup.business.id,sql);});return command.order;}
 const readRaw=(n=1,all=false,outlet=11,period:LivePeriod='today',after:string|null=null)=>f.asRole(n,'authenticated','select public.read_live_store($1,$2,$3,$4) data',[deviceId(outlet),all,period,after]);
 const read=async(n=1,all=false,outlet=11,period:LivePeriod='today',after:string|null=null)=>parseLivePage(await readRaw(n,all,outlet,period,after),{businessId:deviceId(1),anchorId:deviceId(outlet),actorId:deviceId(n===1?101:n===2?102:103),actorRole:n===1?'owner':'manager'},{allOutlets:all,period,after});
 return {...f,khata:f,seed,sale,order,insert,readRaw,read,get setup(){return setup;}};
}
