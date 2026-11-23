import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {startCustomerLinkService,installCustomerLinks} from '../fixtures/install-customer-links.mjs';
let service:Awaited<ReturnType<typeof startCustomerLinkService>>;
test.describe.configure({timeout:90000});
test.beforeAll(async()=>{service=await startCustomerLinkService({staffTeam:true});});test.beforeEach(async()=>{await service.reset();});test.afterAll(async()=>{await service.close();});
async function createLink(page:Page,lost=false){
 await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Use manual copy');}}});});
 await page.goto('app/?flags=staffTeam,cloudSetup');await installCustomerLinks(page);await page.evaluate(config=>window.miseCustomerLinkTest.initialize(config),service.config());await page.goto('app/team/members?flags=staffTeam,cloudSetup');
 await expect(page.locator('.staff-read-state p')).toHaveText(/^Checked \d{2}:\d{2}$/);await page.getByRole('button',{name:'Add member',exact:true}).click();
 const add=page.getByRole('dialog',{name:'Add member',exact:true});await add.getByLabel('Name',{exact:true}).fill('Nadia Akter');await add.getByLabel('Name in Bangla',{exact:true}).fill('নাদিয়া আক্তার');
 await add.getByRole('switch',{name:'Their own staff link',exact:true}).click();await add.getByRole('button',{name:'Save changes',exact:true}).click();await expect(add).toHaveCount(0);
 await page.getByRole('button',{name:'Edit Nadia Akter',exact:true}).click();const edit=page.getByRole('dialog',{name:'Edit member',exact:true});
 if(lost)service.loseNext('change_staff_link');await edit.getByRole('button',{name:'Create 30-day link',exact:true}).click();
 if(lost){
  await expect(edit.getByLabel('Saved staff link change',{exact:true})).toContainText('Unconfirmed staff link change');
  const before=await page.evaluate(()=>{const raw=Object.entries(localStorage).find(([key])=>key.startsWith('mise.staff-link-admin.v1:'))![1],row=JSON.parse(raw).actions.at(-1);return {action:row.action,token:row.token};});
  await edit.getByRole('button',{name:'Close member editor',exact:true}).click();await page.reload();await page.getByRole('button',{name:'Edit Nadia Akter',exact:true}).click();await edit.getByRole('button',{name:'Check saved link change',exact:true}).click();
  expect(await page.evaluate(()=>{const raw=Object.entries(localStorage).find(([key])=>key.startsWith('mise.staff-link-admin.v1:'))![1],row=JSON.parse(raw).actions.at(-1);return {action:row.action,token:row.token};})).toEqual(before);
 }
 await expect(edit.getByLabel('Saved staff link change',{exact:true})).toContainText('This original was recorded.');
 await edit.getByRole('button',{name:'Copy staff link',exact:true}).click();const field=edit.getByLabel('Staff link for manual copy',{exact:true});await expect(field).toBeFocused();expect(await field.evaluate((node:HTMLTextAreaElement)=>node.selectionStart===0&&node.selectionEnd===node.value.length)).toBe(true);
 expect(await edit.evaluate((node:HTMLDialogElement)=>node.matches(':modal'))).toBe(true);return {url:await field.inputValue(),edit};
}
async function openShift(page:Page,url:string){await page.goto(url);await expect(page.getByRole('heading',{name:'Nadia Akter · Desk',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'I’m here',exact:true})).toBeEnabled();}
test('the owner recovers the exact locally saved link after a lost creation reply and reload',async({page})=>{
 const {url}=await createLink(page,true);expect(new URL(url).pathname).toMatch(/\/app\/me\/[A-Za-z0-9_-]{43}$/);expect((await service.staffCounts()).links).toBe(1);
});
test('a staff browser with full storage retains manual copy without sending a check-in',async({page,browser})=>{
 const {url}=await createLink(page),guest=await browser.newContext();try{
  await guest.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('mise.staff-public.v1:'))throw Error('Quota');return original.call(this,key,value);};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Blocked');}}});});
  const staff=await guest.newPage();await staff.goto(url);await expect(staff.getByRole('heading',{name:'Nadia Akter · Desk',exact:true})).toBeVisible();await expect(staff.getByRole('button',{name:'I’m here',exact:true})).toBeDisabled();await staff.getByRole('button',{name:'Copy check-in message',exact:true}).click();const field=staff.getByLabel('Message for manual copy',{exact:true});await expect(field).toBeFocused();expect(await field.inputValue()).toContain('Nadia Akter');expect(await field.evaluate((node:HTMLTextAreaElement)=>node.selectionStart===0&&node.selectionEnd===node.value.length)).toBe(true);expect((await service.staffCounts()).checkIns).toBe(0);
 }finally{await guest.close();}
});
test('a private member link writes real attendance, reaches the board, and revokes without an Auth account or owner database',async({page,browser})=>{
 const {url,edit}=await createLink(page),guest=await browser.newContext();try{
  const staff=await guest.newPage();await openShift(staff,url);expect(await staff.evaluate(()=>indexedDB.databases())).toEqual([]);expect(await staff.evaluate(()=>Object.keys(localStorage).filter(key=>/auth|connection|operator|staff-owner/.test(key)))).toEqual([]);
  await staff.getByRole('button',{name:'I’m here',exact:true}).click();await expect(staff.getByLabel('Current presence',{exact:true})).toContainText('On duty');await expect(staff.getByLabel('Your recorded activity',{exact:true})).toContainText('own staff link');
  await edit.getByRole('button',{name:'Close member editor',exact:true}).click();await page.getByRole('link',{name:'On duty',exact:true}).click();const card=page.locator('.staff-presence-card').filter({has:page.getByRole('heading',{name:'Nadia Akter · Desk',exact:true})});await expect(card.locator('.status-word')).toContainText('In');await expect(card).toContainText('own staff link');
  await staff.getByRole('button',{name:'Take a break',exact:true}).click();await expect(card.locator('.status-word')).toContainText('Break');await staff.getByRole('button',{name:'I’m back',exact:true}).click();await expect(card.locator('.status-word')).toContainText('In');await staff.getByRole('button',{name:'Leaving',exact:true}).click();await expect(card.locator('.status-word')).toContainText('Out');
  expect((await service.staffCounts()).checkIns).toBe(4);expect(service.calls.filter(row=>row.path.endsWith('/public/staff')).every(row=>!row.auth&&!row.apikey)).toBe(true);
  await page.getByRole('link',{name:'Members',exact:true}).click();await page.getByRole('button',{name:'Edit Nadia Akter',exact:true}).click();const editor=page.getByRole('dialog',{name:'Edit member',exact:true});await editor.getByRole('button',{name:'Revoke link',exact:true}).click();await expect(editor.locator('.staff-link-list')).toContainText('Revoked');
  await staff.getByRole('button',{name:'Check now',exact:true}).click();await expect(staff.getByRole('heading',{name:'This staff link is unavailable.',exact:true})).toBeVisible();await expect(staff.getByLabel('Your recorded activity',{exact:true})).toHaveCount(0);await expect(staff.getByLabel('Saved original tap',{exact:true})).toContainText('This original tap was recorded.');
 }finally{await guest.close();}
});
test('a lost anonymous reply and offline closure retain their originals across a fresh reload',async({page,browser})=>{
 const {url}=await createLink(page),guest=await browser.newContext();try{
  const staff=await guest.newPage();await openShift(staff,url);service.loseNext('staff');await staff.getByRole('button',{name:'I’m here',exact:true}).click();await expect(staff.getByLabel('Saved original tap',{exact:true})).toContainText('This tap is unconfirmed.');
  const original=await staff.evaluate(()=>JSON.parse(Object.entries(localStorage).find(([key])=>key.startsWith('mise.staff-public.v1:'))![1]).actions.at(-1).intent);
  await staff.reload();await staff.getByRole('button',{name:'Check saved tap',exact:true}).click();await expect(staff.getByLabel('Saved original tap',{exact:true})).toContainText('This original tap was recorded.');expect((await service.staffCounts()).checkIns).toBe(1);
  expect(await staff.evaluate(()=>JSON.parse(Object.entries(localStorage).find(([key])=>key.startsWith('mise.staff-public.v1:'))![1]).actions.at(-1).intent)).toEqual(original);
  await guest.setOffline(true);await staff.getByRole('button',{name:'Leaving',exact:true}).click();await expect(staff.getByLabel('Saved original tap',{exact:true})).toContainText('This tap is unconfirmed.');await staff.getByRole('button',{name:'Close unfinished tap',exact:true}).click();
  expect(await staff.evaluate(()=>JSON.parse(Object.entries(localStorage).find(([key])=>key.startsWith('mise.staff-public.v1:'))![1]).actions.at(-1).closeRequested)).toBe(true);
  await guest.setOffline(false);await staff.reload();await staff.getByRole('button',{name:'Close unfinished tap',exact:true}).click();await expect(staff.getByLabel('Saved original tap',{exact:true})).toContainText('This unfinished tap was closed.');expect((await service.staffCounts()).checkIns).toBe(1);expect((await service.staffCounts()).closed).toBe(1);
 }finally{await guest.close();}
});
for(const width of [360,390,768,1024,1440])test(`the actual staff link and Bangla activity fit ${width}px and meet AA`,async({page,browser})=>{
 const {url}=await createLink(page),guest=await browser.newContext({viewport:{width,height:1000}});try{
  const staff=await guest.newPage();await openShift(staff,url);await staff.getByRole('button',{name:'I’m here',exact:true}).click();await staff.getByRole('button',{name:'বাংলা',exact:true}).click();await expect(staff.getByRole('heading',{name:'আমার শিফট',exact:true})).toBeVisible();
  expect(await staff.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await new AxeBuilder({page:staff}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 }finally{await guest.close();}
});
