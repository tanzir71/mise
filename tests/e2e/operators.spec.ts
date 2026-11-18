import {localTableNames} from '../../packages/core/local-schema';
import {localSchemaVersion} from '../../packages/core/local-outbox';
import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile} from 'node:fs/promises';
import {operatorBackupFixture} from '../operator-backup-fixture';
// @ts-expect-error Shared native browser installer is plain JavaScript.
import {installOperatorsFixture} from '../fixtures/install-operators.mjs';
// @ts-expect-error All Auth requests are intercepted on a reserved .test host.
import {installPhoneAuthFixture} from '../fixtures/phone-auth-browser.mjs';

const source=operatorBackupFixture(),manager=source.tables.members.find(m=>m.role==='manager')!,payload={name:'operators.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(source))};
async function restore(page:Page){
 await page.context().addInitScript(()=>localStorage.setItem('mise.flags',JSON.stringify({exports:true,cloudSetup:true})));
 await page.goto('app/');await page.getByRole('button',{name:'Restore a backup',exact:true}).click();await page.getByLabel('Choose JSON backup',{exact:true}).setInputFiles(payload);const preview=page.getByRole('dialog',{name:'Restore backup',exact:true});await preview.getByRole('checkbox',{name:'Restore this shop on this browser',exact:true}).check();await preview.getByRole('button',{name:'Restore this backup',exact:true}).click();await expect(page.getByRole('heading',{name:'Choose an outlet and member'})).toBeVisible();
}
async function selectManager(page:Page){await page.getByRole('radio',{name:/Mina manager/}).check();await page.getByRole('button',{name:'Continue on this device',exact:true}).click();await expect(page.locator('.today-page')).toHaveAttribute('aria-busy','false');}
async function inspect(page:Page){await installOperatorsFixture(page);return page.evaluate(()=>window.miseOperatorsTest.inspect());}
async function signIn(page:Page){
 await installPhoneAuthFixture(page);await page.goto('app/settings/sync');await page.getByLabel('Project URL',{exact:true}).fill('https://cloud.test');await page.getByLabel('Publishable key',{exact:true}).fill('sb_publishable_test_only');await page.getByRole('button',{name:'Save connection',exact:true}).click();await page.getByLabel('Phone number',{exact:true}).fill('01712345482');await page.getByRole('button',{name:'Send verification code',exact:true}).click();await page.getByLabel('Verification code',{exact:true}).fill('123456');await page.getByRole('button',{name:'Verify phone',exact:true}).click();await expect(page.locator('.cloud-verified')).toBeVisible();await installOperatorsFixture(page);return page.evaluate(()=>window.miseOperatorsTest.bindInterceptedSession());
}

test('recovery requires an explicit manager, attributes real cash and backup preparation, and keeps owner settings guarded',async({page})=>{
 await restore(page);await selectManager(page);await page.goto('app/counter');await page.getByLabel('Calculation',{exact:true}).fill('5');await page.locator('.counter-cash').click();await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');let saved=await inspect(page);expect(saved.sales.at(-1)?.createdBy).toBe(manager.id);expect(saved.schema).toBe(localSchemaVersion);expect(saved.stores).toBe(localTableNames.length);
 await page.goto('app/settings/business');await expect(page.getByText('Only an owner can change shop details.')).toBeVisible();await expect(page.getByLabel('Shop name',{exact:true})).toHaveCount(0);
 await page.goto('app/settings/shop-link');await expect(page.getByLabel('Public WhatsApp phone',{exact:true})).toHaveValue('');
 await page.goto('app/settings/exports');await expect(page.locator('.exports-page')).toHaveAttribute('aria-busy','false');const sheet=page.getByRole('dialog',{name:'Export',exact:true});if(await sheet.isVisible())await sheet.getByRole('button',{name:'Backup and restore',exact:true}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download JSON backup',exact:true}).click();const bytes=await readFile((await(await download).path())!,'utf8'),backup=JSON.parse(bytes);expect(Object.keys(backup.tables)).toHaveLength(21);expect(backup.tables.members.find((m:{id:string})=>m.id===manager.id)).toEqual(manager);expect(bytes).not.toContain('operatorState');saved=await inspect(page);expect(saved.events.filter(e=>e.command==='export.prepare').at(-1)?.actor.id).toBe(manager.id);
});
test('ambiguous recovery offers a real backup without inventing an owner audit',async({page})=>{
 await restore(page);await page.getByText('Backup and recovery',{exact:true}).click();const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download JSON backup',exact:true}).click();const backup=JSON.parse(await readFile((await(await pending).path())!,'utf8'));expect(backup.tables.members).toHaveLength(3);expect((await inspect(page)).events.filter(e=>e.command==='export.prepare')).toEqual([]);await expect(page.getByRole('heading',{name:'Choose an outlet and member'})).toBeVisible();
});
test('another tab changing the operator remounts stale forms and attributes the next cash sale to the new actor',async({page,context})=>{
 await restore(page);await selectManager(page);await page.goto('app/counter');await page.getByLabel('Calculation',{exact:true}).fill('99');const other=await context.newPage();await other.goto('app/more');await other.getByRole('button',{name:'Change outlet or member',exact:true}).click();await other.getByRole('radio',{name:new RegExp('Second outlet.*Owner')}).check();await other.getByRole('button',{name:'Continue on this device',exact:true}).click();await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');await page.getByLabel('Calculation',{exact:true}).fill('3');await page.locator('.counter-cash').click();await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');const saved=await inspect(page),sale=saved.sales.at(-1)!;expect(sale.createdBy).toBe(source.tables.members[0].id);expect(sale.outletId).toBe(source.tables.outlets[1].id);expect(saved.members.find(m=>m.id===source.tables.members[0].id)?.outletIds).toEqual([]);await other.close();
});
test('removing a manager assignment stops the mounted app and the next write',async({page})=>{
 await restore(page);await selectManager(page);await page.goto('app/counter');await inspect(page);await page.evaluate(()=>window.miseOperatorsTest.revokeManager());await expect(page.getByRole('heading',{name:'Choose an outlet and member'})).toBeVisible();await expect(page.getByRole('radio',{name:/Mina manager/})).toHaveCount(0);await expect(page.getByLabel('Calculation',{exact:true})).toHaveCount(0);
});
test('actual SDK sign-out locks the explicit cloud selection while leaving source records available for backup',async({page})=>{
 await restore(page);await selectManager(page);await signIn(page);await expect(page.locator('.cloud-verified')).toBeVisible();await page.getByRole('button',{name:'Sign out on this device',exact:true}).click();await expect(page.getByRole('heading',{name:'Choose an outlet and member'})).toBeVisible();expect((await inspect(page)).selection?.phase).toBe('locked');await expect(page.getByText('Use the verified cloud connection to review this operator. Local records and unsent work are kept.')).toBeVisible();await page.getByText('Backup and recovery',{exact:true}).click();await expect(page.getByRole('button',{name:'Download JSON backup',exact:true})).toBeVisible();
});
test('cross-tab credential removal locks a cached operator even away from the Auth route',async({page,context})=>{
 await restore(page);await selectManager(page);const binding=await signIn(page);await page.goto('app/counter');await expect(page.getByLabel('Calculation',{exact:true})).toBeVisible();const other=await context.newPage();await other.goto('app/more');await other.evaluate(key=>localStorage.removeItem(key),binding.authKey);await expect(page.getByRole('heading',{name:'Choose an outlet and member'})).toBeVisible();expect((await inspect(page)).selection?.phase).toBe('locked');await other.close();
});
for(const width of [360,390,768,1024,1440])test(`operator recovery and selection fit and meet axe at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});await restore(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);await selectManager(page);await page.goto('app/more');await page.getByRole('button',{name:'Change outlet or member',exact:true}).click();await expect(page.getByRole('button',{name:'Back to the shop',exact:true})).toBeVisible();await page.getByRole('button',{name:'Back to the shop',exact:true}).click();await expect(page.getByRole('heading',{name:'Working as Mina manager',exact:true})).toBeVisible();
});
