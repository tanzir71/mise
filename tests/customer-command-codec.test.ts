import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {parseCustomerCommand,parseCustomerCommandReceipt,customerFingerprint,type CustomerCommand,type CustomerCommandReceipt} from '../packages/core/customer-commands';
import {parseShopCommand,parseShopCommandReceipt} from '../packages/core/shop-commands';
import {customerFingerprint as existingFingerprintExport} from '../packages/core/customer-replay';

const id=(n:number)=>String(n).padStart(26,'0');
const ids={accountId:id(4),accountEventId:id(5),openingEntryId:id(6),openingEventId:id(7)};
const profile={name:'  ক্রেতা\0\ud800 ',nickname:'Saved',phone:'',address:' Original road ',notes:'Original\nnotes',tags:[' tea ','tea']};
const terms={allowed:true,limit:50000,reminder:{enabled:true,dayOfMonth:15,tone:'gentle' as const,channel:'whatsapp' as const}};
const commands:CustomerCommand[]=[
 {id:id(1),customerId:id(2),outletId:id(3),type:'customer.create',input:profile,credit:terms,opening:{amount:2300,occurredAt:2000},ids},
 {id:id(1),customerId:id(2),outletId:id(3),type:'customer.create',input:profile,credit:null,opening:null,ids},
 {id:id(1),customerId:id(2),outletId:id(3),type:'customer.update',input:profile,credit:terms,opening:null,ids},
 {id:id(1),customerId:id(2),outletId:id(3),type:'customer.update',input:profile,credit:null,opening:null,ids},
 {id:id(1),customerId:id(2),outletId:id(3),type:'khata.settings',accountId:id(4),input:terms,ids},
 {id:id(1),customerId:id(2),outletId:id(3),type:'khata.settings',accountId:null,input:terms,ids},
 {id:id(1),customerId:id(2),outletId:id(3),type:'customer.archive'},
 {id:id(1),customerId:id(2),outletId:id(3),type:'customer.restore'},
];
const reversed=(v:unknown):unknown=>Array.isArray(v)?v.map(reversed):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,value])=>[k,reversed(value)])):v;
it.each(commands)('preserves the established wire order and fingerprint for $type',async command=>{
 const wire=JSON.stringify(command),expected=createHash('sha256').update(wire).digest('hex'),parsed=parseCustomerCommand(reversed(command));
 expect(JSON.stringify(parsed)).toBe(wire);expect(JSON.stringify(parseShopCommand(reversed(command)))).toBe(wire);
 expect(await customerFingerprint(parsed)).toBe(expected);expect(await existingFingerprintExport(parsed)).toBe(expected);
});
it.each(commands)('keeps the ordinary $type receipt contract and strips unrelated fields',command=>{
 const status=command.type==='customer.archive'||command.type==='customer.restore',opening='opening'in command&&command.opening!==null,metadata=command.type==='customer.update'&&command.credit===null&&command.opening===null;
 const receipt:CustomerCommandReceipt={id:command.id,type:command.type,customerId:command.customerId,outletId:command.outletId,accountId:status?null:ids.accountId,accountEventId:status||metadata?null:command.type==='khata.settings'?command.id:ids.accountEventId,entryId:opening?ids.openingEntryId:null,openingEventId:opening?ids.openingEventId:null,at:5000,customerUpdatedAt:5000,accountUpdatedAt:status?null:metadata?4000:5000};
 const raw={...reversed(receipt) as object,unrelated:'discard'};
 expect(JSON.stringify(parseCustomerCommandReceipt(raw,command))).toBe(JSON.stringify(receipt));expect(parseShopCommandReceipt(raw,command)).toEqual(receipt);
 expect(()=>parseCustomerCommandReceipt({...raw,outletId:id(9)},command)).toThrow();
 if(!status)expect(()=>parseCustomerCommandReceipt({...raw,accountId:id(9)},command)).toThrow();
});
it('retains strict reserved IDs, opening amounts and exact fields',()=>{
 const c=commands[0];expect(()=>parseCustomerCommand({...c,unexpected:true})).toThrow();
 expect(()=>parseCustomerCommand({...c,ids:{...ids,accountEventId:c.id}})).toThrow();
 expect(()=>parseCustomerCommand({...c,opening:{amount:0.1,occurredAt:2000}})).toThrow();
 expect(()=>parseCustomerCommand({...commands[4],accountId:id(9)})).toThrow();
 expect(()=>parseShopCommand({...c,type:'customer.unsupported'})).toThrow('Choose a supported customer action and its exact fields.');
});
