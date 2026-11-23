import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {writeFileSync} from 'node:fs';
import {startCustomerLinkService,installCustomerLinks} from './install-customer-links.mjs';
let service;const checks=[];
export async function captureOrderEstimates(page,stage){
 service??=startCustomerLinkService({estimates:true});const server=await service;await server.reset();await server.seedHistoricalEstimate();
 const base=new URL(page.url());base.pathname=base.pathname.replace(/\/app\/.*$/,'/app/');base.search='';base.hash='';
 const ownerContext=stage==='owner'?null:await page.context().browser().newContext({viewport:page.viewportSize()??{width:390,height:1000}}),owner=ownerContext?await ownerContext.newPage():page;
 try{
 await owner.goto(new URL('?flags=publicOrders,customerLinks,cloudSetup',base).href);await installCustomerLinks(owner);const config=server.config();await owner.evaluate(value=>window.miseCustomerLinkTest.initialize(value),config);
 await owner.goto(new URL('orders/'+config.records.order.id+'?flags=publicOrders,customerLinks,cloudSetup',base).href);const panel=owner.getByLabel('Shop estimate',{exact:true});await expect(panel.getByRole('button',{name:'Save estimate',exact:true})).toBeEnabled();await panel.getByLabel('From (minutes)',{exact:true}).fill('10');await panel.getByLabel('To (minutes)',{exact:true}).fill('20');await panel.getByLabel('Note shown to customer (optional)').fill('The shop updated this time.');await panel.getByRole('button',{name:'Save estimate',exact:true}).click();await expect(panel.getByRole('status')).toContainText('recorded');
 if(stage==='withdrawn'){await panel.getByRole('button',{name:'Withdraw estimate',exact:true}).click();await expect(panel).toContainText('The estimate was withdrawn.');}
 if(stage!=='owner'){
  if(stage==='finished')await server.status('delivered');const link=await server.issue(),url=server.viewerUrl(link.token,base.pathname);
  await page.goto(url);await expect(page.getByRole('heading',{name:stage==='finished'?'Delivered':'Out with rider',exact:true})).toBeVisible();if(stage==='finished')await expect(page.getByLabel('Delay notice')).toHaveCount(0);else await expect(page.getByLabel('Delay notice')).toContainText('6 minutes late');
  expect(await page.evaluate(()=>indexedDB.databases())).toEqual([]);
 }
 }finally{if(ownerContext)await ownerContext.close();}
 await page.evaluate(()=>document.fonts.ready);const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);checks.push({stage,width:page.viewportSize().width,overflow,violations:result.violations.map(v=>({id:v.id,impact:v.impact}))});expect(result.violations).toEqual([]);expect(overflow).toBe(false);
}
export async function closeOrderEstimatesVisual(){if(service){try{await(await service).close();}finally{writeFileSync('.private/order-estimates-visual-axe.json',JSON.stringify(checks,null,2)+'\n');service=undefined;}}}
