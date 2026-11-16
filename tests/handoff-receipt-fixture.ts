import { setupCommand } from '../packages/core/setup';
import { saveItemCommand } from '../packages/core/catalogue';
import { recordSaleCommand } from '../packages/core/sales';
import { createBackup } from '../packages/core/backup';
import { emptyBackupTables } from '../packages/core/backup-tables';
export function handoffReceiptFixture(){
  const at=Date.UTC(2026,10,16,6),seed=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Multipart store',phone:'01712345482'},null,at),setup=seed.snapshot,t=emptyBackupTables();
  t.businesses.push(setup.business);t.outlets.push(setup.outlet);t.members.push(setup.owner);t.categories.push(...seed.categories);t.items.push(...seed.items);t.events.push(seed.event);
  const chosen=[];
  for(let i=0;i<40;i++){const change=saveItemCommand({name:`Item ${i+1} `+'চাল'.repeat(30),nameLocal:'',price:100,unit:'pcs',category:'Receipt items',available:true,oftenBought:false},{outletId:setup.outlet.id,actorId:setup.owner.id,categories:t.categories},null,at);t.items.push(change.item);t.events.push(change.event);if(change.category)t.categories.push(change.category);chosen.push({itemId:change.item.id,qty:1,unitPrice:100});}
  const sale=recordSaleCommand({expression:'40',method:'cash',items:chosen},{setup,items:t.items,wallets:[]},at);t.sales.push(sale.sale);t.events.push(sale.event);return createBackup(t,at);
}
