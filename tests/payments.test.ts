import {expect,it} from 'vitest';
import fc from 'fast-check';
import fixtures from '../packages/core/fixtures/payments/messages.json';
import {parsePaymentText,type PaymentTextContext} from '../packages/core/payments';
const context:PaymentTextContext={receivedAt:Date.UTC(2026,10,25,9),timeZone:'Asia/Dhaka',currency:'BDT',market:'BD',sender:'bKash'};
const text=(amount='910',tail='')=>`You have received Tk ${amount} from 01712345482. TrxID TESTMESSAGE at 25/11/2026 14:30${tail}`;
it.each(fixtures.fixtures)('reads all literal fields of $id without changing the source',fixture=>{
 const result=parsePaymentText(fixture.text,fixture.context as PaymentTextContext);
 expect(result).toMatchObject(fixture.expected);expect(result.raw).toBe(fixture.text);
});
it('keeps all thirty fixtures as independent declared expectations',()=>{expect(fixtures.fixtures).toHaveLength(30);expect(new Set(fixtures.fixtures.map(f=>f.id)).size).toBe(30);});
it.each(['Send Money Tk 910 to 01712345482 successful. TrxID TEST01 at 25/11/2026 14:30','You have sent Tk 910 to 01712345482.','Your A/C 1234 has been debited by BDT 910.','Cash Out Tk 910 successful.','Payment Tk 910 to Merchant successful.'])('keeps outgoing source manual: %s',raw=>{
 const result=parsePaymentText(raw,context);expect(result.status).toBe('manual');expect(result.direction).toBe('outgoing');expect(result.raw).toBe(raw);
});
it.each(['reversed','refund','failed','verification code 123456'])('does not recognize a blocked incoming message containing %s',suffix=>{expect(parsePaymentText(text('910',' '+suffix),context).status).toBe('manual');});
it.each(['-1','+1','0','1e3','1,23.50','1.999','9,007,199,254,740,992','1.2.3','123abc'])('rejects malformed or out-of-range primary amount %s',value=>{
 const result=parsePaymentText(text(value)+' Balance Tk 999. Fee Tk 10.',context);expect(result.status).toBe('manual');expect(result.amount).toBeNull();
});
it('prefills only one explicit amount in an unknown format and never takes a fee, balance or bare number',()=>{
 const proposed=parsePaymentText('Unknown transfer notice: Tk 15.25. Balance Tk 1,000. Fee Tk 2.',context);expect(proposed).toMatchObject({status:'manual',amount:1525});expect(proposed.warnings.some(warning=>warning.startsWith('More than one transfer'))).toBe(false);
 for(const raw of ['Balance Tk 1,000.00.','Fee Tk 20.00.','OTP 123456','Call 01712345482','Transfer 910 to an account','Unknown: Tk 10 or BDT 20'])expect(parsePaymentText(raw,context)).toMatchObject({status:'manual',amount:null});
});
it('does not infer a provider from a generic receive phrase or an arbitrary sender substring',()=>{
 expect(parsePaymentText(text(),{...context,sender:'my-bKash-offer'})).toMatchObject({status:'manual',channel:'unknown',amount:91000});
 expect(parsePaymentText('Nagad: '+text(),context)).toMatchObject({status:'manual',channel:'nagad'});
});
it('retains ambiguous sources and never chooses the first of two transfers, references or dates',()=>{
 for(const raw of [text()+' You have received Tk 20.',text()+' TxnID OTHER01',text()+' at 25/11/2026 14:31',text()+' Transfer BDT 20',text()+' Balance Tk 100. Another transfer BDT 20.',text()+' Fee Tk 10. Transfer BDT 20.'])expect(parsePaymentText(raw,context).status).toBe('manual');
});
it.each(['31/02/2026 14:30','25/11/2026 25:30','25/11/26 14:30','2026-02-30T08:30:00Z','2026-11-25T14:30:00+15:00'])('keeps invalid or incomplete message time manual: %s',date=>{
 const result=parsePaymentText(`You have received Tk 10. TrxID TEST1 at ${date}`,context);expect(result.status).toBe('manual');expect(result.timeSource).toBe('capture');expect(result.receivedAt).toBe(context.receivedAt);
});
it('never resolves a DST fold or gap by inventing which clock occurrence was meant',()=>{
 for(const date of ['01/11/2026 01:30','08/03/2026 02:30'])expect(parsePaymentText(`You have received Tk 10 at ${date}`,{...context,timeZone:'America/New_York',dateOrder:'DMY'})).toMatchObject({status:'manual',timeSource:'capture'});
 expect(parsePaymentText('You have received Tk 10 at 2026-11-01T01:30:00-04:00',{...context,timeZone:'America/New_York'})).toMatchObject({status:'recognized',timeSource:'message',receivedAt:Date.UTC(2026,10,1,5,30)});
});
it('uses capture time explicitly when no time is printed and rejects future message times',()=>{
 expect(parsePaymentText('You have received Tk 10. TrxID TEST001',context)).toMatchObject({status:'recognized',timeSource:'capture',receivedAt:context.receivedAt});
 expect(parsePaymentText('You have received Tk 10 at 26/11/2026 14:30',context).status).toBe('manual');
});
it('preserves all source code units and oversized input without extracting a clipped prefix',()=>{
 const raw=text()+'\0\ud800'+('x'.repeat(12000)),result=parsePaymentText(raw,context);expect(result).toMatchObject({status:'manual',raw,amount:null,reference:null});
});
it('never fills a balance or fee introduced by an extra linking word',()=>{
 for(const raw of ['Your balance is Tk 910.','Available amount: Tk 910.','Fee amount: Tk 910.','New balance now BDT 910','Your current balance for account ****1234 on 25/11/2026 is BDT 910.','The service charge for this transfer is BDT 910.'])expect(parsePaymentText(raw,context).amount).toBeNull();
});
it('does not mistake a transaction label or a merchant letter for a masked phone',()=>{
 expect(parsePaymentText(text().replace('from 017','from X Store 017'),context).fromPhone).toBe('+8801712345482');
 expect(parsePaymentText(text().replace('TrxID','TxID'),context).fromPhone).toBe('+8801712345482');
 expect(parsePaymentText(text().replace('01712345482','xxx12345482'),context).fromPhone).toBeNull();
});
it('keeps incomplete references, glued date suffixes and conflicting time zones manual',()=>{
 for(const tail of [' TrxID: X',' TrxID: '+('A'.repeat(65)),' at 2026-11-25T14:30:00+06:00Q',' at 31/02/2026 14:30'])expect(parsePaymentText(text('910',tail),context).status).toBe('manual');
 expect(parsePaymentText('You have received Tk 10 at 25/11/2026 14:30 EST',context).status).toBe('manual');
 expect(parsePaymentText('You have received Tk 10 at 2026-11-25T08:30:00 UTC',context)).toMatchObject({status:'recognized',timeSource:'message',receivedAt:Date.UTC(2026,10,25,8,30)});
});
it('retains unsupported controls and lone surrogates for manual review',()=>{
 for(const suffix of ['\0','\ud800','\udfff']){const raw=text('910',suffix),result=parsePaymentText(raw,context);expect(result.status).toBe('manual');expect(result.raw).toBe(raw);}
});
it('accepts unambiguous named-month dates and never guesses a two-digit year or negative timestamp',()=>{
 const result=parsePaymentText('You have received Tk 10 at 25-Nov-2026 02:30 PM',context);expect(result).toMatchObject({status:'recognized',timeSource:'message',receivedAt:Date.UTC(2026,10,25,8,30)});
 for(const date of ['25-Nov-26 14:30','1960-11-25T08:30:00Z','01/01/1960 08:30 UTC','31-Feb-2026 14:30','1970-01-01T00:00:00+06:00'])expect(parsePaymentText('You have received Tk 10 at '+date,context)).toMatchObject({status:'manual',timeSource:'capture',receivedAt:context.receivedAt});
});
it('retains the original context after a caller changes its input object',()=>{
 const input={...context},result=parsePaymentText(text(),input);input.sender='Changed';input.timeZone='UTC';expect(result.parserVersion).toBe(1);expect(result.sourceContext).toEqual(context);expect(Object.isFrozen(result.sourceContext)).toBe(true);
});
it('retains only declared source context rather than copying unrelated private connection state',()=>{
 const supplied={...context,connection:{accessToken:'test-only-unrelated-state'},extra:'test-only-extra'},result=parsePaymentText(text(),supplied);expect(result.sourceContext).toEqual(context);expect(Object.hasOwn(result.sourceContext,'connection')).toBe(false);expect(Object.hasOwn(result.sourceContext,'extra')).toBe(false);
});
it.each(['currency','timeZone','sender','market','dateOrder'] as const)('rejects non-scalar source context in %s',field=>{
 const supplied={...context,[field]:{toString:()=>field==='market'?'BD':field==='currency'?'BDT':field==='timeZone'?'Asia/Dhaka':field==='sender'?'bKash':'DMY'}} as unknown as PaymentTextContext;
 expect(()=>parsePaymentText(text(),supplied)).toThrow('capture context');
});
it('accepts an explicit account-number label without interpreting that account as a sender phone',()=>{
 const result=parsePaymentText('DBBL: Your A/C No. ****1234 has been credited with BDT 10. RefID TESTBANK99 at 25-Nov-2026 14:30',context);expect(result).toMatchObject({status:'manual',channel:'bank',amount:1000,fromPhone:null});
 expect(parsePaymentText(result.raw,{...context,sender:'DBBL'})).toMatchObject({status:'recognized',channel:'bank',amount:1000,fromPhone:null});
});
it.each(['Dear customer, your account No. ****1234 has been debited by BDT 910.','BDT 910 has been debited from your account.','Money sent Tk 910 successful.'])('classifies known outgoing variants as outgoing: %s',raw=>{expect(parsePaymentText(raw,context)).toMatchObject({status:'manual',direction:'outgoing'});});
it('has bounded literal handling for arbitrary source text',()=>{
 fc.assert(fc.property(fc.string({maxLength:12000}),raw=>{const result=parsePaymentText(raw,context);expect(result.raw).toBe(raw);if(result.amount!==null)expect(Number.isSafeInteger(result.amount)&&result.amount>0).toBe(true);}),{numRuns:200});
});
