import { expect,test,type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import jsQR from 'jsqr';

async function start(page:Page,width=390,market='BD',enabled=true,name='Rahman Store · রহমান') {
  await page.setViewportSize({width,height:1000});
  await page.addInitScript(enabled=>{if(enabled)localStorage.setItem('mise.flags',JSON.stringify({qrPosters:true}));Object.defineProperty(window,'print',{configurable:true,value:()=>{(window as unknown as {printed:boolean}).printed=true;}});},enabled);
  await page.goto('app/');await page.locator('input[name=business][value=corner_shop]').check();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.locator(`input[name=market][value=${market}]`).check();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('Shop name',{exact:true}).fill(name);await page.getByLabel('Phone number',{exact:true}).fill('+8801712345482');await page.getByRole('button',{name:'Open Mise',exact:true}).click();
  await page.getByRole('link',{name:'More',exact:true}).click();await page.getByRole('link',{name:/Shop link Public details/}).click();
  await expect(page.getByRole('button',{name:'QR posters',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Generate shop link',exact:true}).click();await expect(page.getByRole('status')).toContainText('Shop link generated');return page.getByRole('textbox',{name:'Published shop link',exact:true}).inputValue();
}
async function poster(page:Page){await page.getByRole('button',{name:'QR posters',exact:true}).click();const dialog=page.getByRole('dialog',{name:'QR posters and counter cards',exact:true});await expect(dialog.locator('.shop-poster-preview img')).toBeVisible();await dialog.locator('.shop-poster-preview img').evaluate((image:HTMLImageElement)=>image.decode());expect(await dialog.locator('.shop-poster-preview img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBe(1680);return dialog;}
async function png(page:Page){const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download PNG',exact:true}).click()]);expect(download.suggestedFilename()).toMatch(/^mise-shop-.*-(a5|card)\.png$/);return readFile((await download.path())!);}
async function decode(png:Buffer) {const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});return jsQR(new Uint8ClampedArray(data),info.width,info.height)?.data;}
async function records(page:Page){return page.evaluate(async()=>{const name=(await indexedDB.databases()).find(row=>row.name?.startsWith('mise-local:'))!.name!,db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const stores=['events','orders','sales','creditEntries'],tx=db.transaction(stores,'readonly'),counts=await Promise.all(stores.map(store=>new Promise<number>((resolve,reject)=>{const request=tx.objectStore(store).count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);})));db.close();return counts;});}

test('unfinished poster controls stay off by default',async({page})=>{await start(page,390,'BD',false);await expect(page.getByRole('button',{name:'QR posters',exact:true})).toHaveCount(0);});

for(const width of [360,390,768,1024,1440])test(`QR poster fits, meets axe and downloads the exact saved link at ${width}px`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(/Content Security Policy|Refused to load/.test(message.text()))errors.push(message.text());});
  const url=await start(page,width),before=await records(page),dialog=await poster(page);
  await expect(dialog.locator('img')).toHaveAttribute('alt',/স্ক্যান করে অর্ডার করুন/);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  for(const control of await dialog.locator('button:visible,a.button:visible,select').all())expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const bytes=await png(page);expect(await sharp(bytes).metadata()).toMatchObject({width:1680,height:2380});expect(await decode(bytes)).toBe(url);
  await dialog.getByRole('button',{name:'Close poster',exact:true}).click();expect(await records(page)).toEqual(before);expect(errors).toEqual([]);await expect(page.getByRole('button',{name:'QR posters',exact:true})).toBeFocused();
});

test('A5 and counter card use one page at the chosen physical size, including offline PDF printing',async({page,context},testInfo)=>{
  const url=await start(page);await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});await context.setOffline(true);await page.reload();const dialog=await poster(page);
  await dialog.getByRole('button',{name:'Print / Save PDF',exact:true}).click();expect(await page.evaluate(()=>(window as unknown as {printed:boolean}).printed)).toBe(true);
  await mkdir('qa/pdfs',{recursive:true});for(const size of ['a5','card']){
    await dialog.getByLabel('Print size',{exact:true}).selectOption(size);await expect(page.locator('.shop-poster-print')).toHaveClass(new RegExp('shop-poster-'+size));
    await page.locator('.shop-poster-print img').evaluate((image:HTMLImageElement)=>image.decode());const bytes=await page.pdf({preferCSSPageSize:true,printBackground:true,tagged:true});expect(bytes.subarray(0,5).toString()).toBe('%PDF-');const text=bytes.toString('latin1'),box=text.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/)!;expect(text.match(/\/Type\s*\/Page\b/g)).toHaveLength(1);expect(Number(box[1])).toBeCloseTo((size==='a5'?148:105)*72/25.4,0);expect(Number(box[2])).toBeCloseTo((size==='a5'?210:148)*72/25.4,0);await writeFile(`qa/pdfs/m22-${size}-bn.pdf`,bytes);await testInfo.attach(`M22 ${size} Bengali PDF`,{body:bytes,contentType:'application/pdf'});
  }
  expect(await decode(await png(page))).toBe(url);await dialog.getByRole('button',{name:'Close poster',exact:true}).click();expect(await page.evaluate(()=>document.body.classList.contains('mise-poster-printing'))).toBe(false);
});

for(const [market,cta] of [['IN','ऑर्डर के लिए स्कैन करें'],['ID','Pindai untuk pesan'],['KE','Changanua ili kuagiza'],['OTHER','']] as const)test(`${market} uses its market scan copy and a loaded local typeface`,async({page})=>{
  await start(page,390,market,true,'Mise shop');const dialog=await poster(page),alt=await dialog.locator('img').getAttribute('alt');if(cta)expect(alt).toContain(cta);else expect(alt).not.toContain('Changanua');
  if(market==='IN')expect(await page.evaluate(()=>document.fonts.check('600 20px Hind','ऑर्डर'))).toBe(true);await mkdir('qa/screens',{recursive:true});await writeFile(`qa/screens/m22-market-${market}.png`,await png(page));
});

test('opening the PNG, clipboard denial and blocked printing have usable fallbacks',async({page})=>{
  const url=await start(page),dialog=await poster(page);const [opened]=await Promise.all([page.waitForEvent('popup'),dialog.getByRole('link',{name:'Open PNG',exact:true}).click()]);await expect(opened.locator('img')).toBeVisible();expect(await opened.locator('img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBe(1680);await opened.close();
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Denied');}}});Object.defineProperty(window,'print',{configurable:true,value:()=>{throw new Error('Blocked');}});});await dialog.getByRole('button',{name:'Copy shop link',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('Link selected');expect(await dialog.getByLabel('Saved shop link',{exact:true}).evaluate((field:HTMLTextAreaElement)=>field.value.slice(field.selectionStart,field.selectionEnd))).toBe(url);
  await dialog.getByRole('button',{name:'Print / Save PDF',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Download the PNG');await expect(dialog.getByRole('link',{name:'Open PNG',exact:true})).toBeVisible();
});

test('a long literal shop name wraps without changing the QR and public edits require regeneration',async({page})=>{
  const url=await start(page,390,'BD',true,'W'.repeat(80));await page.getByLabel('Opening hours',{exact:true}).fill('Changed after the saved edition');let dialog=await poster(page);expect(await decode(await png(page))).toBe(url);await dialog.getByRole('button',{name:'Close poster',exact:true}).click();await page.getByRole('button',{name:'Regenerate after menu changes',exact:true}).click();await expect(page.getByRole('status')).toContainText('Shop link generated');const changed=await page.getByRole('textbox',{name:'Published shop link',exact:true}).inputValue();expect(changed).not.toBe(url);dialog=await poster(page);expect(await decode(await png(page))).toBe(changed);await expect(dialog.locator('img')).toHaveAttribute('alt',new RegExp('W'.repeat(80)));
});
