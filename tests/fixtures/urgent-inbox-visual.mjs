import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {startDeskUiService,mockDeskBrowser,installDeskUi} from './install-desk-ui.mjs';
let service;
export async function captureUrgentInbox(page,mode='settings'){
 service??=await startDeskUiService();const prepared=await service.prepare();await mockDeskBrowser(page.context());await installDeskUi(page);await page.evaluate(input=>window.miseDeskUiTest.initialize(input),prepared);await page.evaluate(()=>localStorage.setItem('mise.flags',JSON.stringify({ownerTasks:true,kitchenAlarms:false,cloudSetup:true,pwa:true})));
 const current=new URL(page.url()),app=current.pathname.replace(/\/app\/.*$/,'/app/');
 await page.goto(new URL(app+'settings/notifications',current.origin).href);await expect(page.getByRole('button',{name:'Enable here',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Enable here',exact:true}).click();await expect(page.getByText('Notifications enabled on this browser.',{exact:true})).toBeVisible();
 if(mode!=='settings'){
  await page.getByRole('button',{name:'Enable urgent alerts',exact:true}).click();await expect(page.getByText('Urgent Inbox alerts enabled on this browser.',{exact:true})).toBeVisible();
 }
 if(mode==='cleanup'){
  await page.goto(new URL(app+'settings/notifications/urgent-cleanup',current.origin).href);await page.getByRole('combobox',{name:'Saved alert setup',exact:true}).selectOption({index:1});await page.getByRole('button',{name:'Turn off saved urgent alerts',exact:true}).click();await expect(page.getByText(/1 original removals await confirmation/)).toBeVisible();await expect(page.getByRole('button',{name:'Confirm original alert removals',exact:true})).toBeEnabled();
 }else if(mode==='offline'){
  await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>undefined));await page.context().setOffline(true);await page.getByRole('button',{name:'Turn off urgent alerts',exact:true}).click();await expect(page.getByText(/Urgent alerts are off here/)).toBeVisible();
 }else if(mode==='target'||mode==='payment'){
  const task=mode==='target'?await service.createUrgentTask():await service.createUrgentPayment(),notice=await service.claimUrgentNotice(mode==='target'?task.id:undefined);
  await page.goto(new URL(app+'inbox?urgent='+encodeURIComponent(JSON.stringify(notice)),current.origin).href);await expect(page.getByRole('heading',{name:'From your notification',exact:true})).toBeVisible();await expect(page.locator(mode==='target'?'#task-'+task.id:'.payment-review')).toContainText(mode==='target'?'Review this urgent source':'Observed payment for a person to check.');
 }
 await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const report=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(report.violations).toEqual([]);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});await page.addStyleTag({content:'.app-skip,.app-bottom-nav{visibility:hidden!important}'});
}
export async function closeUrgentInboxVisual(){const current=service;service=undefined;if(current)await current.close();}
