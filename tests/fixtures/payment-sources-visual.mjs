import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {writeFileSync} from 'node:fs';
import {startCustomerLinkService,installCustomerLinks} from './install-customer-links.mjs';
let service;const checks=[];
export async function capturePaymentSources(page,mode){
 service??=await startCustomerLinkService({ownerTasks:true});await service.reset();const here=new URL(page.url()),at=here.pathname.lastIndexOf('/app/');if(at<0)throw Error('Missing app base');const app=here.pathname.slice(0,at+5);
 const source=await service.paymentSourceCreate('Payment noted at the counter. Keep the full source for review. বাংলা'),sale=await service.paymentReceipt();
 await installCustomerLinks(page);const config=service.config();await page.evaluate(value=>window.miseCustomerLinkTest.initialize(value),config);await page.goto(new URL(app+'inbox/payments/'+(mode==='capture'?'new':source.paymentId)+'?flags=ownerTasks',here.origin).href);
 await expect(page.getByRole('heading',{name:mode==='capture'?'Add payment by hand':'Review payment source',exact:true})).toBeVisible();
 if(mode!=='capture')await expect(page.getByText('Checked source',{exact:false})).toBeVisible();
 if(mode==='receipt'||mode==='recovery'){
  await page.getByRole('button',{name:'Check recorded receipts',exact:true}).click();await page.getByRole('button',{name:'Review receipt '+sale.id.slice(-6),exact:true}).click();await expect(page.getByRole('dialog',{name:'Confirm recorded receipt'})).toBeVisible();
  if(mode==='recovery'){service.loseNext('act_payment_source');await page.getByLabel('I checked this source against this recorded receipt',{exact:true}).check();await page.getByRole('button',{name:'Confirm match',exact:true}).click();await expect(page.getByRole('heading',{name:'Original request needs review',exact:true})).toBeVisible();await expect.poll(async()=>(await service.paymentFacts()).actions).toBe(2);await page.getByRole('link',{name:'Saved payment requests from any outlet',exact:true}).click();await page.getByLabel('Saved group on this device',{exact:true}).selectOption({label:'Saved group 1'});await expect(page.locator('.payment-saved-request')).toHaveCount(1);await page.getByText('Complete saved source',{exact:true}).click();}
 }
 await page.evaluate(()=>document.fonts.ready);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);expect(audit.violations).toEqual([]);expect(overflow).toBe(false);checks.push({mode,width:page.viewportSize().width,overflow,violations:audit.violations.map(x=>({id:x.id,impact:x.impact}))});await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});await page.addStyleTag({content:'.app-skip,.app-bottom-nav{visibility:hidden!important}'});
}
export async function closePaymentSourcesVisual(){if(service){await service.close();service=undefined;}if(checks.length)writeFileSync('.private/m37-payment-native-visual-proof.json',JSON.stringify(checks,null,2)+'\n');}
