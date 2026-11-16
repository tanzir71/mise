import type { MiseBackup } from './backup-tables';
import { exportPeriod, inExportPeriod, type ExportPeriod, type ExportPeriodInput } from './export-period';
import { currencyDigits } from './money';
import { entryDelta } from './khata';
import { saleCashIn, refundCashOut } from './order-payments';

export const exportDatasets = ['orders','sales','credit','stock','customers','purchases'] as const;
export type ExportDataset = typeof exportDatasets[number];
export type ExportCell = string|number|null|{minor:number;currency:string};
export interface ExportColumn {key:string;label:string}
export interface ExportTable {dataset:ExportDataset;name:string;columns:ExportColumn[];rows:Record<string,ExportCell>[]}
export interface ExportOptions {
  datasets:ExportDataset[];period:ExportPeriodInput;includePhones?:boolean;
  columns?:Partial<Record<ExportDataset,string[]>>;recordIds?:Partial<Record<ExportDataset,string[]>>;
}
export interface ExportReport {
  shopName:string;outletName:string;timezone:string;createdAt:number;period:ExportPeriod;tables:ExportTable[];rowCount:number;notes:string[];
}
const names:Record<ExportDataset,string> = {orders:'Orders',sales:'Sales',credit:'Credit',stock:'Stock moves',customers:'Customers',purchases:'Purchases'};
export function exportDecimal(amount:number,currency:string):string {
  if (!Number.isSafeInteger(amount)) throw new Error('Export money must use integer minor units.');
  const digits = currencyDigits(currency), value = BigInt(amount), magnitude = value < 0n ? -value : value,divisor = 10n**BigInt(digits);
  return `${value < 0n ? '-' : ''}${magnitude/divisor}${digits ? `.${(magnitude%divisor).toString().padStart(digits,'0')}` : ''}`;
}
const money = (minor:number,currency:string):ExportCell => ({minor,currency});
const checked = (n:bigint) => {if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('An exported balance exceeds the supported amount.');return Number(n);};
const ordered = <T extends {id:string;createdAt:number}>(rows:T[]) => [...rows].sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id));
const label = (text:string) => text.replaceAll('_',' ').replace(/^./,c => c.toUpperCase());

/** A report is a read-only projection of one consistent local snapshot. */
export function buildExportReport(backup:MiseBackup,options:ExportOptions,at = Date.now()):ExportReport {
  const t = backup.tables,business = t.businesses[0],outlet = t.outlets[0];
  if (!business || !outlet) throw new Error('Set up your shop before exporting.');
  if (!options.datasets.length || new Set(options.datasets).size !== options.datasets.length || options.datasets.some(key => !exportDatasets.includes(key))) throw new Error('Choose one or more different datasets.');
  const period = exportPeriod(options.period,outlet.timezone,business.marketCode,at),tables:ExportTable[] = [];
  const phone = (value?:string) => !value ? '' : options.includePhones ? value : `${value.slice(0,4)}•••${value.slice(-4)}`;
  const dateFormat = new Intl.DateTimeFormat('sv-SE',{timeZone:outlet.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const local = (at?:number) => at === undefined ? '' : dateFormat.format(at);
  const utc = (at?:number) => at === undefined ? '' : new Date(at).toISOString();
  const members = new Map(t.members.map(m => [m.id,m.name])),customers = new Map(t.customers.map(c => [c.id,c]));
  const customerName = (id:string) => {const customer = customers.get(id);return customer?.nickname || customer?.name || '';};
  const orders = new Map(t.orders.map(order => [order.id,order]));
  const orderNotes = new Map<string,string[]>();
  for (const note of [...t.orderNotes,...t.orderCommunications].sort((a,b) => a.createdAt-b.createdAt || a.revision-b.revision)) {const group=orderNotes.get(note.orderId) || [];group.push(`${utc(note.createdAt)} ${note.text}`);orderNotes.set(note.orderId,group);}
  const inPeriod = (record:{createdAt:number}) => inExportPeriod(record.createdAt,period);
  function table(dataset:ExportDataset,headings:[string,string][],rows:Record<string,ExportCell>[]) {
    let columns = headings.map(([key,label]) => ({key,label}));const requested = options.columns?.[dataset];
    if (requested) {
      if (!requested.length || new Set(requested).size !== requested.length || requested.some(key => !columns.some(c => c.key === key))) throw new Error('Choose supported export columns.');
      const selected = new Set(requested);
      if (rows.some(row => requested.some(key => typeof row[key] === 'object' && row[key] !== null))) selected.add('currency');
      columns = columns.filter(column => selected.has(column.key));
    }
    const ids = options.recordIds?.[dataset];
    if (ids) {const selected = new Set(ids);rows = rows.filter(row => typeof row.id === 'string' && selected.has(row.id));}
    tables.push({dataset,name:names[dataset],columns,rows});
  }
  for (const dataset of exportDatasets.filter(key => options.datasets.includes(key))) {
    if (dataset === 'orders') table(dataset,[['number','Order'],['created','Created (shop time)'],['customer','Customer'],['phone','Phone'],['source','Source'],['type','Fulfilment'],['status','Status'],['items','Items'],['notes','Notes and messages'],['payment','Payment'],['total','Total'],['currency','Currency'],['deliveryFee','Delivery fee'],['discount','Discount'],['address','Address / table'],['scheduled','Scheduled (shop time)'],['id','Record ID'],['createdUtc','Created UTC']],[...t.orders.filter(inPeriod)].sort((a,b) => a.createdAt-b.createdAt || a.sequence-b.sequence).map(order => ({
      id:order.id,number:order.number,created:local(order.createdAt),createdUtc:utc(order.createdAt),customer:order.customer.name,phone:phone(order.customer.phone),source:order.sourceText || label(order.source),type:label(order.type),status:label(order.status),
      notes:(orderNotes.get(order.id) || []).join('\n'),items:order.lines.map(line => `${line.qty} ${line.unit} ${line.name}${line.unitPrice === null ? '' : ` @ ${exportDecimal(line.unitPrice,order.currency)}`}${line.unavailable ? ' [unavailable]' : ''}${line.unitPrice === null ? ' [unpriced]' : ''}${line.note ? ` (${line.note})` : ''}`).join('\n'),
      payment:`${order.payment.wallet || label(order.payment.method)} · ${order.payment.status}`,total:order.total === null ? null : money(order.total,order.currency),currency:order.currency,deliveryFee:money(order.deliveryFee,order.currency),discount:money(order.discount,order.currency),address:order.address || order.table,scheduled:local(order.scheduledFor),
    })));
    if (dataset === 'sales') {
      const rows = [
        ...t.sales.filter(inPeriod).map(sale => ({id:sale.id,createdAt:sale.createdAt,row:{id:sale.id,kind:'Sale',created:local(sale.createdAt),createdUtc:utc(sale.createdAt),order:sale.orderNumber || '',who:sale.who,method:sale.methodName,status:sale.voidedAt === undefined ? 'Recorded' : sale.voidReason === 'order-cancel' ? 'Order cancelled' : 'Undone',amount:money(sale.amount,sale.currency),netSales:money(sale.voidedAt === undefined ? sale.amount : 0,sale.currency),cashMovement:money(saleCashIn(sale),sale.currency),currency:sale.currency,items:sale.items.map(line => `${line.qty} ${line.unit} ${line.name}`).join('\n'),given:sale.given === undefined ? null : money(sale.given,sale.currency),change:sale.change === undefined ? null : money(sale.change,sale.currency),actor:members.get(sale.createdBy) || sale.createdBy,original:sale.id}})),
        ...t.orderRefunds.filter(inPeriod).map(refund => ({id:refund.id,createdAt:refund.createdAt,row:{id:refund.id,kind:'Refund',created:local(refund.createdAt),createdUtc:utc(refund.createdAt),order:orders.get(refund.orderId)?.number || '',who:refund.customerId ? customerName(refund.customerId) : '',method:refund.methodName,status:refund.voidedAt === undefined ? 'Recorded' : 'Undone',amount:money(-refund.amount,refund.currency),netSales:money(0,refund.currency),cashMovement:money(-refundCashOut(refund),refund.currency),currency:refund.currency,items:refund.note,given:null,change:null,actor:members.get(refund.createdBy) || refund.createdBy,original:refund.saleId}})),
      ];
      table(dataset,[['kind','Type'],['created','Recorded (shop time)'],['order','Order'],['who','Customer / note'],['method','Method'],['status','Status'],['amount','Original amount'],['netSales','Net sales'],['cashMovement','Cash movement'],['currency','Currency'],['items','Items / refund note'],['given','Cash given'],['change','Change'],['actor','Recorded by'],['id','Record ID'],['original','Original sale ID'],['createdUtc','Recorded UTC']],ordered(rows).map(record => record.row));
    }
    if (dataset === 'credit') {
      const rows:Record<string,ExportCell>[] = [],groups = new Map<string,typeof t.creditEntries>();
      for (const entry of t.creditEntries) {const records = groups.get(entry.accountId) || [];records.push(entry);groups.set(entry.accountId,records);}
      for (const account of t.creditAccounts) {
        const entries = [...(groups.get(account.id) || [])].sort((a,b) => a.sequence-b.sequence),reversed = new Set(entries.map(e => e.reversalOf).filter(Boolean));let balance = 0n;
        for (const entry of entries) {
          const delta = entryDelta(entry);balance += BigInt(delta);
          if (!inPeriod(entry)) continue;
          rows.push({id:entry.id,created:local(entry.createdAt),createdUtc:utc(entry.createdAt),sequence:entry.sequence,customer:customerName(entry.customerId),phone:phone(customers.get(entry.customerId)?.phone),type:label(entry.type),status:entry.reversalOf ? 'Reversal' : reversed.has(entry.id) ? 'Undone' : 'Recorded',amount:money(entry.amount,entry.currency),delta:money(delta,entry.currency),balance:money(checked(balance),entry.currency),currency:entry.currency,method:entry.methodName || '',note:entry.note,occurred:utc(entry.occurredAt),account:entry.accountId,sale:entry.saleId || '',order:entry.orderId || '',reversal:entry.reversalOf || '',actor:members.get(entry.createdBy) || entry.createdBy});
        }
      }
      table(dataset,[['created','Recorded (shop time)'],['customer','Customer'],['phone','Phone'],['type','Entry'],['status','Status'],['amount','Original amount'],['delta','Balance change'],['balance','Balance after entry'],['currency','Currency'],['method','Method'],['note','Note'],['occurred','Occurred UTC'],['sequence','Sequence'],['account','Account ID'],['sale','Sale ID'],['order','Order ID'],['reversal','Reverses ID'],['actor','Recorded by'],['id','Record ID'],['createdUtc','Recorded UTC']],rows);
    }
    if (dataset === 'stock') {
      const reversed = new Set(t.stockMoves.map(move => move.undoOf).filter(Boolean));
      table(dataset,[['created','Recorded (shop time)'],['name','Item'],['unit','Unit'],['before','Before'],['delta','Change'],['after','After'],['reason','Reason'],['status','Status'],['source','Source'],['note','Note'],['actor','Recorded by'],['item','Stock item ID'],['id','Record ID'],['reversal','Reverses ID'],['batch','Count batch ID'],['createdUtc','Recorded UTC']],[...t.stockMoves.filter(inPeriod)].sort((a,b) => a.createdAt-b.createdAt || a.stockItemId.localeCompare(b.stockItemId) || a.revision-b.revision).map(move => ({id:move.id,created:local(move.createdAt),createdUtc:utc(move.createdAt),name:move.name,unit:move.unit,before:move.before,delta:move.delta,after:move.after,reason:label(move.reason),status:move.undoOf ? 'Reversal' : reversed.has(move.id) ? 'Undone' : 'Recorded',source:label(move.source),note:move.note,actor:members.get(move.createdBy) || move.createdBy,item:move.stockItemId,reversal:move.undoOf || '',batch:move.countBatchId || ''})));
    }
    if (dataset === 'customers') {
      const balances = new Map<string,bigint>();for (const entry of t.creditEntries) balances.set(entry.accountId,(balances.get(entry.accountId) || 0n)+BigInt(entryDelta(entry)));
      table(dataset,[['name','Name'],['nickname','Nickname'],['phone','Phone'],['address','Address'],['tags','Tags'],['notes','Notes'],['balances','Balances now'],['status','Status'],['created','Added (shop time)'],['id','Record ID'],['createdUtc','Added UTC']],ordered(t.customers.filter(inPeriod)).map(customer => ({id:customer.id,name:customer.name,nickname:customer.nickname,phone:phone(customer.phone),address:customer.address,tags:customer.tags.join(', '),notes:customer.notes,status:customer.archivedAt === undefined ? 'Active' : 'Archived',created:local(customer.createdAt),createdUtc:utc(customer.createdAt),balances:t.creditAccounts.filter(account => account.customerId === customer.id).map(account => `${account.currency} ${exportDecimal(checked(balances.get(account.id) || 0n),account.currency)}`).join('; ')})));
    }
    if (dataset === 'purchases') table(dataset,[['created','Recorded (shop time)'],['supplier','Supplier'],['reference','Invoice'],['items','Items'],['amount','Original total'],['net','Net purchases'],['currency','Currency'],['paid','Payment'],['status','Status'],['note','Note'],['actor','Recorded by'],['id','Record ID'],['createdUtc','Recorded UTC']],ordered(t.purchases.filter(inPeriod)).map(purchase => ({id:purchase.id,created:local(purchase.createdAt),createdUtc:utc(purchase.createdAt),supplier:purchase.supplierName,reference:purchase.reference,items:purchase.lines.map(line => `${line.qty} ${line.unit} ${line.name} @ ${exportDecimal(line.unitPrice,purchase.currency)} = ${exportDecimal(line.lineTotal,purchase.currency)}`).join('\n'),amount:money(purchase.total,purchase.currency),net:money(purchase.voidedAt === undefined ? purchase.total : 0,purchase.currency),currency:purchase.currency,paid:purchase.methodName,status:purchase.voidedAt === undefined ? 'Recorded' : 'Undone',note:purchase.note,actor:members.get(purchase.createdBy) || purchase.createdBy})));
  }
  return {shopName:business.name,outletName:outlet.name,timezone:outlet.timezone,createdAt:at,period,tables,rowCount:tables.reduce((count,table) => count+table.rows.length,0),notes:[
    'Dates use the shop timezone. Customer date filters use the date added; balances are current.',
    'Original amounts retain undone records. Net sales exclude cancelled/undone sales; refunds are listed separately and do not reduce net sales twice.',
    'Each money cell retains its currency. Credit balances include entries before the selected range.',
    options.includePhones ? 'Full phone numbers included.' : 'Phone fields masked. JSON backups always retain full records.',
  ]};
}

export function exportCellText(value:ExportCell):string {return value === null ? '' : typeof value === 'object' ? exportDecimal(value.minor,value.currency) : String(value);}
export function exportCsv(table:ExportTable):string {
  const quote = (value:ExportCell) => {
    let text = exportCellText(value);
    // Quoting alone does not stop spreadsheet formulas. Only text is escaped; real negative numbers remain numeric.
    if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
    if (value !== null && typeof value === 'object' && text.replace(/[-.]/g,'').replace(/^0+/,'').length > 15) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  return '\uFEFF'+[table.columns.map(column => quote(column.label)).join(','),...table.rows.map(row => table.columns.map(column => quote(row[column.key] ?? null)).join(','))].join('\r\n')+'\r\n';
}
