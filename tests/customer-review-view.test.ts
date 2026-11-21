import {expect,it} from 'vitest';
import {customerFingerprint,parseCustomerCommand} from '../packages/core/customer-commands';
import {prepareCustomerReviewView,parsePreparedCustomerReview,readCustomerReviewContext,type CustomerReviewCurrent} from '../packages/core/customer-review-view';
import {customerReviewSourceAudits} from '../packages/core/customer-review-source';
import {customerSaveIntent} from '../packages/core/customer-intent';
import {marketPacks,type MarketCode} from '../packages/core/packs';
import {normalisePhone} from '../packages/core/phone';
import {id,input,literal,terms,modes,fixture,replayContext,sqlRow} from './customer-review-fixture';
import {at,creditFixture} from './credit-fixture';

async function view(f=fixture('update-terms'),options:Parameters<typeof replayContext>[1]={},patch:Partial<CustomerReviewCurrent>={}){
 const context=replayContext(f,options),raw=JSON.parse(context.contextJson);
 const current:CustomerReviewCurrent={stateHash:'c'.repeat(64),contextJson:context.contextJson,balances:raw.accounts.map((a:{id:string})=>({accountId:a.id,balance:0})),phoneTaken:false,available:true,...patch};
 const metadata={v:1 as const,id:f.packet.id,replacementId:f.packet.replacementId,commandId:f.command.id,commandHash:await customerFingerprint(f.command),sourceHash:f.packet.sourceHash,businessId:context.businessId,outletId:context.outletId,actorId:context.actorId,token:'t'.repeat(43),at:context.at,expiresAt:context.at+120000};
 return prepareCustomerReviewView(metadata,current,f.packet);
}
it.each(modes)('prepares and independently validates the current %s comparison with ordinary replay',async mode=>{
 const f=fixture(mode),v=await view(f),saved=structuredClone(v);
 expect(v.proposal.enabled).toBe(true);expect(parsePreparedCustomerReview(v,f.packet)).toEqual(v);expect(v).toEqual(saved);
 const context=readCustomerReviewContext(v.current.contextJson,v.businessId,v.outletId,f.command.customerId);expect(context.business.id).toBe(f.setup.business.id);expect(context.outlet.id).toBe(f.command.outletId);
 if(v.proposal.enabled&&v.proposal.customer)expect(v.proposal.customer.id).toBe(f.command.customerId);
});
it('retains literal original inputs and opening dates without treating server admission clocks as user choices',async()=>{
 const f=fixture('create-opening'),v=await view(f);if(!v.proposal.enabled)throw Error();
 expect(v.proposal.customer).toMatchObject({name:literal,notes:literal,tags:['regular',literal],phone:null,archived:false,consentRenewed:true});
 expect(v.proposal.opening).toMatchObject({amount:12345,occurredAt:at-86400000,sequence:1});
 expect(v.proposal.customer).not.toHaveProperty('updatedAt');expect(v.proposal.account).not.toHaveProperty('createdAt');expect(v.proposal.opening).not.toHaveProperty('createdAt');
 const {current,proposal,...metadata}=v;void proposal;
 expect(prepareCustomerReviewView({...metadata,at:v.at+1000,expiresAt:v.expiresAt+1000},current,f.packet).proposal).toEqual(v.proposal);
});
it('shows current renamed contact details separately from a settings-only original whose historical name is unknown',async()=>{
 const f=fixture('khata-settings'),v=await view(f,{customer:{...f.customer,name:'Current checked name',nickname:'Current nickname'}}),context=readCustomerReviewContext(v.current.contextJson,v.businessId,v.outletId,f.command.customerId);
 expect(context.customer?.name).toBe('Current checked name');expect(v.proposal).toMatchObject({enabled:true,customer:null,account:{id:f.account.id,limit:45000}});expect(JSON.parse(f.packet.sourceJson).events[0].after).not.toHaveProperty('name');
});
it('shows both scoped currency accounts while preserving the original BDT financial parent',async()=>{
 const f=fixture('update-terms'),usd={...f.account,id:id(800000),currency:'USD',limit:90000},v=await view(f,{accounts:[f.account,usd],currency:'USD'});
 expect(v.current.balances).toHaveLength(2);expect(v.proposal).toMatchObject({enabled:true,account:{id:f.account.id,currency:'BDT',limit:45000}});
});
it.each(['create-opening','update-implicit','khata-create'] as const)('refuses a changed currency for the original new account in %s',async mode=>{
 expect((await view(fixture(mode),{currency:'USD'})).proposal).toEqual({enabled:false,reason:'unit'});
});
it('refuses original account creation against another canonical account without proposing its ID',async()=>{
 const f=fixture('khata-create'),other={...f.account,id:id(800000)},v=await view(f,{accounts:[other]});
 expect(v.proposal).toEqual({enabled:false,reason:'account'});expect(v.current.balances).toEqual([{accountId:other.id,balance:0}]);
});
it('cannot enable a contact-only proposal after its existing account disappears',async()=>{
 expect((await view(fixture('update-contact'),{accounts:[]})).proposal).toEqual({enabled:false,reason:'account'});
});
it('does not disclose a conflicting contact when a business-wide phone is taken',async()=>{
 const f=fixture('create-default',{...input,phone:'+8801712345484'}),v=await view(f,{}, {phoneTaken:true});
 expect(v.proposal).toEqual({enabled:false,reason:'phone'});expect(v.current).not.toHaveProperty('otherCustomer');
 const raw=JSON.parse(v.current.contextJson);raw.otherCustomer={name:'Another outlet private customer'};expect(()=>parsePreparedCustomerReview({...v,current:{...v.current,contextJson:JSON.stringify(raw)}},f.packet)).toThrow();
});
it('refuses another national-phone interpretation while accepting the unchanged E.164 intent',async()=>{
 const f=fixture('create-default',{...input,phone:'01712345484'});if(!('credit'in f.command))throw Error();
 const originalPhone=f.command.input.phone,other=(Object.keys(marketPacks) as MarketCode[]).find(m=>{const p=normalisePhone('01712345484',m);return p!==null&&p!==originalPhone;});expect(other).toBeDefined();
 f.command=parseCustomerCommand({...f.command,input:{...f.command.input,phone:'01712345484'}});f.packet.command=f.command;
 expect((await view(f,{market:other})).proposal.enabled).toBe(false);
 const canonical=fixture('create-default',{...input,phone:originalPhone});expect((await view(canonical,{market:other})).proposal.enabled).toBe(true);
});
it('keeps a settled restore available while an unsettled shared-contact archive stays unavailable',async()=>{
 const archived=fixture('archive'),restored=fixture('restore');
 for(const f of [archived,restored]){
  const context=replayContext(f),raw=JSON.parse(context.contextJson);raw.hasBalance=true;
  const v=await view(f,{}, {contextJson:JSON.stringify(raw)});
  expect(v.proposal.enabled).toBe(f.command.type==='customer.restore');
 }
});
it('can retain signed existing balances but rejects incomplete, duplicated or foreign balance rows',async()=>{
 const f=fixture('update-terms'),v=await view(f,{}, {balances:[{accountId:f.account.id,balance:-100}]});expect(v.current.balances[0].balance).toBe(-100);
 for(const balances of [[],[...v.current.balances,...v.current.balances],[{accountId:id(800000),balance:0}],[{accountId:f.account.id,balance:1.5}]])expect(()=>parsePreparedCustomerReview({...v,current:{...v.current,balances}},f.packet)).toThrow();
});
it('rejects an ordinary context that exposes a cross-outlet balance flag and an inconsistent settled archive',async()=>{
 const f=fixture('update-terms'),v=await view(f),raw=JSON.parse(v.current.contextJson);raw.hasBalance=true;
 expect(()=>parsePreparedCustomerReview({...v,current:{...v.current,contextJson:JSON.stringify(raw)}},f.packet)).toThrow();
 const a=fixture('archive'),archive=await view(a);expect(()=>parsePreparedCustomerReview({...archive,current:{...archive.current,balances:[{accountId:a.account.id,balance:100}]}},a.packet)).toThrow();
});
it.each(['customer identity','outlet','account customer','account currency duplicate','private Auth column','private token','business'])('rejects a changed %s in current records',async kind=>{
 const f=fixture('update-terms'),v=await view(f),raw=JSON.parse(v.current.contextJson);
 if(kind==='customer identity')raw.customer.id=id(800000);else if(kind==='outlet')raw.accounts[0].outlet_id=id(800000);else if(kind==='account customer')raw.accounts[0].customer_id=id(800000);else if(kind==='account currency duplicate')raw.accounts.push({...raw.accounts[0],id:id(800000)});else if(kind==='private Auth column')raw.business.auth_user_id='not part of public comparison';else if(kind==='private token')raw.accounts[0].token='not part of public comparison';else raw.outlet.business_id=id(800000);
 expect(()=>parsePreparedCustomerReview({...v,current:{...v.current,contextJson:JSON.stringify(raw)}},f.packet)).toThrow();
});
it.each(['name','note','account','limit','opening amount','opening date','clock','extra'])('rejects a changed proposed %s rather than accepting a server-supplied substitute',async kind=>{
 const f=fixture('create-opening'),v=await view(f);if(!v.proposal.enabled||!v.proposal.customer||!v.proposal.account||!v.proposal.opening)throw Error();
 if(kind==='name')v.proposal.customer.name='Substitute';else if(kind==='note')v.proposal.customer.notes='Substitute';else if(kind==='account')v.proposal.account.id=id(800000);else if(kind==='limit')v.proposal.account.limit++;else if(kind==='opening amount')v.proposal.opening.amount++;else if(kind==='opening date')v.proposal.opening.occurredAt++;else if(kind==='clock')Object.assign(v.proposal.customer,{createdAt:v.at});else Object.assign(v.proposal,{token:'not a domain choice'});
 expect(()=>parsePreparedCustomerReview(v,f.packet)).toThrow();
});
it('rejects a proposal enabled against the checked availability, phone, actor, scope or expiry',async()=>{
 const f=fixture('update-terms'),v=await view(f);
 for(const patch of [{actorId:id(800000)},{businessId:id(800000)},{outletId:id(800000)},{id:id(800000)},{replacementId:id(800000)},{sourceHash:'f'.repeat(64)},{expiresAt:v.at},{expiresAt:v.at+300001},{token:'stale'}])expect(()=>parsePreparedCustomerReview({...v,...patch},f.packet)).toThrow();
 expect(()=>parsePreparedCustomerReview({...v,current:{...v.current,available:false}},f.packet)).toThrow();expect(()=>parsePreparedCustomerReview({...v,current:{...v.current,phoneTaken:true}},f.packet)).toThrow();
});
it('uses exact older account terms as the before-image while validating the new reminder choices',async()=>{
 const {context}=creditFixture(),account={...context.account,reminder:{...context.account.reminder,dayOfMonth:100}},result=customerSaveIntent(input,{id:context.customer.id,credit:terms},{setup:context.setup,customers:[context.customer],accounts:[account]},at+1000);
 const events=customerReviewSourceAudits(result.command,result.mutation.events,context.setup.business.id);expect(events[1]).toMatchObject({before:{reminder:{dayOfMonth:100}},after:{reminder:{dayOfMonth:12}}});
 const f=fixture('update-terms'),v=await view(f,{accounts:[{...f.account,reminder:{...f.account.reminder,dayOfMonth:100}}]});expect(v.proposal).toMatchObject({enabled:true,account:{reminder:{dayOfMonth:12}}});
 const raw=JSON.parse(v.current.contextJson);raw.accounts[0].notes=literal;raw.outlet.opening_hours={};raw.outlet.delivery_zones=[];
 expect(readCustomerReviewContext(JSON.stringify(raw),v.businessId,v.outletId,f.command.customerId).accounts[0].reminder.dayOfMonth).toBe(100);
 const encoded=sqlRow('creditAccounts',account,context.setup.business.id);expect(encoded.reminder).toMatchObject({dayOfMonth:100});
});
