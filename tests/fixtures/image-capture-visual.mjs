import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {resolve} from 'node:path';
/** Real local UI, real source Blob and real on-device reader; no hosted services. */
export async function captureImageReview(page,mode='invoice'){
 const current=new URL(page.url()),app=current.pathname.replace(/\/app\/.*$/,'/app/');
 await page.locator('input[name=business][value=corner_shop]').check();await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.locator('input[name=market][value=BD]').check();await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByLabel('Shop name',{exact:true}).fill('Image review shop');await page.getByLabel('Phone number',{exact:true}).fill('01712345482');await page.getByRole('button',{name:'Open Mise',exact:true}).click();
 await expect(page.locator('.today-page')).toHaveAttribute('aria-busy','false');
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
 await page.goto(new URL(app+'inbox/capture/'+(mode==='invoice'?'invoice':'prescription'),current.origin).href);
 await page.getByLabel('Choose image',{exact:true}).setInputFiles(resolve('tests/fixtures/ocr',mode==='invoice'?'invoice-01.png':'request-prescription.png'));
 await page.getByRole('button',{name:'Save image and read',exact:true}).click();
 if(mode==='invoice')await expect(page.getByRole('button',{name:'Add to stock and purchases',exact:true})).toBeVisible();
 else{
  await page.getByRole('button',{name:/enter by hand/i}).click();await page.getByLabel('Editable image text',{exact:true}).fill('1 pc Napa 500\n1 pc Seclo 20\n1 pc Fexo 120');await page.getByRole('button',{name:'Review order lines',exact:true}).click();
  await page.getByLabel('Selected unit price',{exact:true}).fill('25');await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByLabel('Selected unit price',{exact:true}).fill('18');await page.getByRole('button',{name:'Next',exact:true}).click();
  await page.locator('.order-price-list article').nth(2).getByRole('button',{name:'Edit',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Edit order item',exact:true});await dialog.getByRole('switch',{name:'Out of stock',exact:true}).check();await dialog.getByRole('button',{name:'Save item',exact:true}).click();
  await page.getByRole('button',{name:'Price Napa 500',exact:true}).click();
  if(mode==='confirmation')await page.getByRole('button',{name:'Review order details',exact:true}).click();
 }
 await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 const selectors=mode==='invoice'?['.capture-heading img','.capture-invoice-card img','.capture-stock-summary img','.capture-actions img']:mode==='confirmation'?[]:['.capture-pricing-nav img','.order-warning img','.order-mini-keys img','.order-price-footer img'];
 const expected=mode==='invoice'?[[18,18],[20,20],[6,6],[6,6],[14,14],[16,16],[14,14],[14,14]]:mode==='confirmation'?[]:[[18,18],[20,20],[6,6],[18,18],[14,14]];
 const geometry=await page.locator(selectors.join(',')||'img[data-no-assets]').evaluateAll(images=>images.map(img=>{const box=img.getBoundingClientRect();return {src:img.getAttribute('src'),width:box.width,height:box.height};}));expect(geometry.map(({width,height})=>[width,height])).toEqual(expected);
 await page.locator('.capture-page').evaluate((element,geometry)=>element.dataset.assetGeometry=JSON.stringify(geometry),geometry);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
}
