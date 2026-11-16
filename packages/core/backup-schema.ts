import { businessPacks, marketPacks } from './packs';
import { stockAtoms } from './stock-quantity';
import { ORDER_SOURCE_MAX_TEXT } from './order-limits';
import type { BackupTable } from './backup-tables';

type Check = (value:unknown,path:string) => void;
type Shape = Record<string,Check>;
function invalid(path:string,detail:string):never {throw new Error(`Invalid backup: ${path} ${detail}.`);}
export function backupRecord(value:unknown,path:string):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(path,'must be an object');
  return value as Record<string,unknown>;
}
const text:Check = (v,p) => {if (typeof v !== 'string' || v.length > 1_000_000) invalid(p,'must be text within 1,000,000 characters');};
const orderSource:Check=(v,p)=>{if(typeof v!=='string'||v.length>ORDER_SOURCE_MAX_TEXT)invalid(p,'must be a request within 12,000 characters');};
const id:Check = (v,p) => {if (typeof v !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v)) invalid(p,'must be a ULID');};
const bool:Check = (v,p) => {if (typeof v !== 'boolean') invalid(p,'must be true or false');};
const integer:Check = (v,p) => {if (typeof v !== 'number' || !Number.isSafeInteger(v)) invalid(p,'must be a safe integer');};
export const backupTime:Check = (v,p) => {integer(v,p);if ((v as number) < 0 || (v as number) > 253402300799999) invalid(p,'must be a UTC timestamp before year 10000');};
const money:Check = (v,p) => {integer(v,p);if ((v as number) < 0) invalid(p,'must be non-negative');};
const positive:Check = (v,p) => {money(v,p);if (v === 0) invalid(p,'must be positive');};
const number:Check = (v,p) => {if (typeof v !== 'number' || !Number.isFinite(v)) invalid(p,'must be a finite number');};
const quantity:Check = (v,p) => {number(v,p);try {stockAtoms(v as number);} catch {invalid(p,'must be a non-negative quantity with up to three decimals');}};
const signedQuantity:Check = (v,p) => {number(v,p);try {stockAtoms(v as number,true);} catch {invalid(p,'must be a quantity with up to three decimals');}};
const phone:Check = (v,p) => {if (typeof v !== 'string' || !/^\+[1-9]\d{6,14}$/.test(v)) invalid(p,'must be an E.164 phone number');};
const currency:Check = (v,p) => {if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) invalid(p,'must be a three-letter currency');};
const timezone:Check = (v,p) => {text(v,p);try {new Intl.DateTimeFormat('en',{timeZone:v as string});} catch {invalid(p,'must be a valid timezone');}};
const day:Check = (v,p) => {if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0,10) !== v) invalid(p,'must be a calendar date');};
const optional = (check:Check):Check => (v,p) => {if (v !== undefined) check(v,p);};
const nullable = (check:Check):Check => (v,p) => {if (v !== null) check(v,p);};
const oneOf = (values:readonly unknown[]):Check => (v,p) => {if (!values.includes(v)) invalid(p,'has an unsupported value');};
const array = (check:Check):Check => (v,p) => {if (!Array.isArray(v)) invalid(p,'must be a list');v.forEach((entry,i) => check(entry,`${p}[${i}]`));};
export const backupObject = (shape:Shape):Check => (value,path) => {
  const row = backupRecord(value,path);
  for (const key of Object.keys(row)) if (!Object.hasOwn(shape,key)) invalid(`${path}.${key}`,'is not supported by this schema');
  for (const [key,check] of Object.entries(shape)) check(row[key],`${path}.${key}`);
};
function jsonValue(value:unknown,path:string,depth = 0):void {
  if (depth > 64) invalid(path,'is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {number(value,path);return;}
  if (Array.isArray(value)) {value.forEach((v,i) => jsonValue(v,`${path}[${i}]`,depth+1));return;}
  const object = backupRecord(value,path);
  for (const [key,v] of Object.entries(object)) {if (['__proto__','constructor','prototype'].includes(key)) invalid(path,'contains an unsafe property');jsonValue(v,`${path}.${key}`,depth+1);}
}
const entity:Shape = {id,createdAt:backupTime,updatedAt:backupTime};
const owned:Shape = {...entity,outletId:id};
const dated:Shape = {createdBy:id,eventId:id};
const revision:Shape = {revision:positive};
const voided:Shape = {voidedAt:optional(backupTime)};
const payment = oneOf(['cash','wallet','card']);
const saleMethod = oneOf(['cash','wallet','card','credit']);
const business = oneOf(Object.keys(businessPacks));
const status = oneOf(['new','confirmed','kitchen_seen','cooking','ready','out','delivered','to_confirm','packed','booked','with_courier','returning','returned','ordered','making','ready_called','collected','requested','priced','accepted','packing','delivering','done','cancelled']);
const tone = oneOf(['gentle','direct']);
const messages = backupObject({en:text,bn:text});
const messaging = backupObject({paymentNote:text,templates:backupObject({gentle:messages,direct:messages})});
const saleLine = backupObject({itemId:optional(id),name:text,unit:text,unitPrice:money,qty:number,lineTotal:money});
const summary = backupObject({
  day,timezone,currency,shopName:text,outletName:text,sales:money,saleCount:money,orderCount:money,creditGiven:money,creditCollected:integer,
  cashSales:money,cashCollections:money,cashRefunds:money,expectedCash:integer,split:array(backupObject({method:saleMethod,amount:money,count:money})),
  completedOrders:money,averageTimeMs:nullable(number),waitingOrders:money,lowStock:money,dueReminders:money,
});
const shapes:Record<BackupTable,Shape> = {
  businesses:{...entity,name:text,businessType:business,marketCode:oneOf(Object.keys(marketPacks)),languages:array(oneOf(['en','bn']))},
  outlets:{...entity,businessId:id,name:text,address:text,timezone,currency,shopLink:optional(text),creditMessaging:optional(messaging),orderWarningMinutes:optional(positive)},
  members:{...entity,businessId:id,outletIds:array(id),name:text,phone,role:oneOf(['owner']),active:bool},
  categories:{...owned,name:text,sort:integer},
  items:{...owned,name:text,nameLocal:text,categoryId:id,price:money,unit:text,available:bool,isSample:bool,oftenBought:optional(bool)},
  events:{id,outletId:id,customerId:optional(id),orderId:optional(id),orderRevision:optional(positive),stockItemId:optional(id),stockRevision:optional(positive),supplierId:optional(id),closingId:optional(id),actor:backupObject({type:oneOf(['member','system','agent']),id:text}),command:text,before:jsonValue,after:jsonValue,at:backupTime,undoOf:optional(id)},
  sales:{...owned,...dated,...voided,orderId:optional(id),orderNumber:optional(text),closingId:optional(id),deliveryFee:optional(money),discount:optional(money),expression:text,amount:positive,currency,method:saleMethod,methodName:text,given:optional(money),change:optional(money),who:text,customerId:optional(id),creditAccountId:optional(id),items:array(saleLine),shopName:text,shopLink:optional(text),timezone,voidReason:optional(oneOf(['undo','order-cancel']))},
  customers:{...entity,businessId:id,name:text,nickname:text,phone:optional(phone),address:text,notes:text,tags:array(text),consent:backupObject({savedAt:backupTime,source:oneOf(['manual'])}),archivedAt:optional(backupTime)},
  creditAccounts:{...owned,customerId:id,currency,allowed:bool,limit:money,reminder:backupObject({enabled:bool,dayOfMonth:positive,tone,channel:oneOf(['whatsapp'])})},
  creditEntries:{...owned,...dated,accountId:id,customerId:id,currency,sequence:positive,type:oneOf(['charge','payment','adjustment','reminder','refund']),amount:integer,note:text,saleId:optional(id),orderId:optional(id),refundId:optional(id),returnsChargeId:optional(id),methodName:optional(text),occurredAt:optional(backupTime),reversalOf:optional(id),purpose:optional(oneOf(['reminder','receipt','call'])),overLimit:optional(backupObject({balance:integer,limit:money}))},
  orders:{...owned,...dated,...revision,businessType:business,sequence:positive,number:text,source:oneOf(['phone','walk_in','table','paste','other']),sourceText:orderSource,customer:backupObject({id:optional(id),name:text,phone:optional(phone)}),type:oneOf(['delivery','pickup','dine_in']),status,statusChangedAt:backupTime,statusEventId:id,
    lines:array(backupObject({id,itemId:optional(id),name:text,unit:text,qty:number,unitPrice:nullable(money),lineTotal:nullable(money),note:text,unavailable:bool,substitution:optional(backupObject({from:text,accepted:bool,acceptedAt:optional(backupTime)}))})),subtotal:money,deliveryFee:money,discount:money,total:nullable(money),currency,timezone,address:text,table:text,scheduledFor:optional(backupTime),
    payment:backupObject({method:saleMethod,wallet:optional(text),status:oneOf(['pending','paid','credited']),saleId:optional(id),at:optional(backupTime),cancellation:optional(backupObject({creditEntryId:optional(id),refundTotal:money,refundDue:money}))}),handledBy:text},
  orderNotes:{...owned,...dated,...revision,orderId:id,text},
  orderCommunications:{...owned,...dated,...revision,orderId:id,purpose:oneOf(['quote','message','call']),channel:oneOf(['whatsapp','manual','call']),text},
  orderRefunds:{...owned,...dated,...voided,orderId:id,saleId:id,customerId:optional(id),accountId:optional(id),amount:positive,currency,method:payment,methodName:text,note:text,creditEntryId:optional(id)},
  stockItems:{...owned,...revision,name:text,nameLocal:text,activeKey:optional(text),unit:text,category:text,aliases:array(text),onHand:quantity,target:quantity,packSize:quantity,lowAt:quantity,supplierId:optional(id),archivedAt:optional(backupTime),lastCountedAt:optional(backupTime),eventId:id},
  stockMoves:{...owned,...dated,...revision,stockItemId:id,name:text,unit:text,before:quantity,after:quantity,delta:signedQuantity,reason:oneOf(['used','received','count','waste','undo']),source:oneOf(['manual','quick_update','count']),note:text,countBatchId:optional(id),undoOf:optional(id)},
  suppliers:{...owned,...revision,name:text,phone:optional(phone),note:text,archivedAt:optional(backupTime),eventId:id},
  supplierMessages:{...owned,...dated,...voided,supplierId:optional(id),supplierName:text,phone:optional(phone),text,channel:oneOf(['whatsapp','manual']),stockItemIds:array(id),part:positive,parts:positive},
  dayClosings:{...owned,...dated,...voided,activeKey:optional(text),day,timezone,currency,summary,countedCash:money,expectedCash:integer,difference:integer,addedWalkIn:money,addedSaleId:optional(id),note:text,previewFingerprint:text,createdByName:text},
  purchases:{...owned,...dated,...voided,supplierId:optional(id),supplierName:text,reference:text,lines:array(backupObject({stockItemId:optional(id),name:text,unit:text,qty:number,unitPrice:money,lineTotal:money})),total:money,currency,timezone,paid:oneOf(['cash','wallet','card','due']),methodName:text,note:text,photoRef:optional(text)},
};
export function validateBackupRow(table:BackupTable,value:unknown,path:string) {
  backupObject(shapes[table])(value,path);
}
