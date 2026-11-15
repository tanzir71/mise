import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import jsQR from 'jsqr';
async function start(page: Page, width = 390) {
  await page.setViewportSize({width,height:900});
  await page.goto('app/');
  await page.getByRole('radio',{name:/^Corner shop/}).check(); await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('radio',{name:/^Bangladesh/}).check(); await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('Shop name',{exact:true}).fill('Rahman Store'); await page.getByLabel('Phone number',{exact:true}).fill('01712345482');
  await page.getByRole('button',{name:'Open Mise',exact:true}).click();
  await page.locator(width >= 1024 ? '.app-sidebar a[href$="/counter"]' : '.app-bottom-nav a[href$="/counter"]').click();
  await expect(page.locator('.counter-page')).toHaveAttribute('aria-busy','false');
}
test('ten cash sales take under sixty seconds with only the keypad, including offline reload', async ({page,context}) => {
  await start(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange',() => resolve(),{once:true})); });
  await context.setOffline(true);
  const started = Date.now();
  for (let index=0; index<10; index++) {
    await page.locator('.counter-keypad [data-key="7"]').click(); await page.locator('.counter-keypad [data-key="5"]').click();
    await expect(page.locator('.counter-cash')).toHaveText('Cash ৳75'); await page.locator('.counter-cash').click();
    await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');
  }
  expect(Date.now()-started).toBeLessThan(60000);
  await expect(page.locator('.counter-log>summary')).toHaveText('Sales log · 10 sales');
  await page.reload(); await expect(page.locator('.counter-log>summary')).toHaveText('Sales log · 10 sales');
  await expect(page.locator('.counter-heading')).toContainText('৳750');
  await page.locator('.app-bottom-nav').getByRole('link',{name:'Today',exact:true}).click();
  await expect(page.locator('[data-metric=sales]')).toContainText('৳750');
});
for (const width of [390,1440]) test(`cash change, genuine receipt QR and audited undo at ${width}px`, async ({page}) => {
  await start(page,width); await page.getByLabel('Calculation',{exact:true}).fill('75+150+20');
  await page.locator('.counter-given').getByRole('button',{name:'৳500',exact:true}).click();
  await expect(page.locator('.counter-given')).toContainText('Change ৳255'); await page.locator('.counter-cash').click();
  await page.getByRole('button',{name:'Show receipt QR',exact:true}).click();
  const qr = page.getByRole('img',{name:'QR code containing this receipt',exact:true}); await expect(qr).toBeVisible();
  const pixels = await qr.evaluate((image: HTMLImageElement) => { const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight; const context=canvas.getContext('2d')!; context.drawImage(image,0,0); return {width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)}; });
  const decoded = jsQR(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height);
  expect(decoded?.data).toBe(await page.locator('.receipt-text pre').textContent());
  expect(decoded?.data).toContain('Total: ৳245 · Cash'); expect(decoded?.data).toContain('Change: ৳255');
  const axe = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(); expect(axe.violations).toEqual([]);
  if (width===390) {
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{value:{writeText:async () => { throw Error('Blocked'); }},configurable:true}));
    await page.getByRole('button',{name:'Copy receipt',exact:true}).click(); await expect(page.getByRole('textbox',{name:'Receipt text',exact:true})).toHaveValue(decoded!.data);
  }
  await page.getByRole('button',{name:'Next sale',exact:true}).click();
  if (width<1024) await page.locator('.counter-log>summary').click();
  await page.locator('.counter-log').getByRole('button',{name:'Undo sale',exact:true}).click();
  await expect(page.locator('.sale-rows article')).toHaveAttribute('data-voided','true');
  await page.reload(); await expect(page.locator('.counter-heading')).toContainText('৳0');
});
test('item naming hides unavailable items and keeps names in the receipt', async ({page}) => {
  await start(page,1440);
  await page.locator('.app-sidebar a[href$="/catalogue"]').click(); await page.getByRole('switch',{name:'Available: Rice',exact:true}).click();
  await page.locator('.app-sidebar a[href$="/counter"]').click(); await page.getByLabel('Calculation',{exact:true}).fill('25');
  await page.getByRole('button',{name:'Name items (optional)',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Name items (optional)',exact:true});
  await dialog.getByRole('searchbox',{name:'Search items',exact:true}).fill('Rice'); await expect(dialog.getByText('No items match your search.',{exact:true})).toBeVisible();
  await dialog.getByRole('searchbox').fill('Soap'); await dialog.locator('.counter-item-list button').click(); await dialog.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Who?',exact:true}).click(); await page.getByLabel('Name (optional)',{exact:true}).fill('Akter apa'); await page.getByRole('button',{name:'Use this name',exact:true}).click();
  await page.locator('.counter-cash').click(); await page.getByRole('button',{name:'Show receipt QR',exact:true}).click();
  await expect(page.locator('.receipt-text pre')).toContainText('For: Akter apa'); await expect(page.locator('.receipt-text pre')).toContainText('1 × Soap');
});
test('wallet payments require explicit confirmation and preserve the selected method', async ({page}) => {
  await start(page); await page.getByLabel('Calculation',{exact:true}).fill('910'); await page.getByRole('button',{name:'bKash',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Record a payment',exact:true});
  await expect(dialog).toBeVisible();
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  await expect(page.locator('.counter-log>summary')).toContainText('0 sales'); await dialog.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('Nagad');
  await dialog.getByRole('button',{name:'Payment received',exact:true}).click(); await expect(page.locator('.counter-success')).toContainText('Paid ৳910 · Nagad');
});
test('Say it previews an amount and is hidden offline', async ({page,context}) => {
  await page.addInitScript(() => { class FakeRecognition { onresult?: (event:{results:{transcript:string}[][]}) => void; onend?: () => void; start() { setTimeout(() => { this.onresult?.({results:[[{transcript:'seventy five plus twenty'}]]}); this.onend?.(); },0); } abort() { this.onend?.(); } } Object.defineProperty(window,'SpeechRecognition',{value:FakeRecognition,configurable:true}); });
  await start(page); await page.getByRole('button',{name:'Say it',exact:true}).click();
  await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('75+20'); await expect(page.locator('.counter-log>summary')).toContainText('0 sales');
  await context.setOffline(true); await expect(page.getByRole('button',{name:'Say it',exact:true})).toHaveCount(0);
});
test('manual cash given validates the amount and retains the resulting change', async ({page}) => {
  await start(page); await page.getByLabel('Calculation',{exact:true}).fill('245');
  await page.locator('.given-entry').click(); const dialog=page.getByRole('dialog',{name:'Given',exact:true});
  await dialog.getByLabel('Amount given',{exact:true}).fill('200'); await dialog.getByRole('button',{name:'Use this amount',exact:true}).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter an amount that covers the total.');
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  await dialog.getByLabel('Amount given',{exact:true}).fill('260'); await dialog.getByRole('button',{name:'Use this amount',exact:true}).click();
  await expect(page.locator('.counter-given')).toContainText('Change ৳15'); await page.locator('.counter-cash').click();
  await expect(page.locator('.counter-success')).toContainText('Paid ৳245');
});
test('a rapid repeated cash click records one sale', async ({page}) => {
  await start(page); await page.getByLabel('Calculation',{exact:true}).fill('25');
  await page.locator('.counter-cash').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.locator('.counter-log>summary')).toHaveText('Sales log · 1 sale');
});
test('an oversized receipt keeps its complete text when one QR cannot hold it', async ({page}) => {
  await start(page,1440); await page.locator('.app-sidebar a[href$="/catalogue"]').click();
  await page.getByRole('button',{name:'Paste a list',exact:true}).click(); const dialog=page.getByRole('dialog',{name:'Add many at once',exact:true});
  const names=Array.from({length:25},(_,index) => `Receipt long ${index} ${'item '.repeat(18)}`.trim());
  await dialog.getByRole('textbox',{name:'Paste a list',exact:true}).fill(names.map(name => `${name}, 1`).join('\n'));
  await dialog.getByRole('button',{name:'Preview',exact:true}).click(); await dialog.getByRole('button',{name:'Add 25 items',exact:true}).click();
  await page.locator('.app-sidebar a[href$="/counter"]').click(); await page.getByLabel('Calculation',{exact:true}).fill('25-24');
  await page.getByRole('button',{name:'Name items (optional)',exact:true}).click(); const picker=page.getByRole('dialog',{name:'Name items (optional)',exact:true});
  await picker.getByRole('searchbox').fill('Receipt long');
  for (const button of await picker.locator('.counter-item-list>button').all()) await button.click();
  await picker.getByRole('button',{name:'Done',exact:true}).click(); await page.locator('.counter-cash').click();
  await page.getByRole('button',{name:'Show receipt QR',exact:true}).click();
  await expect(page.locator('.receipt-card')).toContainText('Couldn’t create this receipt QR. Copy the receipt text instead.');
  for (const name of names) await expect(page.locator('.receipt-text pre')).toContainText(name);
});
for (const width of [360,390,768,1024,1440]) test(`counter fits ${width}px`, async ({page}) => {
  await start(page,width); await page.getByLabel('Calculation',{exact:true}).fill('245');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await page.locator('.counter-cash').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if ([390,1440].includes(width)) { const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(); expect(result.violations).toEqual([]); }
});
