import { ulid } from 'ulid';
import { formatMoney } from './money';
import { waLink } from './phone';
import { creditBalance, validateCreditContext, type LedgerContext } from './khata';
import type { AuditEvent, CreditMessaging, CreditEntry, Sale, SetupSnapshot } from './models';
export const defaultCreditMessaging: CreditMessaging = {
  paymentNote:'',
  templates:{
    gentle:{en:'Hi {name}, your balance at {shop} is {amount}. Please pay when convenient at the shop. {payment} Thank you!',bn:'আসসালামু আলাইকুম {name}, {shop}-এ আপনার বাকি {amount}। সুবিধামতো দোকানে দিয়ে যান। {payment} ধন্যবাদ!'},
    direct:{en:'Hi {name}, {amount} is due at {shop}. Please settle your balance. {payment} Thank you.',bn:'আসসালামু আলাইকুম {name}, {shop}-এ আপনার বাকি {amount}। অনুগ্রহ করে বাকি পরিশোধ করুন। {payment} ধন্যবাদ!'},
  },
};
export function saveCreditMessagingCommand(input: CreditMessaging, setup: SetupSnapshot, at = Date.now()) {
  if (input.paymentNote.trim().length > 250) throw new Error('Keep payment instructions within 250 characters.');
  const templates = structuredClone(input.templates);
  for (const tone of ['gentle','direct'] as const) for (const language of ['en','bn'] as const) {
    const template = templates[tone][language].trim();
    if (template.length > 1000 || !['name','shop','amount'].every(token => template.includes(`{${token}}`)) || [...template.matchAll(/\{([^}]+)\}/g)].some(match => !['name','shop','amount','payment'].includes(match[1]))) throw new Error('Use {name}, {shop} and {amount}; {payment} is optional. Keep each template within 1,000 characters.');
    templates[tone][language] = template;
  }
  const outlet = {...setup.outlet,creditMessaging:{paymentNote:input.paymentNote.trim(),templates},updatedAt:at};
  const event: AuditEvent = {id:ulid(at),outletId:outlet.id,actor:{type:'member',id:setup.owner.id},command:'khata.wording',before:setup.outlet,after:outlet,at};
  return {outlet,event};
}
const oneLine = (value: string) => value.replace(/\s+/g,' ').trim();
function combine(en: string, bn: string, setup: SetupSnapshot): string {
  const message = [setup.business.languages.includes('bn') && bn,setup.business.languages.includes('en') && en].filter(Boolean).join('\n\n');
  if (message.length > 4000) throw new Error('The message is too long. Shorten the wording.');
  return message;
}
export function khataReminderText(context: LedgerContext): string {
  validateCreditContext(context,false);
  const config = context.setup.outlet.creditMessaging || defaultCreditMessaging, template = config.templates[context.account.reminder.tone];
  const values: Record<string,string> = {name:oneLine(context.customer.nickname || context.customer.name),shop:oneLine(context.setup.business.name),amount:formatMoney(creditBalance(context.account,context.entries),context.account.currency),payment:config.paymentNote};
  const render = (text: string) => text.replace(/\{(name|shop|amount|payment)\}/g,(_match,key: string) => values[key]).replace(/[ \t]+/g,' ').trim();
  return combine(render(template.en),render(template.bn),context.setup);
}
export function creditReceiptText(context: LedgerContext, sale?: Sale, payment?: CreditEntry): string {
  validateCreditContext(context,false);
  if ((!sale && !payment) || (sale && payment) || (sale && (sale.method !== 'credit' || sale.customerId !== context.customer.id || sale.creditAccountId !== context.account.id || sale.currency !== context.account.currency)) || (payment && (payment.accountId !== context.account.id || payment.type !== 'payment' || payment.currency !== context.account.currency || payment.customerId !== context.customer.id))) throw new Error('Receipt and khata do not match.');
  const name = oneLine(context.customer.nickname || context.customer.name), shop = oneLine(context.setup.business.name), balance = formatMoney(creditBalance(context.account,context.entries),context.account.currency);
  const amount = formatMoney(sale?.amount ?? payment?.amount ?? 0,context.account.currency);
  return combine(payment ? `Hi ${name}, ${shop} recorded your ${amount} payment. Your remaining balance is ${balance}. Thank you!` : `Hi ${name}, ${shop} added ${amount} to your credit account. Your balance is ${balance}. Thank you!`,payment ? `${name}, ${shop}-এ আপনার ${amount} পরিশোধ লেখা হয়েছে। এখন বাকি ${balance}। ধন্যবাদ!` : `${name}, ${shop}-এ আপনার ${amount} কেনাকাটা বাকিতে লেখা হয়েছে। মোট বাকি ${balance}। ধন্যবাদ!`,context.setup);
}
export function customerContactLinks(context: LedgerContext, text: string): { whatsapp?: string; call?: string } {
  validateCreditContext(context,false);
  const phone = context.customer.phone;
  return phone ? {whatsapp:waLink(phone,text),call:`tel:${phone}`} : {};
}
