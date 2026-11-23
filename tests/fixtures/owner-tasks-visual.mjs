import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFileSync,writeFileSync} from 'node:fs';
import {startCustomerLinkService,installCustomerLinks} from './install-customer-links.mjs';
let service;const checks=[];
export async function captureOwnerTasks(page,mode){
 service??=await startCustomerLinkService({ownerTasks:true});await service.reset();const here=new URL(page.url()),at=here.pathname.lastIndexOf('/app/');if(at<0)throw Error('Missing native app base');const app=here.pathname.slice(0,at+5);
 await service.ownerTaskCreate({title:'Can Jamal leave at 9 tonight?',body:'A staff request, recorded for a person to decide.'});
 await service.ownerTaskCreate({title:'A guest asked for extra raita',body:'Record your decision here. The order and its price stay unchanged.'});
 await service.ownerTaskCreate({kind:'failure',mode:'message',title:'A reply needs a person',body:'This draft was added by hand. Copy it and send it yourself.',prepared:'I will check your order and reply shortly.',recipient:'+8801712345482'});
 await service.ownerTaskCreate({kind:'failure',mode:'check',title:'Review the shop connection',body:'A manual check is waiting for a person.'});
 await service.ownerTaskCreate({kind:'chat',mode:'message',title:'Where is my order?',body:'Keep the customer’s original question while you check the order.',prepared:'I am checking the recorded order details.'});
 await service.liveQuestion('আমাকে শুক্রবার পর্যন্ত সময় দিন। Please allow a little more time.');
 await page.goto(new URL(app+'?flags=ownerTasks',here.origin).href);await installCustomerLinks(page);await page.evaluate(v=>window.miseCustomerLinkTest.initialize(v),service.config());await page.goto(new URL(app+'inbox'+(mode==='questions'?'/questions':'')+'?flags=ownerTasks',here.origin).href);await expect(page.locator('.owner-task-caption').first()).toContainText('Checked');
 if(mode==='reply'){await page.locator('.owner-task-card').filter({hasText:'Khata: asks for more time'}).getByRole('button',{name:'Reply myself',exact:true}).click();await page.getByLabel('Your reply',{exact:true}).fill('শুক্রবার কথা বলি। I will review the recorded balance with you.');}
 if(mode==='recovery'){const before=await service.ownerTaskFacts();service.loseNext('act_owner_task');await page.locator('.owner-task-card').filter({hasText:'Can Jamal leave'}).getByRole('button',{name:'Allow',exact:true}).click();await expect(page.getByText('Original request needs review',{exact:true})).toBeVisible();await expect.poll(async()=>(await service.ownerTaskFacts()).actions).toBe(before.actions+1);}

 if(mode==='personal-recovery'||mode==='personal-archive'){
  const card=page.locator('.owner-task-card').filter({hasText:'Can Jamal leave'});
  if(mode==='personal-recovery')service.loseNext('act_owner_task');
  await card.getByRole('button',{name:'Allow',exact:true}).click();await expect(page.getByText(mode==='personal-recovery'?'Original request needs review':'Last saved request',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Saved task requests',exact:true}).click();await page.getByLabel('Saved group on this device',{exact:true}).selectOption({label:'Saved group 1'});await expect(page.locator('.owner-task-history .owner-task-card')).toHaveCount(1);
  if(mode==='personal-recovery')await page.getByText('Complete saved source',{exact:true}).click();
  if(mode==='personal-archive'){const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save completed archive',exact:true}).click();const file=await download;await page.getByLabel('Select the saved archive file',{exact:true}).setInputFiles({name:file.suggestedFilename(),mimeType:'application/json',buffer:readFileSync(await file.path())});await expect(page.getByRole('button',{name:'Remove verified completed copies',exact:true})).toBeEnabled();}
 }
 await page.evaluate(()=>document.fonts.ready);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),assets=await page.locator('.owner-tasks img').evaluateAll(images=>images.filter(img=>img.getBoundingClientRect().width>0).map(img=>({file:img.getAttribute('src').split('/').at(-1),width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight})));
 for(const asset of assets){expect(asset.naturalWidth).toBeGreaterThan(0);expect(asset.width).toBe(asset.naturalWidth);expect(asset.height).toBe(asset.naturalHeight);}expect(audit.violations).toEqual([]);expect(overflow).toBe(false);checks.push({mode,width:page.viewportSize().width,assets,overflow,violations:audit.violations.map(v=>({id:v.id,impact:v.impact}))});await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});await page.addStyleTag({content:'.app-skip,.app-bottom-nav{visibility:hidden!important}'});
}
export async function closeOwnerTasksVisual(){if(service){await service.close();service=undefined;}if(checks.length)writeFileSync('.private/m37-ui-visual-proof.json',JSON.stringify(checks,null,2)+'\n');}
