import { expect,test,type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { decodeShopPayload } from '../../packages/core/public-shop-codec';
import { normalizeBase } from '../../packages/core/paths';

async function start(page:Page,width=390){
  await page.setViewportSize({width,height:900});
  await page.addInitScript(()=>{localStorage.setItem('mise.flags',JSON.stringify({shopLinks:true}));Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as unknown as {copiedLink:string}).copiedLink=text;}}});});
  await page.goto('app/');await page.getByRole('radio',{name:/^Corner shop/}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('radio',{name:/^Bangladesh/}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('Shop name',{exact:true}).fill('Rahman Store');await page.getByLabel('Phone number',{exact:true}).fill('01712345482');await page.getByRole('button',{name:'Open Mise',exact:true}).click();
  await expect(page.locator('.app-main')).toBeVisible();await page.goto('app/more');await page.getByRole('link',{name:/Shop link Public details/}).click();await expect(page.getByRole('heading',{name:'Settings › Shop link'})).toBeVisible();
}
async function generate(page:Page){
  await page.getByRole('textbox',{name:'Opening hours',exact:true}).fill('9 am–11 pm');await page.getByRole('textbox',{name:'Delivery note',exact:true}).fill('Call at the gate · গেটে ফোন করুন');
  await page.getByRole('button',{name:'Generate shop link',exact:true}).click();await expect(page.getByRole('status')).toContainText('Shop link generated');return page.getByRole('textbox',{name:'Published shop link',exact:true}).inputValue();
}
for(const width of [360,390,768,1024,1440])test(`shop link settings are accessible and fit at ${width}px`,async({page})=>{
  await start(page,width);await page.locator('.shop-link-selection fieldset input[type=checkbox]').first().check();const url=await generate(page),shop=decodeShopPayload(new URL(url).hash.slice(1));
  expect(new URL(url).pathname).toBe(`${normalizeBase(process.env.BASE_PATH)}app/s/`);expect(shop.name).toBe('Rahman Store');expect(shop.items).toHaveLength(1);expect(shop.phone).toBe('+8801712345482');expect(shop.deliveryNote).toContain('গেটে ফোন করুন');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  for(const control of await page.locator('.shop-link-settings button:visible,.shop-link-settings a.button:visible').all()){const box=await control.boundingBox();expect(box?.height).toBeGreaterThanOrEqual(44);}
});
test('saved links survive reload offline; regeneration is distinct and undo restores the previous link',async({page,context})=>{
  await start(page);const first=await generate(page);await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
  await context.setOffline(true);await page.reload();await expect(page.getByRole('textbox',{name:'Published shop link',exact:true})).toHaveValue(first);await expect(page.getByRole('textbox',{name:'Opening hours',exact:true})).toHaveValue('9 am–11 pm');
  await page.getByRole('textbox',{name:'Opening hours',exact:true}).fill('10 am–9 pm');await page.getByRole('button',{name:'Regenerate after menu changes',exact:true}).click();await expect(page.getByRole('status')).toContainText('Shop link generated');
  await expect(page.getByRole('textbox',{name:'Published shop link',exact:true})).not.toHaveValue(first);const second=await page.getByRole('textbox',{name:'Published shop link',exact:true}).inputValue();expect(second).not.toBe(first);expect(decodeShopPayload(new URL(second).hash.slice(1))).toMatchObject({code:decodeShopPayload(new URL(first).hash.slice(1)).code,hours:'10 am–9 pm'});
  await page.getByRole('button',{name:'Undo link change',exact:true}).click();await expect(page.getByRole('status')).toContainText('previous link was restored');await expect(page.getByRole('textbox',{name:'Published shop link',exact:true})).toHaveValue(first);
  await page.reload();await expect(page.getByRole('textbox',{name:'Opening hours',exact:true})).toHaveValue('9 am–11 pm');await page.getByRole('button',{name:'Undo link change',exact:true}).click();await expect(page.getByRole('status')).toContainText('previous link was restored');await expect(page.getByRole('textbox',{name:'Published shop link',exact:true})).not.toBeVisible();
});
test('copy and native sharing use the exact saved link and retain a manual copy fallback',async({page})=>{
  await start(page);await page.evaluate(()=>Object.defineProperty(navigator,'share',{configurable:true,value:async(data:ShareData)=>{(window as unknown as {sharedLink:ShareData}).sharedLink=data;}}));
  const url=await generate(page);await page.locator('.shop-link-selection fieldset input[type=checkbox]').first().check();await page.getByRole('button',{name:'Clear selection',exact:true}).click();await expect(page.getByRole('textbox',{name:'Published shop link',exact:true})).toHaveValue(url);await page.getByRole('button',{name:'Copy link',exact:true}).click();expect(await page.evaluate(()=>(window as unknown as {copiedLink:string}).copiedLink)).toBe(url);
  await page.getByRole('button',{name:'Share link',exact:true}).click();expect(await page.evaluate(()=>(window as unknown as {sharedLink:ShareData}).sharedLink)).toMatchObject({title:'Rahman Store',url});
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Unavailable');}}}));await page.getByRole('button',{name:'Copy link',exact:true}).click();await expect(page.getByRole('status')).toContainText('Link selected');expect(await page.getByRole('textbox',{name:'Published shop link',exact:true}).evaluate((element:HTMLTextAreaElement)=>element.selectionEnd-element.selectionStart)).toBe(url.length);
  await page.evaluate(()=>Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new Error('Unavailable');}}));await page.getByRole('button',{name:'Share link',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Use Copy link');await expect(page.getByRole('button',{name:'Copy link',exact:true})).toBeVisible();
});
