import { expect, test } from 'vitest';
import { chargeCreditCommand, recordCreditPaymentCommand } from '../packages/core/khata';
import { recordCreditSaleCommand } from '../packages/core/credit-sales';
import { khataReminderText, defaultCreditMessaging, saveCreditMessagingCommand, customerContactLinks, creditReceiptText } from '../packages/core/khata-messages';
import { at, creditFixture } from './credit-fixture';

test('BD reminder matches the Bangla and English templates with exact money grouping', () => {
  const {context} = creditFixture(); context.entries.push(chargeCreditCommand(148500,context,{},at).entry);
  expect(khataReminderText(context)).toBe('আসসালামু আলাইকুম Karim, Rahman Store-এ আপনার বাকি ৳1,485। সুবিধামতো দোকানে দিয়ে যান। ধন্যবাদ!\n\nHi Karim, your balance at Rahman Store is ৳1,485. Please pay when convenient at the shop. Thank you!');
});
test('international reminders default to English and use their recorded currency', () => {
  const {context} = creditFixture('OTHER'); context.entries.push(chargeCreditCommand(148500,context,{},at).entry);
  expect(khataReminderText(context)).toBe('Hi Karim, your balance at Rahman Store is $1,485. Please pay when convenient at the shop. Thank you!');
  context.account.reminder.tone = 'direct'; expect(khataReminderText(context)).toContain('$1,485 is due');
});
test('explicit language preference is respected; payment details are only included when configured', () => {
  const {context} = creditFixture(); context.entries.push(chargeCreditCommand(10000,context,{},at).entry);
  context.setup.business.languages = ['bn']; const initial = khataReminderText(context);
  expect(initial).not.toContain('Hi '); expect(initial).not.toContain(context.setup.owner.phone);
  const messaging = structuredClone(defaultCreditMessaging); messaging.paymentNote = 'bKash: +8801812345678';
  const saved = saveCreditMessagingCommand(messaging,context.setup,at); context.setup.outlet = saved.outlet;
  expect(khataReminderText(context)).toContain('bKash: +8801812345678');
  expect(saved.event).toMatchObject({command:'khata.wording',actor:{id:context.setup.owner.id},at,after:saved.outlet});
});
test('custom wording validates placeholders and substitutes customer text once without interpreting it', () => {
  const {context} = creditFixture(); context.entries.push(chargeCreditCommand(10000,context,{},at).entry);
  const input = structuredClone(defaultCreditMessaging); input.templates.gentle.en = '{name}, {amount} due at {shop}. {payment}';
  context.setup.outlet = saveCreditMessagingCommand(input,context.setup,at).outlet;
  context.customer.nickname = '$& {amount}';
  expect(khataReminderText(context)).toContain('$& {amount}, ৳100 due at Rahman Store.');
  input.templates.gentle.en = '{name}, {shop}'; expect(() => saveCreditMessagingCommand(input,context.setup,at)).toThrow(/amount/);
  input.templates.gentle.en = '{name}, {shop}, {amount}, {surprise}'; expect(() => saveCreditMessagingCommand(input,context.setup,at)).toThrow(/optional/);
});
test('oversized expanded wording fails clearly instead of silently truncating the message', () => {
  const {context} = creditFixture(); context.customer.nickname = 'A'.repeat(80);
  const input = structuredClone(defaultCreditMessaging); input.templates.gentle.en = '{name}'.repeat(100)+' {amount} {shop}';
  context.setup.outlet = saveCreditMessagingCommand(input,context.setup,at).outlet;
  expect(() => khataReminderText(context)).toThrow(/too long/);
});
test('WhatsApp and call links use E.164; phone-less customers retain the manual message path', () => {
  const {context} = creditFixture(), text = 'Karim, ৳100 & thanks';
  expect(customerContactLinks(context,text)).toEqual({whatsapp:`https://wa.me/8801712345482?text=${encodeURIComponent(text)}`,call:'tel:+8801712345482'});
  context.customer.phone = undefined; expect(customerContactLinks(context,text)).toEqual({});
  expect(khataReminderText(context)).toContain('Karim');
});
test('credit and payment receipts reflect the saved transaction and resulting balance', () => {
  const {context,saleContext} = creditFixture();
  const command = recordCreditSaleCommand({expression:'245',accountId:context.account.id,customerId:context.customer.id},context,saleContext,at); context.entries.push(command.entry);
  expect(creditReceiptText(context,command.sale)).toContain('added ৳245 to your credit account. Your balance is ৳245.');
  const paid = recordCreditPaymentCommand(10000,'cash',undefined,context,[],'',at+1); context.entries.push(paid.entry);
  expect(creditReceiptText(context,undefined,paid.entry)).toContain('recorded your ৳100 payment. Your remaining balance is ৳145.');
  expect(() => creditReceiptText(context)).toThrow(/do not match/);
  expect(() => creditReceiptText(context,{...command.sale,customerId:'other'})).toThrow(/do not match/);
});
