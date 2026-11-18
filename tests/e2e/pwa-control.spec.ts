import {test,expect} from '@playwright/test';
import {flags,setup,controlled} from './helpers/pwa';

test('a navigation begun during first activation becomes controlled without reloading its cash draft',async({page,context})=>{
 let release!:()=>void;const precache=new Promise<void>(r=>{release=r;}),workerCreated=context.waitForEvent('serviceworker');
 await context.route('**/app/index.html',async route=>{const response=await route.fetch();await precache;await route.fulfill({response});});
 await context.addInitScript(()=>{try{Object.assign(window,{miseInitialWorkerControl:Boolean(navigator.serviceWorker.controller)});}catch{/* The initial about:blank has no app origin. */}});
 await flags(context);await setup(page);const worker=await workerCreated;
 await context.route('**/app/counter',async route=>{const response=await route.fetch();release();await expect.poll(()=>worker.evaluate(()=>(globalThis as unknown as {registration:{active:{state:string}|null}}).registration.active?.state)).toBe('activated');await route.fulfill({response});});
 try{await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as unknown as {miseInitialWorkerControl:boolean}).miseInitialWorkerControl)).toBe(false);await page.getByLabel('Calculation',{exact:true}).fill('37');await controlled(page);await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('37');await context.setOffline(true);await page.locator('.counter-cash').click();await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');await page.reload();await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();await page.goto('app/');await expect(page.locator('[data-metric=sales] strong')).toHaveText('৳37');}
 finally{release();await context.setOffline(false);}
});
