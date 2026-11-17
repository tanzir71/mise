import {expect,type BrowserContext,type Page} from '@playwright/test';
export async function flags(context:BrowserContext){await context.addInitScript(()=>localStorage.setItem('mise.flags',JSON.stringify({pwa:true})));}
export async function setup(page:Page){
  await page.goto('app/');await page.getByRole('radio',{name:/^Corner shop/}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('radio',{name:/^Bangladesh/}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('Shop name',{exact:true}).fill('Install test');await page.getByLabel('Phone number',{exact:true}).fill('01712345482');await page.getByRole('button',{name:'Open Mise',exact:true}).click();await expect(page.locator('.today-page')).toHaveAttribute('aria-busy','false');
}
export async function device(page:Page){await page.goto('app/settings/device');await expect(page.getByRole('heading',{name:'Settings › This device',exact:true})).toBeVisible();}
export async function controlled(page:Page){
  await expect.poll(()=>page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();return {controlled:Boolean(navigator.serviceWorker.controller),active:registration?.active?.state,installing:registration?.installing?.state,waiting:registration?.waiting?.state};}),{timeout:20000,message:'The installed worker must be activated and control this page before offline checks'}).toMatchObject({controlled:true,active:'activated'});
}
export async function cash(page:Page,amount:string){await page.goto('app/counter');await page.getByLabel('Calculation',{exact:true}).fill(amount);await page.locator('.counter-cash').click();await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');}
