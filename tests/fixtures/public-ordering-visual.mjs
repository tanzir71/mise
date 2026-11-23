import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {writeFileSync} from 'node:fs';
import {startCustomerLinkService,installCustomerLinks} from './install-customer-links.mjs';
let service;const checks=[];
export async function capturePublicOrdering(page,stage){
 service??=startCustomerLinkService({ordering:true});const server=await service;await server.reset();
 const base=new URL(page.url());base.pathname=base.pathname.replace(/\/app\/.*$/,'/app/');base.search='';base.hash='';
 if(stage==='owner'){
  await page.goto(new URL('?flags=publicOrders,cloudSetup',base).href);await installCustomerLinks(page);const config=server.config();await page.evaluate(value=>window.miseCustomerLinkTest.initialize(value),config);
  await page.goto(new URL('settings/shop-link?flags=publicOrders,cloudSetup',base).href);const panel=page.getByLabel('Online ordering',{exact:true});await expect(panel.getByRole('button',{name:'Publish ordering link',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'Publish ordering link',exact:true}).click();await expect(panel.getByLabel('Confirmed ordering link')).toBeVisible();
 }else{
  const {url}=await server.publishShop(stage==='table'?'Table 4':null);await page.goto(url);await expect(page.getByRole('button',{name:'Place order',exact:true})).toBeEnabled();
  if(stage!=='entry'){
   if(stage!=='table')await page.getByRole('button',{name:'Pickup',exact:true}).click();
   await page.getByLabel('Your name',{exact:true}).fill('Sadia');await page.getByLabel('Your phone number',{exact:true}).fill('+14155550150');await page.getByLabel('What do you need?',{exact:true}).fill('২ কেজি চাল\n1 kg Rice');
   if(stage==='original')server.loseNext('orders');await page.getByRole('button',{name:'Place order',exact:true}).click();
   if(stage==='table'){await expect(page).toHaveURL(/\/app\/t\//);await expect(page.getByText('Table 4',{exact:true})).toBeVisible();}
   else await expect(page.getByLabel('Online order',{exact:true}).getByRole('alert')).toContainText('unconfirmed');
  }
  expect(await page.evaluate(async()=> (await indexedDB.databases()).length)).toBe(0);
 }
 await page.evaluate(()=>document.fonts.ready);
 const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 checks.push({stage,width:page.viewportSize().width,overflow,violations:result.violations.map(v=>({id:v.id,impact:v.impact}))});expect(result.violations).toEqual([]);expect(overflow).toBe(false);
}
export async function closePublicOrderingVisual(){if(service){try{await(await service).close();}finally{writeFileSync('.private/public-ordering-visual-axe.json',JSON.stringify(checks,null,2)+'\n');service=undefined;}}}
