import {ulid} from 'ulid';
import {customerSaveMutation,type CustomerSaveContext,type CustomerSaveOptions} from './customer-mutation';
import type {CustomerInput,CustomerSetup} from './customers';
import {saveCreditTermsCommand,type CreditTermsInput} from './khata';
import type {CreditAccount,Customer} from './models';
import {parseShopCommand,type CustomerCommand,type CustomerRecordIds} from './shop-commands';
type NewId=(kind:'customer'|'account'|'entry'|'event')=>string;
const terms=(account:CreditAccount):CreditTermsInput=>({allowed:account.allowed,limit:account.limit,reminder:{enabled:account.reminder.enabled,dayOfMonth:account.reminder.dayOfMonth,tone:account.reminder.tone,channel:account.reminder.channel}});
/** Construct the local write and its retryable intent together, before any I/O. */
export function customerSaveIntent(input:CustomerInput,options:CustomerSaveOptions,context:CustomerSaveContext,at=Date.now(),newId:NewId=()=>ulid(at)){
 const mutation=customerSaveMutation(input,options,context,at,newId),account=mutation.account??context.accounts.find(a=>a.customerId===mutation.customer.id&&a.outletId===context.setup.outlet.id&&a.currency===context.setup.outlet.currency);
 if(!account)throw new Error('The customer save has no current khata.');
 const ids:CustomerRecordIds={accountId:account.id,accountEventId:mutation.events.find(e=>e.command==='khata.create'||e.command==='khata.settings')?.id??newId('event'),openingEntryId:mutation.entry?.id??newId('entry'),openingEventId:mutation.events.find(e=>e.command==='khata.opening-balance')?.id??newId('event')};
 const customer=mutation.customer,profile:CustomerInput={name:customer.name,nickname:customer.nickname,phone:customer.phone??'',address:customer.address,notes:customer.notes,tags:[...customer.tags]};
 const command=parseShopCommand({id:mutation.events[0].id,type:options.id?'customer.update':'customer.create',customerId:customer.id,outletId:context.setup.outlet.id,input:profile,credit:options.credit?terms(account):null,opening:options.opening??null,ids}) as Extract<CustomerCommand,{credit:unknown}>;
 return {command,mutation};
}
export function creditTermsIntent(input:CreditTermsInput,customer:Customer,setup:CustomerSetup,before:CreditAccount|null=null,at=Date.now(),newId:NewId=()=>ulid(at)){
 const mutation=saveCreditTermsCommand(input,customer,setup,before,at,newId),ids:CustomerRecordIds={accountId:mutation.account.id,accountEventId:newId('event'),openingEntryId:newId('entry'),openingEventId:newId('event')};
 const command=parseShopCommand({id:mutation.event.id,type:'khata.settings',customerId:customer.id,outletId:setup.outlet.id,accountId:before?.id??null,input:terms(mutation.account),ids}) as Extract<CustomerCommand,{type:'khata.settings'}>;
 return {command,mutation};
}
