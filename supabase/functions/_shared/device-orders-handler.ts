import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
export interface OrderCursor {createdAt:number;id:string}
export interface DeviceOrdersStore {read(device:string,session:string,after:OrderCursor|null,limit:number):Promise<unknown>}
const ulid=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/,secret=/^[A-Za-z0-9_-]{43}$/;
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
function text(v:unknown):string {if(typeof v!=='string')throw new Error('Invalid text');return v;}
function integer(v:unknown,min=0,max=8640000000000000):number {if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error('Invalid integer');return v;}
function id(v:unknown){const s=text(v);if(!ulid.test(s))throw new Error('Invalid ID');return s;}
function literal(v:unknown){const s=text(v);text(JSON.parse(s));return s;}
function boolean(v:unknown){if(typeof v!=='boolean')throw new Error('Invalid boolean');return v;}
function cursor(v:unknown):OrderCursor|null {if(v===null)return null;if(!record(v)||Object.keys(v).sort().join(',')!=='createdAt,id')throw new Error('Invalid cursor');return {createdAt:integer(v.createdAt),id:id(v.id)};}
function lines(value:unknown,prices:boolean){
  const parsed:unknown=JSON.parse(text(value));if(!Array.isArray(parsed)||parsed.length<1||parsed.length>200)throw new Error('Invalid lines');
  return JSON.stringify(parsed.map((line:unknown)=>{
    if(!record(line)||typeof line.qty!=='number'||!Number.isFinite(line.qty)||line.qty<=0||line.qty>999999)throw new Error('Invalid line');
    let swap:Record<string,unknown>|null=null;
    if(line.substitution!=null){if(!record(line.substitution))throw new Error('Invalid swap');swap={from:text(line.substitution.from),accepted:boolean(line.substitution.accepted)};if(line.substitution.acceptedAt!==undefined)swap.acceptedAt=integer(line.substitution.acceptedAt);}
    return {id:id(line.id),...(line.itemId==null?{}:{itemId:id(line.itemId)}),name:text(line.name),unit:text(line.unit),qty:line.qty,
      note:text(line.note),unavailable:boolean(line.unavailable),substitution:swap,
      ...(prices?{unitPrice:line.unitPrice===null?null:integer(line.unitPrice,0,Number.MAX_SAFE_INTEGER),lineTotal:line.lineTotal===null?null:integer(line.lineTotal,0,Number.MAX_SAFE_INTEGER)}:{})};
  }));
}
/** Build every response field explicitly. Original text remains inert data. */
export function projectDeviceOrders(value:unknown,limit:number){
  if(!record(value)||value.v!==1||(value.mode!=='counter'&&value.mode!=='kitchen')||!Array.isArray(value.permissions)||!value.permissions.every(p=>typeof p==='string')||!value.permissions.includes('orders.read')||!Array.isArray(value.orders)||value.orders.length>limit)throw new Error('Invalid order page');
  const prices=value.mode==='counter';
  return {v:1,businessId:id(value.businessId),outletId:id(value.outletId),mode:value.mode,permissions:value.permissions,
    outletNameJson:literal(value.outletNameJson),currency:text(value.currency),timezone:text(value.timezone),orderWarningMinutes:value.orderWarningMinutes===null?null:integer(value.orderWarningMinutes,1,1440),
    orders:value.orders.map((o:unknown)=>{
      if(!record(o))throw new Error('Invalid order');
      return {id:id(o.id),number:text(o.number),businessType:text(o.businessType),type:text(o.type),source:text(o.source),status:text(o.status),
        statusChangedAt:integer(o.statusChangedAt),scheduledFor:o.scheduledFor===null?null:integer(o.scheduledFor),createdAt:integer(o.createdAt),updatedAt:integer(o.updatedAt),revision:integer(o.revision,1,Number.MAX_SAFE_INTEGER),
        timezone:text(o.timezone),tableJson:literal(o.tableJson),linesJson:lines(o.linesJson,prices),
        ...(prices?{customerNameJson:literal(o.customerNameJson),currency:text(o.currency),subtotal:integer(o.subtotal,0,Number.MAX_SAFE_INTEGER),deliveryFee:integer(o.deliveryFee,0,Number.MAX_SAFE_INTEGER),discount:integer(o.discount,0,Number.MAX_SAFE_INTEGER),total:o.total===null?null:integer(o.total,0,Number.MAX_SAFE_INTEGER),paymentStatusJson:literal(o.paymentStatusJson),paymentMethodJson:literal(o.paymentMethodJson)}:{})};
    }),next:cursor(value.next)};
}
export function createDeviceOrdersHandler(deps:{store:DeviceOrdersStore;origins:ReadonlySet<string>}){
  const origins=new Set(deps.origins);
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
    const device=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if(!device)return reply(401,{error:'Sign in on this screen again.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    let input:unknown;try{input=await readAuthBody(request);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the order request.'});}
    let after:OrderCursor|null,limit:number;
    try{if(!record(input)||Object.keys(input).some(k=>!['sessionToken','after','limit'].includes(k))||typeof input.sessionToken!=='string'||!secret.test(input.sessionToken))throw new Error('Invalid request');after=cursor(input.after??null);limit=integer(input.limit===undefined?50:input.limit,1,100);}catch{return reply(400,{error:'Check the order request.'});}
    try{const result=await deps.store.read(device,(input as Record<string,unknown>).sessionToken as string,after,limit);if(result===null)return reply(401,{error:'Sign in on this screen again.'});return reply(200,projectDeviceOrders(result,limit));}
    catch{return reply(503,{error:'Orders are unavailable. Try again later.'});}
  };
}
export function createDeviceOrdersStore(apiUrl:string,serviceKey:string,send:typeof fetch=fetch):DeviceOrdersStore{
  const root=new URL(apiUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw new Error('Orders are not configured.');
  return {read:async(device,session,after,limit)=>{
    const response=await send(new URL('rest/v1/rpc/read_device_orders',root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify({p_device_token:device,p_session_token:session,p_after_time:after?.createdAt??null,p_after_id:after?.id??null,p_limit:limit})});
    if(!response.ok)throw new Error('Orders unavailable');return response.json();
  }};
}
