import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {writeFileSync} from 'node:fs';
import {startCustomerLinkService,installCustomerLinks} from './install-customer-links.mjs';
let service;const checks=[];
export async function captureStaff(page,stage){
 service??=startCustomerLinkService({staffTeam:true});const server=await service;await server.reset();const base=new URL(page.url());base.pathname=base.pathname.replace(/\/app\/.*$/,'/app/');base.search='';base.hash='';
 const scene=await server.staffScene(base.pathname);
 if(stage==='shift'){
  await page.goto(scene.url);await expect(page.getByRole('heading',{name:'নাদিয়া আক্তার · Desk',exact:true})).toBeVisible();expect(await page.evaluate(()=>indexedDB.databases())).toEqual([]);
 }else{
  await page.goto(new URL('?flags=staffTeam,cloudSetup',base).href);await installCustomerLinks(page);await page.evaluate(config=>window.miseCustomerLinkTest.initialize(config),server.config());
  await page.goto(new URL((stage==='board'?'team':'team/members')+'?flags=staffTeam,cloudSetup',base).href);await expect(page.locator('.staff-read-state p')).toHaveText(/^Checked \d{2}:\d{2}$/);
  await expect(page.getByRole('heading',{name:stage==='board'?'Nadia Akter · Desk':'Nadia Akter',exact:true})).toBeVisible();
  if(stage==='editor')await page.getByRole('button',{name:'Edit Nadia Akter',exact:true}).click();
  if(stage==='manual')await page.getByRole('button',{name:'Choose a member to log',exact:true}).click();
 }
 await page.evaluate(()=>document.fonts.ready);const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 checks.push({stage,width:page.viewportSize().width,overflow,violations:result.violations.map(row=>({id:row.id,impact:row.impact}))});expect(result.violations).toEqual([]);expect(overflow).toBe(false);
}
export async function closeStaffVisual(){if(service){try{await(await service).close();}finally{writeFileSync('.private/staff-visual-axe.json',JSON.stringify(checks,null,2)+'\n');service=undefined;}}}
