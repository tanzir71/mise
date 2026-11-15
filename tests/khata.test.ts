import { expect, test } from 'vitest';
import fc from 'fast-check';
import { chargeCreditCommand, recordCreditPaymentCommand, openingBalanceCommand, undoCreditEntryCommand, recordCommunicationCommand, creditBalance, outstandingLots, outstandingSince, saveCreditTermsCommand, defaultCreditTerms, CreditLimitError } from '../packages/core/khata';
import { saveCustomerCommand, archiveCustomerCommand, searchCustomers } from '../packages/core/customers';
import { recordCreditSaleCommand, undoCreditSaleCommand } from '../packages/core/credit-sales';
import { recordSaleCommand } from '../packages/core/sales';
import type { PaymentMethod } from '../packages/core/models';
import { at, profile, creditFixture } from './credit-fixture';

test('customer commands normalise phone numbers, scope duplicates, preserve identity and audit consent changes', () => {
  const {context} = creditFixture(), before = context.customer;
  const saved = saveCustomerCommand({...profile,name:' Karim bhai ',phone:'০১৭১২৩৪৫৪৮২',tags:[' Regular ','regular','tea']},context.setup,[],null,at);
  expect(saved.customer).toMatchObject({phone:'+8801712345482',name:'Karim bhai',tags:['regular','tea'],consent:{source:'manual',savedAt:at}});
  expect(searchCustomers([saved.customer],'০১৭১২৩৪৫৪৮২')).toHaveLength(1);
  expect(() => saveCustomerCommand(profile,context.setup,[before],null,at)).toThrow(/already/);
  const updated = saveCustomerCommand({...profile,nickname:'Karim uncle'},context.setup,[before],before,at+1);
  expect(updated.customer).toMatchObject({id:before.id,createdAt:before.createdAt,nickname:'Karim uncle'});
  expect(updated.event).toMatchObject({command:'customer.update',customerId:before.id,before,after:updated.customer,actor:{id:context.setup.owner.id}});
  expect(() => saveCustomerCommand({...profile,phone:'123'},context.setup,[],null)).toThrow(/phone/);
  expect(() => saveCustomerCommand({...profile,name:''},context.setup,[],null)).toThrow(/name/);
  expect(() => archiveCustomerCommand(before,context.setup,true,true,at)).toThrow(/Settle/);
  const archived = archiveCustomerCommand(before,context.setup,false,true,at).customer;
  expect(searchCustomers([archived],'Karim')).toHaveLength(0);
  expect(searchCustomers([archived],'Karim',true)).toHaveLength(1);
  expect(archiveCustomerCommand(archived,context.setup,false,false,at+1).customer.archivedAt).toBeUndefined();
});
test('credit settings validate limits and reminder terms without changing an existing account currency', () => {
  const {context} = creditFixture();
  const setup = {...context.setup,outlet:{...context.setup.outlet,currency:'USD'}};
  const changed = saveCreditTermsCommand({...defaultCreditTerms,limit:100},context.customer,setup,context.account,at);
  expect(changed.account.currency).toBe('BDT'); expect(changed.account.allowed).toBe(false);
  expect(context.account.allowed).toBe(true);
  expect(() => saveCreditTermsCommand({...defaultCreditTerms,limit:-1},context.customer,setup)).toThrow(/negative/);
  expect(() => saveCreditTermsCommand({...defaultCreditTerms,limit:0.1},context.customer,setup)).toThrow(/amount/);
  expect(() => saveCreditTermsCommand({...defaultCreditTerms,reminder:{...defaultCreditTerms.reminder,dayOfMonth:32}},context.customer,setup)).toThrow(/reminder/);
});
test('over-limit credit requires a confirmation for the exact current balance and limit', () => {
  const {context} = creditFixture();
  context.entries.push(chargeCreditCommand(100000,context,{},at).entry);
  expect(() => chargeCreditCommand(250000,context,{},at)).toThrow(CreditLimitError);
  try { chargeCreditCommand(250000,context,{},at); } catch (error) { expect(error).toMatchObject({balance:100000,limit:300000,proposed:350000}); }
  expect(() => chargeCreditCommand(250000,context,{confirmation:{balance:0,limit:300000}},at)).toThrow(CreditLimitError);
  const approved = chargeCreditCommand(250000,context,{confirmation:{balance:100000,limit:300000}},at);
  expect(approved.entry.overLimit).toEqual({balance:100000,limit:300000});
  expect(approved.event).toMatchObject({command:'khata.charge',customerId:context.customer.id,after:approved.entry,at,actor:{type:'member',id:context.setup.owner.id}});
  expect(() => chargeCreditCommand(1,{...context,account:{...context.account,allowed:false}},{confirmation:{balance:100000,limit:300000}},at)).toThrow(/turned off/);
});
test('payments cannot overpay, do not depend on new-credit permission and preserve method/actor', () => {
  const {context} = creditFixture(); context.entries.push(chargeCreditCommand(10000,context,{},at).entry);
  context.account.allowed = false;
  const payment = recordCreditPaymentCommand(5000,'wallet','bKash',context,['Cash','bKash'],'Paid at counter',at+1);
  expect(payment.entry).toMatchObject({type:'payment',amount:5000,methodName:'bKash',createdBy:context.setup.owner.id});
  context.entries.push(payment.entry); expect(creditBalance(context.account,context.entries)).toBe(5000);
  expect(() => recordCreditPaymentCommand(5001,'cash',undefined,context,[], '',at+2)).toThrow(/exceed/);
  expect(() => recordCreditPaymentCommand(1,'wallet','Other',context,[], '',at+2)).toThrow(/payment method/);
});
test('amounts remain exact at the safe-integer boundary and accounts cannot mix currencies or outlets', () => {
  const {context} = creditFixture(); const opening = openingBalanceCommand(Number.MAX_SAFE_INTEGER,at-86400000,context,at);
  context.entries.push(opening.entry); expect(creditBalance(context.account,context.entries)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => chargeCreditCommand(1,context,{},at)).toThrow(/supported/);
  expect(() => creditBalance(context.account,[{...opening.entry,currency:'USD'}])).toThrow(/currency/);
  expect(() => chargeCreditCommand(1,{...context,setup:{...context.setup,outlet:{...context.setup.outlet,currency:'USD'}}},{},at)).toThrow(/currency/);
  expect(() => chargeCreditCommand(1,{...context,account:{...context.account,outletId:'another'}},{},at)).toThrow(/another shop/);
  expect(() => openingBalanceCommand(1,at,context,at)).toThrow(/empty/);
  const paid = recordCreditPaymentCommand(Number.MAX_SAFE_INTEGER,'cash',undefined,context,[],'',at+1);
  expect(creditBalance(context.account,[...context.entries,paid.entry])).toBe(0);
});
test('undo retains entries, restores debt age, is once-only and uses the persisted entry rather than caller amounts', () => {
  const {context} = creditFixture(), old = at-40*86400000;
  const opening = openingBalanceCommand(10000,old,context,at); context.entries.push(opening.entry);
  const payment = recordCreditPaymentCommand(10000,'cash',undefined,context,[],'',at); context.entries.push(payment.entry);
  expect(outstandingSince(context.account,context.entries)).toBeNull();
  const reverse = undoCreditEntryCommand({...payment.entry,amount:1},context,at+1); context.entries.push(reverse.entry);
  expect(reverse.entry.amount).toBe(10000); expect(reverse.event.undoOf).toBe(payment.event.id);
  expect(creditBalance(context.account,context.entries)).toBe(10000); expect(outstandingSince(context.account,context.entries)).toBe(old);
  expect(() => undoCreditEntryCommand(payment.entry,context,at+2)).toThrow(/once/);
  expect(() => undoCreditEntryCommand(opening.entry,context,at+600001)).toThrow(/10 minutes/);
  expect(() => undoCreditEntryCommand({...opening.entry,id:'unknown'},context,at+2)).toThrow(/not found/);
});
test('credit sales and their undo link the sale, charge, actor and both audit events', () => {
  const {context,saleContext} = creditFixture();
  const command = recordCreditSaleCommand({expression:'75+150+20',customerId:context.customer.id,accountId:context.account.id},context,saleContext,at);
  expect(command.sale).toMatchObject({method:'credit',methodName:'Baki',amount:24500,given:undefined,change:undefined,customerId:context.customer.id,creditAccountId:context.account.id});
  expect(command.entry.saleId).toBe(command.sale.id); context.entries.push(command.entry);
  expect(() => undoCreditEntryCommand(command.entry,context,at+1)).toThrow(/original sale/);
  const payment = recordCreditPaymentCommand(1,'cash',undefined,context,[],'',at+1); context.entries.push(payment.entry);
  expect(() => undoCreditSaleCommand(command.sale,command.entry,context,at+2)).toThrow(/partly paid/);
  expect(() => undoCreditSaleCommand(command.sale,{...payment.entry,type:'charge',saleId:command.sale.id},context,at+2)).toThrow(/do not match/);
  context.entries.push(undoCreditEntryCommand(payment.entry,context,at+2).entry);
  const reversed = undoCreditSaleCommand(command.sale,command.entry,context,at+3); context.entries.push(reversed.entry);
  expect(creditBalance(context.account,context.entries)).toBe(0); expect(reversed.sale.voidedAt).toBe(at+3);
  expect(reversed.event.undoOf).toBe(command.event.id); expect(reversed.creditEvent.undoOf).toBe(command.creditEvent.id);
  expect(() => recordSaleCommand({expression:'10',method:'credit' as PaymentMethod},saleContext,at)).toThrow(/payment method/);
});
test('communication history is zero-value, scoped and attributable', () => {
  const {context} = creditFixture(); context.entries.push(chargeCreditCommand(10000,context,{},at).entry);
  const sent = recordCommunicationCommand(context,'reminder','Please pay when convenient.','whatsapp',at+1); context.entries.push(sent.entry);
  expect(creditBalance(context.account,context.entries)).toBe(10000);
  expect(sent.event).toMatchObject({command:'khata.reminder-sent',customerId:context.customer.id,at:at+1,actor:{id:context.setup.owner.id}});
  expect(sent.entry).toMatchObject({amount:0,purpose:'reminder',methodName:'whatsapp'});
});
test('a device clock correction does not reorder financial operations', () => {
  const {context} = creditFixture();
  context.entries.push(chargeCreditCommand(10000,context,{},at+1000).entry);
  context.entries.push(recordCreditPaymentCommand(10000,'cash',undefined,context,[],'',at).entry);
  expect(creditBalance(context.account,context.entries)).toBe(0);
  expect(outstandingLots(context.account,context.entries)).toEqual([]);
});
test('balances and FIFO lots equal an independent ledger model through generated charges, payments and undo', () => {
  fc.assert(fc.property(fc.array(fc.record({kind:fc.constantFrom('charge','payment','undo-charge','undo-payment'),amount:fc.integer({min:1,max:1000000})}),{maxLength:80}),operations => {
    const {context} = creditFixture(); context.account.limit = Number.MAX_SAFE_INTEGER;
    const model: {id:string;kind:'charge'|'payment';amount:number;active:boolean}[] = [];
    const modelBalance = () => model.filter(row => row.active).reduce((sum,row) => sum+(row.kind === 'payment' ? -BigInt(row.amount) : BigInt(row.amount)),0n);
    for (const operation of operations) {
      if (operation.kind === 'charge') { const command = chargeCreditCommand(operation.amount,context,{},at); context.entries.push(command.entry); model.push({id:command.entry.id,kind:'charge',amount:operation.amount,active:true}); }
      else if (operation.kind === 'payment' && modelBalance() > 0n) { const value = Math.min(operation.amount,Number(modelBalance())); const command = recordCreditPaymentCommand(value,'cash',undefined,context,[],'',at); context.entries.push(command.entry); model.push({id:command.entry.id,kind:'payment',amount:value,active:true}); }
      else if (operation.kind.startsWith('undo-')) {
        const kind = operation.kind.slice(5), row = [...model].reverse().find(row => row.active && row.kind === kind);
        if (row && (kind === 'payment' || modelBalance() >= BigInt(row.amount))) { context.entries.push(undoCreditEntryCommand(context.entries.find(entry => entry.id === row.id)!,context,at).entry); row.active = false; }
      }
      const expected = Number(modelBalance());
      expect(creditBalance(context.account,context.entries)).toBe(expected);
      expect(outstandingLots(context.account,[...context.entries].reverse()).reduce((sum,lot) => sum+lot.amount,0)).toBe(expected);
      expect(new Set(context.entries.map(entry => entry.sequence)).size).toBe(context.entries.length);
    }
  }),{numRuns:500});
},10000);
