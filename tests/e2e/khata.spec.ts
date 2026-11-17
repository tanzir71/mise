import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function start(page: Page, width = 390, market = 'Bangladesh') {
  await page.setViewportSize({width,height:900});
  await page.goto('app/');
  await page.getByRole('radio',{name:/^Corner shop/}).check(); await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('radio',{name:new RegExp(`^${market}`)}).check(); await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('Shop name',{exact:true}).fill('Rahman Store'); await page.getByLabel('Phone number',{exact:true}).fill(market === 'Bangladesh' ? '01712345482' : '+12025550123');
  await page.getByRole('button',{name:'Open Mise',exact:true}).click(); await go(page,'khata');
  await expect(page.locator('.khata-page')).toHaveAttribute('aria-busy','false');
}
async function go(page:Page,path:string) { await page.locator(`.app-sidebar a[href$="/${path}"],.app-bottom-nav a[href$="/${path}"]`).filter({visible:true}).click(); }
async function customer(page:Page, name = 'Karim bhai', limit = '1000', opening = '', reminder = false, currency = 'BDT') {
  await page.getByRole('button',{name:'New customer',exact:true}).click();
  const form = page.getByRole('dialog',{name:'New customer',exact:true});
  await form.getByLabel('Name',{exact:true}).fill(name); await form.getByLabel('Phone (optional)',{exact:true}).fill(currency === 'BDT' ? '01711222482' : '+12025550124');
  await form.getByRole('switch',{name:'Allow credit',exact:true}).click();
  await form.getByLabel(`Credit limit (${currency})`,{exact:true}).fill(limit);
  if (opening) { await form.getByLabel(`Opening balance (${currency})`,{exact:true}).fill(opening); if (reminder) await form.getByLabel('Balance since',{exact:true}).fill('2026-10-01'); }
  if (reminder) { await form.getByRole('switch',{name:'Monthly reminder',exact:true}).click(); await form.getByLabel('Day of month',{exact:true}).fill('1'); }
  await form.getByRole('button',{name:'Save customer',exact:true}).click(); await expect(form).not.toBeVisible();
  await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
}
async function credit(page:Page, amount = '245') {
  await go(page,'counter'); await page.getByLabel('Calculation',{exact:true}).fill(amount);
  await page.getByRole('button',{name:'Baki',exact:true}).click();
  return page.getByRole('dialog');
}
async function accessible(page:Page) {
  const result = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  expect(result.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('offline credit sale, bilingual receipt, payment and reversal retain an attributable history', async ({page,context}) => {
  await start(page); await customer(page,'Karim bhai','1000','100',true);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange',() => resolve(),{once:true})); });
  await context.setOffline(true);
  const dialog = await credit(page);
  await dialog.getByRole('button',{name:'Add to Karim bhai’s khata',exact:true}).evaluate((button:HTMLButtonElement) => { button.click(); button.click(); });
  const receipt = page.getByRole('dialog',{name:'Share receipt',exact:true});
  await expect(receipt.getByRole('textbox',{name:'Message preview',exact:true})).toHaveValue(/মোট বাকি ৳345/);
  const href = await receipt.getByRole('link',{name:'Open WhatsApp',exact:true}).getAttribute('href'); expect(href).toMatch(/^https:\/\/wa.me\/8801711222482\?text=/); expect(decodeURIComponent(href!)).toContain('Your balance is ৳345');
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{value:{writeText:async () => { throw Error('Blocked'); }},configurable:true}));
  await receipt.getByRole('button',{name:'Copy message',exact:true}).click(); await expect(receipt.getByRole('textbox',{name:'Copy by hand',exact:true})).toHaveValue(/৳345/);
  await receipt.getByRole('button',{name:'I sent it',exact:true}).click();
  await expect(page.locator('.counter-log>summary')).toHaveText('Sales log · 1 sale'); await expect(page.locator('.counter-success')).toContainText('Added to khata ৳245');
  await go(page,'khata'); await page.locator('.khata-list a').click(); await expect(page.locator('.credit-balance>strong')).toHaveText('৳345');
  await expect(page.locator('.khata-history-list')).toContainText('Receipt sent'); await expect(page.locator('.khata-history-list')).toContainText('by');
  await page.getByRole('button',{name:'Got paid',exact:true}).click(); const payment = page.getByRole('dialog',{name:'Got paid',exact:true});
  await payment.getByLabel('Amount received (BDT)',{exact:true}).fill('346'); await payment.getByRole('button',{name:'Record payment',exact:true}).click(); await expect(payment.getByRole('alert')).toContainText('cannot exceed');
  await payment.getByLabel('Amount received (BDT)',{exact:true}).fill('100'); await payment.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('bKash'); await payment.getByRole('button',{name:'Record payment',exact:true}).click();
  await expect(page.locator('.credit-balance>strong')).toHaveText('৳245'); await accessible(page); await page.locator('.khata-history-list article').filter({hasText:'Paid by bKash'}).getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.locator('.credit-balance>strong')).toHaveText('৳345'); await page.reload(); await expect(page.locator('.credit-balance>strong')).toHaveText('৳345');
  expect(await page.locator('.khata-history-list article small').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('by Owner')]));
});

test('over-limit consent is explicit and renewed when another tab changes the balance', async ({page,context}) => {
  await start(page); await customer(page,'Karim bhai','100','50'); const profile = page.url();
  const dialog = await credit(page,'75'); await dialog.getByRole('switch',{name:'Send the receipt on WhatsApp',exact:true}).click();
  await dialog.getByRole('button',{name:'Review credit for Karim bhai',exact:true}).click(); await expect(dialog.getByRole('alert')).toContainText('৳125');
  await expect(page.locator('.counter-log>summary')).toHaveText('Sales log · 0 sales');
  const other = await context.newPage(); await other.goto(profile);
  await other.getByRole('button',{name:'Got paid',exact:true}).click(); await other.getByLabel('Amount received (BDT)',{exact:true}).fill('10'); await other.getByRole('button',{name:'Record payment',exact:true}).click();
  await expect(dialog).toContainText('This khata changed'); await expect(dialog.getByRole('button',{name:'Give anyway',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Review credit for Karim bhai',exact:true}).click(); await expect(dialog.getByRole('alert')).toContainText('৳115');
  await dialog.getByRole('button',{name:'Give anyway',exact:true}).click(); await expect(dialog).not.toBeVisible(); await other.reload(); await expect(other.locator('.credit-balance>strong')).toHaveText('৳115');
  await expect(other.locator('.khata-history-list')).toContainText('Over limit · approved by owner'); await other.close();
});

test('customer edits normalize phones, prevent duplicate contacts and preserve archived history', async ({page}) => {
  await start(page); await customer(page,'Karim bhai','1000','100'); await page.getByRole('button',{name:'Got paid',exact:true}).click(); await page.getByRole('button',{name:'Record payment',exact:true}).click(); await page.getByRole('button',{name:'Edit',exact:true}).click(); const edit = page.getByRole('dialog',{name:'Edit customer',exact:true});
  await edit.getByLabel('Nickname (optional)',{exact:true}).fill('Karim'); await edit.getByLabel('Address (optional)',{exact:true}).fill('Flat 3B, House 12'); await edit.getByLabel('Notes',{exact:true}).fill('Prefers a call.'); await edit.getByLabel('Tags (comma separated)',{exact:true}).fill('regular,Neighbour'); await edit.getByRole('button',{name:'Save customer',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Karim',exact:true})).toBeVisible(); await expect(page.locator('.customer-heading')).toContainText('+8801711222482'); await expect(page.locator('.khata-notes')).toHaveText('Prefers a call.');
  page.once('dialog',dialog => dialog.accept()); await page.getByRole('button',{name:'Archive customer',exact:true}).click(); await expect(page.getByRole('button',{name:'Restore customer',exact:true})).toBeVisible();
  await go(page,'khata'); await expect(page.getByLabel('Khata totals BDT',{exact:true})).toContainText('৳100'); await expect(page.locator('.khata-list a')).toHaveCount(0); await page.getByRole('button',{name:'Show archived customers',exact:true}).click(); await page.locator('.khata-list a').click(); await page.getByRole('button',{name:'Restore customer',exact:true}).click(); await expect(page.locator('.khata-history-list')).toContainText('Customer restored');
  await go(page,'khata'); await page.getByRole('button',{name:'New customer',exact:true}).click(); const form=page.getByRole('dialog',{name:'New customer',exact:true}); await form.getByLabel('Name',{exact:true}).fill('Another Karim'); await form.getByLabel('Phone (optional)',{exact:true}).fill('০১৭১১২২২৪৮২'); await form.getByRole('button',{name:'Save customer',exact:true}).click(); await expect(form.getByRole('alert')).toContainText('already has this number');
});

test('reminders advance one at a time, copying never marks sent, and a missing phone retains a manual path', async ({page}) => {
  await start(page); await customer(page,'Karim bhai','1000','100',true); await go(page,'khata');
  await page.getByRole('button',{name:'New customer',exact:true}).click(); const form=page.getByRole('dialog',{name:'New customer',exact:true});
  await form.getByLabel('Name',{exact:true}).fill('Akter apa'); await form.getByLabel('Opening balance (BDT)',{exact:true}).fill('200'); await form.getByLabel('Balance since',{exact:true}).fill('2026-10-01'); await form.getByRole('switch',{name:'Monthly reminder',exact:true}).click(); await form.getByLabel('Day of month',{exact:true}).fill('1'); await form.getByRole('button',{name:'Save customer',exact:true}).click();
  await go(page,'khata'); await page.getByRole('button',{name:'Due this week 2',exact:true}).click(); await expect(page.locator('.khata-list a')).toHaveCount(2); await page.getByRole('button',{name:'Start reminders',exact:true}).click();
  const reminder=page.getByRole('dialog',{name:'Send reminder',exact:true}); await expect(reminder).toContainText('2 remaining'); await reminder.getByRole('button',{name:'Skip',exact:true}).click(); await reminder.getByRole('button',{name:'I sent it',exact:true}).click();
  await expect(page.getByRole('button',{name:'Due this week 1',exact:true})).toBeVisible(); await page.getByRole('button',{name:'Start reminders',exact:true}).click(); await expect(reminder).toContainText('Akter apa'); await expect(reminder.getByRole('link',{name:'Open WhatsApp',exact:true})).toHaveCount(0);
  await reminder.getByRole('button',{name:'Close',exact:true}).click(); await page.locator('.khata-list a').click(); await expect(page.locator('.khata-history-list')).not.toContainText('Reminder sent');
});

test('international reminders use English and phone/copy/done remains explicit', async ({page}) => {
  await start(page,390,'Other'); await go(page,'counter'); await expect(page.getByRole('button',{name:'Credit',exact:true})).toBeDisabled(); await go(page,'khata'); await customer(page,'Karim','1000','100',false,'USD'); await page.getByRole('button',{name:'Remind',exact:true}).click();
  const form = page.getByRole('dialog',{name:'Send reminder',exact:true}); const text = await form.getByRole('textbox',{name:'Message preview',exact:true}).inputValue(); expect(text).toContain('$100'); expect(text).not.toMatch(/[\u0980-\u09ff]/);
  await form.getByRole('button',{name:'Close',exact:true}).click(); await page.getByRole('button',{name:'Call',exact:true}).click(); const call = page.getByRole('dialog',{name:'Call customer',exact:true}); await expect(call.getByRole('link',{name:'Call',exact:true})).toHaveAttribute('href','tel:+12025550124'); await expect(call.getByRole('button',{name:'Copy number / note',exact:true})).toBeVisible(); await call.getByRole('button',{name:'I called',exact:true}).click(); await expect(page.locator('.khata-history-list')).toContainText('Call recorded');
});

test('the counter can create a customer and invalid limits stay editable', async ({page}) => {
  await start(page); const dialog=await credit(page,'75'); await dialog.getByRole('button',{name:'Type name',exact:true}).click();
  const form=page.getByRole('dialog',{name:'New customer',exact:true}); await form.getByLabel('Name',{exact:true}).fill('Rina boudi');
  await form.getByRole('switch',{name:'Allow credit',exact:true}).click(); await form.getByLabel('Credit limit (BDT)',{exact:true}).fill('wrong'); await form.getByRole('button',{name:'Save customer',exact:true}).click(); await expect(form.getByRole('alert')).toContainText('valid credit limit');
  await form.getByLabel('Credit limit (BDT)',{exact:true}).fill('100'); await form.getByRole('button',{name:'Save customer',exact:true}).click();
  const creditForm=page.getByRole('dialog'); await creditForm.getByRole('switch',{name:'Send the receipt on WhatsApp',exact:true}).click(); await creditForm.getByRole('button',{name:'Add to Rina boudi’s khata',exact:true}).click();
  await go(page,'khata'); await page.locator('.khata-list a').click(); await expect(page.locator('.credit-balance>strong')).toHaveText('৳75');
  page.once('dialog',dialog => dialog.accept()); await page.getByRole('button',{name:'Archive customer',exact:true}).click(); await expect(page.getByRole('alert')).toContainText('Settle');
});

test('wording changes persist and current-currency accounts keep old debt separate', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-11-16T06:00:00Z'));
  await start(page,1440); await customer(page,'Karim bhai','1000','100',true);
  await go(page,'khata'); await page.getByRole('button',{name:'Change wording',exact:true}).click(); const wording=page.getByRole('dialog',{name:'Change wording',exact:true});
  await wording.getByRole('textbox',{name:'Gentle · English',exact:true}).fill('Dear {name}, {amount} is due at {shop}. {payment}'); await wording.getByRole('textbox',{name:'Payment instructions (optional)',exact:true}).fill('Pay at the counter.'); await wording.getByRole('button',{name:'Save wording',exact:true}).click();
  await page.locator('.khata-list a').click(); await expect(page.locator('.khata-preview')).toContainText('Dear Karim bhai, ৳100 is due at Rahman Store. Pay at the counter.');
  await page.locator('.app-sidebar').getByRole('link',{name:'Settings',exact:true}).click(); await page.getByRole('combobox',{name:'Currency',exact:true}).selectOption('USD'); await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await go(page,'khata'); await page.locator('.khata-list a').click(); await expect(page.locator('.credit-balance>strong')).toHaveText('৳100'); await page.getByRole('button',{name:'Open USD khata',exact:true}).click(); await page.getByRole('button',{name:'Save credit settings',exact:true}).click();
  await page.getByRole('combobox',{name:'Khata currency',exact:true}).selectOption({label:'BDT'}); await page.reload(); await expect(page.locator('.credit-balance>strong')).toHaveText('৳100');
  await page.getByRole('combobox',{name:'Khata currency',exact:true}).selectOption({label:'USD'}); await expect(page.locator('.credit-balance>strong')).toHaveText('$0');
  await go(page,'khata'); await expect(page.getByLabel('Khata totals BDT',{exact:true})).toContainText('৳100'); await expect(page.getByLabel('Khata totals USD',{exact:true})).toContainText('$0');
  await page.locator('.khata-list a').filter({hasText:'$0'}).click(); await page.getByRole('button',{name:'Change limit or reminder',exact:true}).click(); const terms=page.getByRole('dialog',{name:'Credit settings',exact:true});
  await terms.getByRole('switch',{name:'Allow credit',exact:true}).click(); await terms.getByLabel('Credit limit (USD)',{exact:true}).fill('1000'); await terms.getByRole('switch',{name:'Monthly reminder',exact:true}).click(); await terms.getByLabel('Day of month',{exact:true}).fill('1'); await terms.getByRole('button',{name:'Save credit settings',exact:true}).click();
  const sale=await credit(page,'50'); await sale.getByRole('switch',{name:'Send the receipt on WhatsApp',exact:true}).click(); await sale.getByRole('button',{name:'Add to Karim bhai’s khata',exact:true}).click();
  await expect(sale).not.toBeVisible(); await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');
  await page.clock.setFixedTime(new Date('2026-12-26T06:00:00Z')); await go(page,'khata'); await expect(page.getByRole('button',{name:'Due this week 2',exact:true})).toBeVisible(); await expect(page.getByRole('heading',{name:'Remind 1 person due this week',exact:true})).toBeVisible();
});

for (const width of [360,390,768,1024,1440]) test(`khata list, profile and credit sheet fit and meet axe at ${width}px`,async ({page}) => {
  await start(page,width); await customer(page,'Karim bhai','3000','1240',true); await accessible(page);
  await go(page,'khata'); await accessible(page); const dialog=await credit(page); await accessible(page);
  const box=await dialog.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width).toBeLessThanOrEqual(width);
  if (width < 1024) expect(await dialog.evaluate(element => Math.round(innerHeight-element.getBoundingClientRect().bottom))).toBe(0);
  else expect(Math.round(box!.width)).toBe(440);
  await dialog.getByRole('button',{name:'Close',exact:true}).click(); await expect(page.getByRole('button',{name:'Baki',exact:true})).toBeFocused();
});
