import { setupCommand } from '../packages/core/setup';
import { saveCustomerCommand } from '../packages/core/customers';
import { defaultCreditTerms,openingBalanceCommand,saveCreditTermsCommand } from '../packages/core/khata';
import { recordSaleCommand } from '../packages/core/sales';
import { recordCreditSaleCommand } from '../packages/core/credit-sales';
import { saveOrderCommand,addOrderNoteCommand } from '../packages/core/orders';
import { saveStockItemCommand } from '../packages/core/stock';
import { recordPurchaseCommand } from '../packages/core/purchases';
import { emptyBackupTables } from '../packages/core/backup-tables';
import { createBackup } from '../packages/core/backup';

export const REPORT_AT=Date.UTC(2026,10,16,6);
/** A portable backup built through domain commands, imported through the real restore UI. */
export function reportBackupFixture() {
  const at=REPORT_AT,t=emptyBackupTables(),seed=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'রহমান স্টোর',phone:'01712345482'},null,at),setup=seed.snapshot;
  t.businesses.push(setup.business);t.outlets.push(setup.outlet);t.members.push(setup.owner);t.categories.push(...seed.categories);t.items.push(...seed.items);t.events.push(seed.event);
  const customer=saveCustomerCommand({name:'রিনা',nickname:'Rina',phone:'01712345483',address:'Road 12',notes:'চিনি কম, "ভালো"\nদ্বিতীয় লাইন',tags:['regular']},setup,[],null,at);
  const terms=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:100000},customer.customer,setup,null,at),ledger={setup,customer:customer.customer,account:terms.account,entries:[]};
  const opening=openingBalanceCommand(10000,at-86400000,ledger,at);t.customers.push(customer.customer);t.creditAccounts.push(terms.account);t.creditEntries.push(opening.entry);t.events.push(customer.event,terms.event,opening.event);
  const context={setup,items:seed.items,wallets:['bKash','Nagad','Cash']},cash=recordSaleCommand({expression:'100',method:'cash'},context,at),credit=recordCreditSaleCommand({expression:'75',customerId:customer.customer.id,accountId:terms.account.id},{...ledger,entries:[opening.entry]},context,at);
  t.sales.push(cash.sale,credit.sale);t.creditEntries.push(credit.entry);t.events.push(cash.event,credit.event,credit.creditEvent);
  const order=saveOrderCommand({source:'phone',sourceText:'',name:'রিনা',phone:'01712345483',type:'pickup',address:'',table:'',lines:[{name:'Tea',unit:'cup',qty:2,unitPrice:1250}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup,items:seed.items,sequence:1},null,0,at),noted=addOrderNoteCommand(order.order,'চিনি কম',setup,order.order.revision,at);
  t.orders.push(noted.order);t.orderNotes.push(noted.note);t.events.push(order.event,noted.event);
  const stock=saveStockItemCommand({name:'Chicken',nameLocal:'মুরগি',unit:'kg',onHand:20,target:30,packSize:5},{setup,items:[],suppliers:[],moves:[]},null,0,at);t.stockItems.push(...stock.items);t.stockMoves.push(...stock.moves);t.events.push(...stock.events);
  const purchase=recordPurchaseCommand({supplierName:'সবুজ',reference:'INV-1',lines:[{stockItemId:stock.items[0].id,name:'মুরগি',unit:'kg',qty:2.5,unitPrice:12001}],paid:'due',note:'দাম নিশ্চিত'},setup,[],stock.items,at);t.purchases.push(purchase.purchase);t.events.push(purchase.event);
  return createBackup(t,at);
}
