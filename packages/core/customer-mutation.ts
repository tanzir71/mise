import {ulid} from 'ulid';
import {saveCustomerCommand,type CustomerInput,type CustomerSetup} from './customers';
import {defaultCreditTerms,openingBalanceCommand,saveCreditTermsCommand,type CreditTermsInput} from './khata';
import type {AuditEvent,CreditAccount,CreditEntry,Customer} from './models';

export interface CustomerSaveOptions {id?:string;credit?:CreditTermsInput;opening?:{amount:number;occurredAt:number}}
export interface CustomerSaveContext {setup:CustomerSetup;customers:Customer[];accounts:CreditAccount[]}
export interface CustomerMutation {customer:Customer;account:CreditAccount|null;entry:CreditEntry|null;events:AuditEvent[]}
/** One reviewed mutation for both IndexedDB and the server's atomic commit. */
export function customerSaveMutation(input:CustomerInput,options:CustomerSaveOptions,context:CustomerSaveContext,at=Date.now(),newId:(kind:'customer'|'account'|'entry'|'event')=>string=()=>ulid(at)):CustomerMutation {
  const {setup,customers,accounts}=context,before=options.id?customers.find(c=>c.id===options.id):null;
  if(options.id&&!before)throw new Error('Customer not found.');
  const command=saveCustomerCommand(input,setup,customers,before??null,at,newId);
  const matches=accounts.filter(a=>a.outletId===setup.outlet.id&&a.customerId===command.customer.id&&a.currency===setup.outlet.currency);
  if(matches.length>1)throw new Error('Review this customer’s duplicate khata before saving.');
  const existing=matches[0];if(options.opening&&existing)throw new Error('Opening balances are only available on a new khata.');
  let account:CreditAccount|null=null,entry:CreditEntry|null=null;const events=[command.event];
  if(!existing||options.credit){
    const terms=saveCreditTermsCommand(options.credit??defaultCreditTerms,command.customer,setup,existing??null,at,newId);
    account=terms.account;events.push(terms.event);
    if(options.opening){const opening=openingBalanceCommand(options.opening.amount,options.opening.occurredAt,{setup,customer:command.customer,account,entries:[]},at,newId);entry=opening.entry;events.push(opening.event);}
  }
  return {customer:command.customer,account,entry,events};
}
