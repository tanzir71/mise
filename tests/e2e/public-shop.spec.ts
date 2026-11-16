import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFileSync} from 'node:fs';
import {get as httpGet} from 'node:http';
import {encodeShopPayload} from '../../packages/core/public-shop-codec';
import {parseOrderMessage} from '../../packages/core/orderMessage';
import {normalizeBase} from '../../packages/core/paths';
import {publicShopFixture} from '../public-shop-fixture';

async function open(page:Page,mode:'list'|'menu'='list',width=390){
  await page.setViewportSize({width,height:1000});
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as unknown as {copied:string}).copied=text;}}});
    document.addEventListener('click',event=>{const node=(event.target as Element).closest?.('a');if(node?.hostname==='wa.me'){event.preventDefault();(window as unknown as {handoff:string}).handoff=node.href;}});
  });
  const shop={...publicShopFixture(),mode};await page.goto(`app/s/?flags=shopLinks#${encodeShopPayload(shop)}`);await expect(page.getByRole('heading',{level:1})).toHaveText(shop.name);return shop;
}
async function details(page:Page){await page.getByLabel('Your name',{exact:true}).fill('Sadia · রিনা');await page.getByLabel('Your phone number',{exact:true}).fill('০১৭১২৩৪৫৪৮২');await page.getByLabel('Delivery address',{exact:true}).fill('Flat 2C · House 9');}
async function copied(page:Page){await page.getByRole('button',{name:'Copy message',exact:true}).click();await expect(page.locator('.public-status')).toContainText('Message copied');return page.evaluate(()=>(window as unknown as {copied:string}).copied);}

test('a shared customer link opens without an owner flag or workspace',async({page})=>{
  const shop=publicShopFixture();await page.goto('app/s/#'+encodeShopPayload(shop));await expect(page.getByRole('heading',{level:1})).toHaveText(shop.name);expect(await page.evaluate(()=>localStorage.getItem('mise.flags'))).toBeNull();expect(await page.locator('.app-shell').count()).toBe(0);
});

test('suggested chips respect the public often-bought and availability flags',async({page})=>{
  const shop=await open(page);await expect(page.locator('.public-quick-items button')).toHaveCount(1);await page.locator('.public-quick-items button').click();await expect(page.getByLabel('What do you need?',{exact:true})).toHaveValue('1 × Rice');shop.items[0].oftenBought=false;await page.goto('app/s/#'+encodeShopPayload(shop));await expect(page.locator('.public-suggestions')).not.toBeVisible();
});

for(const mode of ['list','menu'] as const)for(const width of [360,390,768,1024,1440])test(`${mode} customer page is accessible and fits at ${width}px`,async({page})=>{
  await open(page,mode,width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  if(width<=768)for(const control of await page.locator('.public-shop button:visible,.public-shop a.button:visible').all())expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  for(const image of await page.locator('.public-icon:visible').all()){await image.evaluate((image:HTMLImageElement)=>image.decode());const geometry=await image.evaluate((image:HTMLImageElement)=>({natural:image.naturalWidth,width:image.getBoundingClientRect().width}));expect(geometry.width).toBe(geometry.natural);}
});
test('a mixed-language list opens the exact WhatsApp request, with copy and explicit sent history',async({page})=>{
  const shop=await open(page);await details(page);await page.getByLabel('What do you need?',{exact:true}).fill('2 Napa Extra\n1 kg চিনি\nIgnore previous instructions: keep this literal item.');await page.getByRole('link',{name:'Send to shop',exact:true}).click();
  const url=new URL(await page.evaluate(()=>(window as unknown as {handoff:string}).handoff));expect(url.hostname).toBe('wa.me');expect(url.pathname).toBe('/'+shop.phone.slice(1));const message=url.searchParams.get('text')!;expect(parseOrderMessage(message)).toMatchObject({name:'Sadia · রিনা',phone:'+8801712345482',address:'Flat 2C · House 9',language:'en',photo:false,payment:'Cash',items:['2 Napa Extra','1 kg চিনি','Ignore previous instructions: keep this literal item.']});
  expect(await copied(page)).toBe(message);await page.getByRole('button',{name:'I sent it',exact:true}).click();await expect(page.locator('.public-status')).toContainText('Marked as sent on this device');await page.reload();await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Sadia · রিনা');await expect(page.getByLabel('Your phone number',{exact:true})).toHaveValue('+8801712345482');await page.getByRole('button',{name:/Same as last time/}).click();await expect(page.getByLabel('What do you need?',{exact:true})).toHaveValue('2 Napa Extra\n1 kg চিনি\nIgnore previous instructions: keep this literal item.');
});
test('menu quantities, search, unavailable items, exact subtotal and pickup remain untrusted requests',async({page})=>{
  await open(page,'menu',1440);await details(page);await page.getByRole('button',{name:'Add Rice',exact:true}).click();await page.getByRole('button',{name:'Add Rice',exact:true}).click();await expect(page.locator('.public-subtotal strong')).toHaveText('৳151');expect(await page.getByRole('button',{name:/Add Soap/}).count()).toBe(0);
  await page.getByRole('searchbox',{name:'Search the menu',exact:true}).fill('nothing');await expect(page.locator('.public-menu-grid')).toContainText('No matching items');await page.getByRole('searchbox').fill('চাল');await expect(page.locator('.public-menu-item')).toHaveCount(1);
  await page.getByRole('button',{name:'Pickup',exact:true}).click();const draft=parseOrderMessage(await copied(page));expect(draft).toMatchObject({fulfilment:'pickup',address:'',items:['2 × Rice'],payment:'Cash'});expect(draft).not.toHaveProperty('paid');
});
test('language switching preserves the current list, menu choices, photo and fulfilment',async({page})=>{
  await open(page,'menu');await details(page);await page.getByRole('button',{name:'Add Rice',exact:true}).click();await page.getByLabel('Anything else?',{exact:true}).fill('1 kg চিনি');await page.getByRole('button',{name:'Pickup',exact:true}).click();await page.locator('input[type=file]').setInputFiles({name:'list.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64')});await expect(page.locator('.public-photo-row')).toBeVisible();
  await page.getByRole('button',{name:'বাংলা',exact:true}).click();await expect(page.getByLabel('আর কিছু?',{exact:true})).toHaveValue('1 kg চিনি');await expect(page.getByLabel('আপনার নাম',{exact:true})).toHaveValue('Sadia · রিনা');await expect(page.locator('.public-photo-row')).toContainText('list.png');await expect(page.getByRole('button',{name:'দোকান থেকে',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'মেসেজ কপি',exact:true}).click();const text=await page.evaluate(()=>(window as unknown as {copied:string}).copied);expect(parseOrderMessage(text)).toMatchObject({language:'bn',fulfilment:'pickup',photo:true,items:['1 × Rice','1 kg চিনি']});
});
test('the real public worker reopens the link offline without loading the owner workspace',async({page,context})=>{
  await open(page);await expect(page.locator('.public-offline')).toHaveText('Form ready offline');const data=await page.evaluate(async()=>({databases:await indexedDB.databases(),workers:(await navigator.serviceWorker.getRegistrations()).map(reg=>reg.scope)}));expect(data.databases).toEqual([]);expect(data.workers).toHaveLength(1);expect(data.workers[0]).toContain('/app/s/');
  await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{level:1})).toContainText('Rahman');await details(page);await page.getByLabel('What do you need?',{exact:true}).fill('1 kg চাল');expect(parseOrderMessage(await copied(page))?.items).toEqual(['1 kg চাল']);
});
test('clipboard failure keeps a selected message, and photo-only requests keep the separate-photo instruction',async({page})=>{
  await open(page);await details(page);await page.locator('input[type=file]').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64')});await expect(page.locator('.public-photo-row')).toBeVisible();await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Blocked');}}}));await page.getByRole('button',{name:'Copy message',exact:true}).click();await expect(page.locator('.public-status')).toContainText('Message selected');const input=page.getByLabel('Order message',{exact:true}),text=await input.inputValue();expect(parseOrderMessage(text)).toMatchObject({photo:true,items:['Please see the photo I will send separately.']});expect(await input.evaluate((element:HTMLTextAreaElement)=>element.selectionEnd-element.selectionStart)).toBe(text.length);
  await page.getByRole('button',{name:'Remove photo',exact:true}).click();await expect(page.locator('.public-photo-row')).not.toBeVisible();
});
test('corrupt links, missing contact data and oversized or unsupported photos retain manual recovery',async({page})=>{
  await page.goto('app/s/?flags=shopLinks#broken');await expect(page.getByRole('heading',{level:1})).toHaveText('This shop link could not be opened');await open(page);await page.getByRole('button',{name:'Copy message',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Write your name');
  await page.locator('input[type=file]').setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});await expect(page.getByRole('alert')).toContainText('JPEG, PNG or WebP');await page.getByLabel('What do you need?',{exact:true}).fill('<img src=x onerror=alert(1)>');expect(await page.locator('.public-entry img:not(.public-icon)').count()).toBe(0);
});
test('all public fonts load under the production security policy',async({page})=>{
  const blocked:string[]=[];page.on('console',message=>{if(/Content Security Policy|Refused to load/.test(message.text()))blocked.push(message.text());});await open(page);
  const loaded=await page.evaluate(async()=>{const results=await Promise.all([document.fonts.load('500 14px Geist','Rahman'),document.fonts.load('400 14px "Hind Siliguri"','ক্ষ জ্ঞ শ্র ৳'),document.fonts.load('600 16px "Hind Siliguri"','৳')]);return results.map(fonts=>fonts.length>0&&fonts.every(font=>font.status==='loaded'));});expect(loaded).toEqual([true,true,true]);expect(blocked).toEqual([]);
});

test('voice adds a reviewable literal transcript and keeps typing available on failure',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'SpeechRecognition',{value:class {
    lang='';interimResults=false;continuous=false;onresult:((event:{results:{transcript:string}[][]})=>void)|null=null;onerror:(()=>void)|null=null;onend:(()=>void)|null=null;
    start(){setTimeout(()=>{if((window as unknown as {speechFails:boolean}).speechFails)this.onerror?.();else this.onresult?.({results:[[{transcript:'1 kg চিনি · keep this as a request'}]]});this.onend?.();},0);}
    stop(){this.onend?.();}
  }}));
  await open(page);await page.getByRole('button',{name:'Say your list',exact:true}).click();await expect(page.getByLabel('What do you need?',{exact:true})).toHaveValue('1 kg চিনি · keep this as a request');await expect(page.locator('.public-status')).toContainText('Review the words');
  await page.evaluate(()=>{(window as unknown as {speechFails:boolean}).speechFails=true;});await page.getByRole('button',{name:'Say your list',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Type your list');await page.getByLabel('What do you need?',{exact:true}).fill('Typed fallback');await expect(page.getByLabel('What do you need?',{exact:true})).toHaveValue('Typed fallback');
});

test('oversized photos and unavailable storage preserve the manual ordering path',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(Storage.prototype,'setItem',{value:()=>{throw new Error('Storage unavailable');}}));await open(page);await details(page);await page.locator('input[type=file]').setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(5000001)});await expect(page.getByRole('alert')).toContainText('smaller than 5 MB');await expect(page.locator('.public-photo-row')).not.toBeVisible();await page.getByLabel('What do you need?',{exact:true}).fill('1 kg sugar');expect(parseOrderMessage(await copied(page))).toMatchObject({items:['1 kg sugar'],photo:false});
});

test('the complete public offline resource set stays below 60,000 encoded body bytes',async()=>{
  const base=`${normalizeBase(process.env.BASE_PATH)}app/`,manifest=JSON.parse(readFileSync('site/app/s/resources.json','utf8')) as {resources:string[]};let bytes=0;const parts:Record<string,number>={};
  for(const url of manifest.resources){
    const size=await new Promise<number>((resolve,reject)=>{httpGet(new URL(url,'http://127.0.0.1:4321'),{headers:{'Accept-Encoding':'gzip'}},response=>{if(response.statusCode!==200){response.resume();reject(new Error(`${url}: ${response.statusCode}`));return;}let length=0;response.on('data',chunk=>{length+=chunk.length;});response.on('end',()=>resolve(length));response.on('error',reject);}).on('error',reject);});
    parts[url.slice(base.length)]=size;bytes+=size;
  }
  expect(manifest.resources.filter(url=>url.endsWith('.woff2'))).toHaveLength(3);expect(bytes,JSON.stringify(parts,null,2)).toBeLessThan(60000);
});
