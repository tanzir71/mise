import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {writeFileSync} from 'node:fs';
import {startCustomerLinkService,installCustomerLinks} from './install-customer-links.mjs';
let service;const checks=[];
async function owner(page,server,base,path){await page.goto(new URL('?flags=publicOrders,customerLinks,cloudSetup',base).href);await installCustomerLinks(page);const config=server.config();await page.evaluate(value=>window.miseCustomerLinkTest.initialize(value),config);await page.goto(new URL(path+'?flags=publicOrders,customerLinks,cloudSetup',base).href);}
async function receivingAccount(page){const panel=page.getByLabel('Payments',{exact:true});await panel.getByRole('button',{name:'Add wallet',exact:true}).click();await panel.getByLabel('Public receiving phone').fill('+14155550199');await panel.getByLabel('Public payment link').fill('bkash://');await panel.getByRole('button',{name:'Save public payment accounts',exact:true}).click();await expect(panel.getByRole('status')).toContainText('recorded');}
export async function captureOrderCheckout(page,stage){
 service??=startCustomerLinkService({ordering:true,checkout:true});const server=await service;await server.reset();const base=new URL(page.url());base.pathname=base.pathname.replace(/\/app\/.*$/,'/app/');base.search='';base.hash='';
 if(stage==='settings'){await owner(page,server,base,'settings/shop-link');await receivingAccount(page);}
 else{
  const {url}=await server.publishShop();await page.goto(url);await page.getByRole('button',{name:'Pickup',exact:true}).click();await page.getByLabel('Your name',{exact:true}).fill('Sadia');await page.getByLabel('Your phone number',{exact:true}).fill('+14155550150');await page.getByLabel('What do you need?',{exact:true}).fill('2 kg rice and fresh milk');await page.getByRole('button',{name:'Place order',exact:true}).click();await expect(page).toHaveURL(/\/app\/t\//);
  const id=await page.evaluate(()=>{const row=Object.entries(localStorage).find(([key])=>key.startsWith('mise.public-orders.v1.'));if(!row)throw Error('Missing actual order original');return JSON.parse(row[1]).attempts.at(-1).submission.intent.orderId;});await server.priceOrder(id);
  const ownerContext=await page.context().browser().newContext({viewport:page.viewportSize()??{width:390,height:1000}}),operator=await ownerContext.newPage();try{
   await owner(operator,server,base,'settings/shop-link');await receivingAccount(operator);await operator.goto(new URL('orders/'+id+'?flags=publicOrders,customerLinks,cloudSetup',base).href);const permission=operator.getByLabel('Customer khata permission',{exact:true});await permission.getByLabel('Maximum for this order (BDT)',{exact:true}).fill('250');await permission.getByRole('checkbox').check();await permission.getByRole('button',{name:'Allow khata for this order',exact:true}).click();await expect(permission.getByRole('status')).toContainText('recorded');
   if(stage==='permission'){await owner(page,server,base,'orders/'+id);await expect(page.getByLabel('Customer khata permission',{exact:true})).toContainText('Khata is allowed for this order revision');}
   else{
    await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByRole('heading',{name:'The shop priced your order',exact:true})).toBeVisible();await page.getByRole('radio',{name:'Yes, accept',exact:true}).check();await expect(page.getByRole('radio',{name:'bKash',exact:true})).toBeVisible();await expect(page.getByRole('radio',{name:'Khata',exact:true})).toBeEnabled();
    if(stage==='original')server.loseNext('order-confirmations');
    if(stage==='unavailable')await page.route(server.config().apiUrl+'/functions/v1/public/order-confirmations',route=>route.abort());
    if(['original','unavailable','confirmed','finished'].includes(stage)){await page.getByRole('button',{name:'Confirm order',exact:true}).click();if(['original','unavailable'].includes(stage))await expect(page.getByRole('alert')).toBeVisible();else await expect(page.getByLabel('Saved original choices',{exact:true})).toContainText('Your order was confirmed.');}
    if(stage==='unavailable'){await page.route(server.config().apiUrl+'/functions/v1/public-read',route=>route.abort());await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByRole('heading',{name:'This link could not be checked. Connect and try again.',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Copy choices',exact:true})).toBeEnabled();}
    if(stage==='finished'){for(const status of ['packing','ready','done'])await server.status(status);await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.locator('.customer-order-status h1')).toHaveText('Done');}
    expect(await page.evaluate(()=>indexedDB.databases())).toEqual([]);
   }
  }finally{await ownerContext.close();}
 }
 await page.evaluate(()=>document.fonts.ready);const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);checks.push({stage,width:page.viewportSize().width,overflow,violations:result.violations.map(v=>({id:v.id,impact:v.impact}))});expect(result.violations).toEqual([]);expect(overflow).toBe(false);
}
export async function closeOrderCheckoutVisual(){if(service){try{await(await service).close();}finally{writeFileSync('.private/order-checkout-visual-axe.json',JSON.stringify(checks,null,2)+'\n');service=undefined;}}}
