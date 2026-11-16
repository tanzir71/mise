import 'fake-indexeddb/auto';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { read,utils } from 'xlsx';
import { MiseDatabase } from '../apps/web/src/data/db';
import { exportXlsx } from '../apps/web/src/data/export-xlsx';
import { buildExportReport,exportCsv,exportDecimal,exportDatasets,type ExportTable } from '../packages/core/exports';
import { defaultCreditTerms } from '../packages/core/khata';
import { orderFixture } from './order-fixture';
import { stockInput } from './stock-fixture';

const at = Date.UTC(2026,10,16,6),databases:MiseDatabase[] = [];
beforeEach(() => {vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);});
afterEach(async () => {await Promise.all(databases.splice(0).map(db => db.delete()));vi.useRealTimers();});
async function fixture() {
  const db = new MiseDatabase(`mise-report-${randomUUID()}`);databases.push(db);
  const shop = {businessType:'corner_shop',marketCode:'BD',name:'মায়ের দোকান',phone:'01712345482'} as const;await db.saveSetup(shop);
  const customer = await db.saveCustomer({name:'রিনা',nickname:'=1+1',phone:'01712345483',address:'Road 12',notes:'কম চিনি, "ভালো"\nদ্বিতীয় লাইন',tags:['regular']},{credit:{...defaultCreditTerms,allowed:true,limit:100000},opening:{amount:10000,occurredAt:at-86400000}}),account = (await db.creditAccounts.toArray())[0];
  await db.recordSale({expression:'100',method:'cash',given:20000});await db.recordCreditSale({expression:'75',customerId:customer.id,accountId:account.id});
  const payment = await db.recordCreditPayment(account.id,5000,'cash');await db.undoCreditEntry(payment.id);await db.recordCreditPayment(account.id,2500,'cash');
  const cash = await db.saveOrder({...orderFixture().input,customerId:customer.id,phone:customer.phone!},{settlement:{method:'cash'}});await db.changeOrderStatus(cash.id,'cancelled',cash.revision);await db.refundOrder(cash.id,{amount:1000,method:'cash'},cash.revision+1);
  const supplier = await db.saveSupplier({name:'সবুজ',phone:'01712345484',note:''}),item = await db.saveStockItem({...stockInput,supplierId:supplier.id});
  const used = await db.adjustStock({id:item.id,revision:item.revision,reason:'used',quantity:1.125});const move = (await db.stockMoves.toArray()).find(m => m.reason==='used')!;await db.undoStockMove(move.id,used.revision);
  const purchase = await db.recordPurchase({supplierId:supplier.id,supplierName:supplier.name,reference:'INV-1',lines:[{stockItemId:item.id,name:item.name,unit:item.unit,qty:2.5,unitPrice:12001}],paid:'due',note:'দাম নিশ্চিত'});
  const undone = await db.recordPurchase({supplierName:'Cash supplier',reference:'INV-2',lines:[{name:'Soap',unit:'pc',qty:1,unitPrice:5000}],paid:'cash',note:''});await db.undoPurchase(undone.id);
  await db.saveSetup({...shop,marketCode:'OTHER',currency:'USD',timezone:'UTC',phone:'+12125550123'});await db.recordSale({expression:'10',method:'card'});
  return {db,purchase,customer,backup:await db.readBackup()};
}

test('six datasets export actual records and keep refunds, reversals and currencies distinct',async () => {
  const {backup,purchase} = await fixture(),report = buildExportReport(backup,{datasets:[...exportDatasets],period:{preset:'all'}});
  expect(report.tables.map(t => t.dataset)).toEqual(exportDatasets);for(const table of report.tables)expect(table.rows.length,table.name).toBeGreaterThan(0);
  const sales = report.tables.find(t => t.dataset==='sales')!;
  const sum = (key:string,currency:string) => sales.rows.filter(row => row.currency===currency).reduce((sum,row) => sum+(row[key] as {minor:number}).minor,0);
  expect(sum('netSales','BDT')).toBe(17500);expect(sum('cashMovement','BDT')).toBe(11500);expect(sum('netSales','USD')).toBe(1000);
  const credit = report.tables.find(t => t.dataset==='credit')!;expect(credit.rows.map(row=>row.status)).toContain('Reversal');expect(credit.rows.at(-1)?.balance).toEqual({minor:15000,currency:'BDT'});
  const purchases = report.tables.find(t => t.dataset==='purchases')!;expect(purchases.rows.find(row => row.id===purchase.id)?.amount).toEqual({minor:30003,currency:'BDT'});expect(purchases.rows.find(row => row.status==='Undone')?.net).toEqual({minor:0,currency:'BDT'});
  expect(report.tables.find(t=>t.dataset==='stock')?.rows.map(row => row.after)).toEqual([20,18.875,20]);
  expect(JSON.stringify(report)).not.toContain('+8801712345483');expect(report.notes.join(' ')).toContain('Phone fields masked');
});
test('CSV preserves UTF-8 Bengali, RFC quoting and exact decimals while neutralising text formulas',async () => {
  const {backup} = await fixture(),report = buildExportReport(backup,{datasets:['customers','credit'],period:{preset:'all'},includePhones:true}),table = report.tables.find(t=>t.dataset==='customers')!,csv = exportCsv(table);
  expect(csv.charCodeAt(0)).toBe(0xfeff);expect(csv).toContain('রিনা');expect(csv).toContain('"কম চিনি, ""ভালো""\nদ্বিতীয় লাইন"');expect(csv).toContain('"\'=1+1"');expect(csv).toContain('"\'+8801712345483"');expect(csv.endsWith('\r\n')).toBe(true);
  const sheet = read(csv,{type:'string',raw:true}).Sheets.Sheet1,rows = utils.sheet_to_json(sheet,{header:1}) as string[][];
  expect(rows[1][table.columns.findIndex(c=>c.key==='name')]).toBe('রিনা');expect(rows[1][table.columns.findIndex(c=>c.key==='notes')]).toBe('কম চিনি, "ভালো"\nদ্বিতীয় লাইন');
  expect(exportDecimal(Number.MAX_SAFE_INTEGER,'BDT')).toBe('90071992547409.91');expect(exportDecimal(-1001,'USD')).toBe('-10.01');expect(exportDecimal(123,'JPY')).toBe('123');
  const amountCsv = exportCsv(report.tables.find(t=>t.dataset==='credit')!);expect(amountCsv).toContain('"-50.00"');expect(amountCsv).not.toContain("'-50.00");
  const huge:ExportTable = {dataset:'sales',name:'Sales',columns:[{key:'amount',label:'Amount'},{key:'text',label:'Note'}],rows:[{amount:{minor:Number.MAX_SAFE_INTEGER,currency:'BDT'},text:' \t@SUM(A1)'}]};
  expect(exportCsv(huge)).toContain('"\'90071992547409.91"');expect(exportCsv(huge)).toContain('"\' \t@SUM(A1)"');
});
test('XLSX reopens with all six sheets, Bengali text, native numbers, literal formulas and precise large amounts',async () => {
  const {backup} = await fixture(),report = buildExportReport(backup,{datasets:[...exportDatasets],period:{preset:'all'},includePhones:true});
  const customers = report.tables.find(t=>t.dataset==='customers')!;customers.rows[0].name = '=HYPERLINK("https://example.invalid")';
  const sales = report.tables.find(t=>t.dataset==='sales')!;sales.rows[0].amount = {minor:Number.MAX_SAFE_INTEGER,currency:'BDT'};
  const blob = exportXlsx(report);expect(blob.type).toContain('spreadsheetml');const book = read(await blob.arrayBuffer(),{type:'array'});
  expect(book.SheetNames).toEqual(['Read me','Orders','Sales','Credit','Stock moves','Customers','Purchases']);
  const cellAt = (table:ExportTable,row:number,key:string) => book.Sheets[table.name][utils.encode_cell({r:row+1,c:table.columns.findIndex(c=>c.key===key)})];
  expect(cellAt(customers,0,'name')).toMatchObject({t:'s',v:'=HYPERLINK("https://example.invalid")'});expect(cellAt(customers,0,'name').f).toBeUndefined();expect(cellAt(customers,0,'phone').v).toBe('+8801712345483');expect(cellAt(customers,0,'notes').v).toContain('দ্বিতীয় লাইন');
  expect(cellAt(sales,0,'amount')).toMatchObject({t:'s',v:'90071992547409.91'});expect(cellAt(sales,1,'amount').t).toBe('n');
});
test('date and selected-record filters do not erase opening balances from a credit statement',async () => {
  const {backup,customer} = await fixture(),source = structuredClone(backup);source.tables.creditEntries.find(entry => entry.type==='adjustment' && !entry.reversalOf)!.createdAt = at-86400000;
  const report = buildExportReport(source,{datasets:['credit','customers'],period:{preset:'today'},recordIds:{customers:[customer.id]},columns:{credit:['customer','delta','balance']}});
  const credit = report.tables.find(t=>t.dataset==='credit')!;expect(credit.rows).toHaveLength(4);expect(credit.rows.at(-1)?.balance).toEqual({minor:15000,currency:'BDT'});expect(credit.columns.map(c=>c.key)).toContain('currency');
  expect(report.tables.find(t=>t.dataset==='customers')?.rows).toHaveLength(1);
  expect(buildExportReport(source,{datasets:['orders'],period:{preset:'custom',from:'2020-01-01',to:'2020-01-02'}}).rowCount).toBe(0);
  expect(() => buildExportReport(source,{datasets:['sales','sales'],period:{preset:'all'}})).toThrow(/different datasets/);
});
