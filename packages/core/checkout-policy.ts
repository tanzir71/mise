import {marketPacks,type MarketCode} from './packs';
import {orderStatusLabels} from './orders';
import {parseCheckoutWallet,type CheckoutWallet} from './order-confirmation';
export interface CheckoutPolicyScope {businessId:string;outletId:string;orderId:string|null;actorId:string;actorRole:'owner'|'manager'}
export interface CheckoutPolicyContext extends CheckoutPolicyScope {
 v:1;serverAt:number;marketCode:MarketCode;settings:{revision:number;wallets:CheckoutWallet[]};
 order:null|{id:string;revision:number;status:string;currency:string;customerId:string|null;customerNameJson:string;
  ledger:null|{allowed:boolean;currency:string;balance:number;limit:number};
  credit:{revision:number;enabled:boolean;maximum:number;orderRevision:number|null}};
}
export interface CheckoutPolicyAction {
 v:1;id:string;kind:'wallets'|'credit';revision:number;orderId:string|null;orderRevision:number|null;
 wallets:CheckoutWallet[]|null;enabled:boolean|null;maximum:number|null;
}
type PolicyValue={revision:number;wallets:CheckoutWallet[]}|{revision:number;enabled:boolean;maximum:number;orderRevision:number};
export interface CheckoutPolicyOutcome {v:1;action:CheckoutPolicyAction;state:'pending'|'closed'|'applied';at:number|null;value:PolicyValue|null}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const int=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const bad=()=>Error('Keep the original wallet or khata setting and refresh access before trying again.');
function wallets(value:unknown):CheckoutWallet[]{if(!Array.isArray(value)||value.length>8)throw bad();const rows=value.map(parseCheckoutWallet);if(new Set(rows.map(w=>w.id)).size!==rows.length||new Set(rows.map(w=>w.name)).size!==rows.length)throw bad();return rows;}
export function parseCheckoutPolicyContext(value:unknown,scope:CheckoutPolicyScope):CheckoutPolicyContext {
 if(!object(value)||!exact(value,'v,serverAt,businessId,outletId,orderId,actorId,actorRole,marketCode,settings,order')||value.v!==1||!int(value.serverAt,0,8640000000000000)||Object.entries(scope).some(([k,v])=>value[k]!==v)||!Object.entries(scope).filter(([k,v])=>k!=='actorRole'&&v!==null).every(([,v])=>id(v))||typeof value.marketCode!=='string'||!Object.hasOwn(marketPacks,value.marketCode)||!object(value.settings)||!exact(value.settings,'revision,wallets')||!int(value.settings.revision))throw bad();
 const settings={revision:value.settings.revision,wallets:wallets(value.settings.wallets)};
 let order:CheckoutPolicyContext['order']=null;
 if(scope.orderId!==null){
  const o=value.order;if(!object(o)||!exact(o,'id,revision,status,currency,customerId,customerNameJson,ledger,credit')||o.id!==scope.orderId||!int(o.revision,1)||typeof o.status!=='string'||!Object.hasOwn(orderStatusLabels,o.status)||typeof o.currency!=='string'||!/^[A-Z]{3}$/.test(o.currency)||o.customerId!==null&&!id(o.customerId)||typeof o.customerNameJson!=='string'||o.customerNameJson.length>1024||typeof JSON.parse(o.customerNameJson)!=='string'||!object(o.credit)||!exact(o.credit,'revision,enabled,maximum,orderRevision')||!int(o.credit.revision)||typeof o.credit.enabled!=='boolean'||!int(o.credit.maximum)||o.credit.orderRevision!==null&&!int(o.credit.orderRevision,1))throw bad();
  let ledger:NonNullable<CheckoutPolicyContext['order']>['ledger']=null;
  if(o.ledger!==null){const l=o.ledger;if(!object(l)||!exact(l,'allowed,currency,balance,limit')||typeof l.allowed!=='boolean'||typeof l.currency!=='string'||!/^[A-Z]{3}$/.test(l.currency)||!int(l.balance,-Number.MAX_SAFE_INTEGER)||!int(l.limit))throw bad();ledger={allowed:l.allowed,currency:l.currency,balance:l.balance,limit:l.limit};}
  order={id:o.id as string,revision:o.revision,status:o.status,currency:o.currency,customerId:o.customerId as string|null,customerNameJson:o.customerNameJson,ledger,credit:{revision:o.credit.revision,enabled:o.credit.enabled,maximum:o.credit.maximum,orderRevision:o.credit.orderRevision as number|null}};
 }else if(value.order!==null)throw bad();
 return {...scope,v:1,serverAt:value.serverAt,marketCode:value.marketCode as MarketCode,settings,order};
}
export function parseCheckoutPolicyAction(value:unknown):CheckoutPolicyAction {
 if(!object(value)||!exact(value,'v,id,kind,revision,orderId,orderRevision,wallets,enabled,maximum')||value.v!==1||!id(value.id)||!['wallets','credit'].includes(value.kind as string)||!int(value.revision,0,Number.MAX_SAFE_INTEGER-1))throw bad();
 if(value.kind==='wallets'){
  if(value.orderId!==null||value.orderRevision!==null||value.enabled!==null||value.maximum!==null)throw bad();
  return {v:1,id:value.id,kind:'wallets',revision:value.revision,orderId:null,orderRevision:null,wallets:wallets(value.wallets),enabled:null,maximum:null};
 }
 if(!id(value.orderId)||!int(value.orderRevision,1)||value.wallets!==null||typeof value.enabled!=='boolean'||!int(value.maximum))throw bad();
 return {v:1,id:value.id,kind:'credit',revision:value.revision,orderId:value.orderId,orderRevision:value.orderRevision,wallets:null,enabled:value.enabled,maximum:value.maximum};
}
export function parseCheckoutPolicyOutcome(value:unknown,original:CheckoutPolicyAction):CheckoutPolicyOutcome {
 const action=parseCheckoutPolicyAction(original);
 if(!object(value)||!exact(value,'v,action,state,at,value')||value.v!==1||JSON.stringify(parseCheckoutPolicyAction(value.action))!==JSON.stringify(action)||!['pending','closed','applied'].includes(value.state as string))throw bad();
 if(value.state==='pending'||value.state==='closed'){
  if(value.value!==null||(value.state==='pending'?value.at!==null:!int(value.at,0,8640000000000000)))throw bad();
  return {v:1,action,state:value.state,at:value.at as number|null,value:null};
 }
 const result=value.value;if(!object(result)||!int(value.at,0,8640000000000000)||result.revision!==action.revision+1)throw bad();
 let approved:PolicyValue;
 if(action.kind==='wallets'){if(!exact(result,'revision,wallets')||JSON.stringify(wallets(result.wallets))!==JSON.stringify(action.wallets))throw bad();approved={revision:result.revision as number,wallets:wallets(result.wallets)};}
 else{if(!exact(result,'revision,enabled,maximum,orderRevision')||result.enabled!==action.enabled||result.maximum!==action.maximum||result.orderRevision!==action.orderRevision)throw bad();approved={revision:result.revision as number,enabled:result.enabled as boolean,maximum:result.maximum as number,orderRevision:result.orderRevision as number};}
 return {v:1,action,state:'applied',at:value.at,value:approved};
}
