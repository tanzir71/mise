import { setupCommand } from '../packages/core/setup';
import { saveCustomerCommand } from '../packages/core/customers';
import { defaultCreditTerms, saveCreditTermsCommand, type LedgerContext } from '../packages/core/khata';
import type { MarketCode } from '../packages/core/packs';
export const at = Date.UTC(2026,10,15,6);
export const profile = {name:'Karim bhai',nickname:'Karim',phone:'01712345482',address:'Flat 3B, House 12',notes:'',tags:[]};
export function creditFixture(market: MarketCode = 'BD', createdAt = at) {
  const seeded = setupCommand({businessType:'corner_shop',marketCode:market,name:'Rahman Store',phone:'+8801712345482'},null,createdAt);
  const setup = seeded.snapshot, customer = saveCustomerCommand({...profile,phone:'+8801712345482'},setup,[],null,createdAt).customer;
  const account = saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:300000,reminder:{...defaultCreditTerms.reminder,enabled:true}},customer,setup,null,createdAt).account;
  const context: LedgerContext = {setup,customer,account,entries:[]};
  return {context,saleContext:{setup,items:seeded.items,wallets:['Cash','bKash','Nagad']}};
}
