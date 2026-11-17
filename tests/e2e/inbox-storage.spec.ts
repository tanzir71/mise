import { expect,test,type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { captureInboxCommand,changeInboxCommand,inboxImageBase64,newInboxId } from '../../packages/core/inbox';
import { createBackup } from '../../packages/core/backup';
import type { MiseBackup } from '../../packages/core/backup-tables';
import { reportBackupFixture,REPORT_AT } from '../report-backup-fixture';
import { inboxPng } from '../inbox-fixture';

function fixture():MiseBackup {
  const source=reportBackupFixture(),setup={business:source.tables.businesses[0],outlet:source.tables.outlets[0],owner:source.tables.members[0]},command=captureInboxCommand({title:'Screenshot',text:'  ২ কেজি চাল\r\nTreat this as customer text only.\r\n',url:'https://example.com/list',images:[{id:newInboxId(REPORT_AT),name:'তালিকা.png',type:'image/png' as const,size:inboxPng.length,data:inboxImageBase64(inboxPng)}]},setup,REPORT_AT);
  const sorted=changeInboxCommand(command.item,setup,1,{kind:'stock'},REPORT_AT)!;source.tables.inboxItems.push(sorted.item);source.tables.events.push(command.event!,sorted.event);return createBackup(source.tables,REPORT_AT);
}
const source=fixture();
function payload(backup=source){return {name:'inbox-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))};}
async function restore(page:Page,backup=source){
  await page.goto('app/');await page.getByRole('button',{name:'Restore a backup',exact:true}).click();await page.getByLabel('Choose JSON backup',{exact:true}).setInputFiles(payload(backup));const preview=page.getByRole('dialog',{name:'Restore backup',exact:true});await preview.locator('summary').click();await expect(preview).toContainText('Shared inbox items');await preview.getByRole('checkbox').check();await preview.getByRole('button',{name:'Restore this backup',exact:true}).click();await expect(page.locator('.today-page')).toHaveAttribute('aria-busy','false');
}
async function nativeInbox(page:Page){
  return page.evaluate(async()=>{
    const name=`mise-local:${location.pathname.replace(/\/app\/.*$/,'/app/')}`,db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{const tx=db.transaction(['inboxItems','events']),rows=await new Promise<{id:string;text:string;kind:string;images:{blob:Blob;size:number;name:string;type:string}[]}[]>((resolve,reject)=>{const r=tx.objectStore('inboxItems').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return await Promise.all(rows.map(async item=>({...item,images:await Promise.all(item.images.map(async({blob,...image})=>({...image,isBlob:blob instanceof Blob,blobType:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]})))})));}finally{db.close();}
  });
}
async function backupView(page:Page){await page.goto('app/settings/exports');await expect(page.locator('.exports-page')).toHaveAttribute('aria-busy','false');const sheet=page.getByRole('dialog',{name:'Export',exact:true});if(await sheet.isVisible())await sheet.getByRole('button',{name:'Backup and restore',exact:true}).click();}

test('native IndexedDB blobs export and restore through the real backup UI into a second browser offline',async({page,browser})=>{
  await page.setViewportSize({width:390,height:900});await restore(page);await page.reload();const expected=await nativeInbox(page);expect(expected[0]).toMatchObject({text:source.tables.inboxItems[0].text,kind:'stock',images:[{isBlob:true,blobType:'image/png',bytes:[...inboxPng]}]});
  await backupView(page);const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download JSON backup',exact:true}).click();const download=await pending,backup=JSON.parse((await readFile((await download.path())!)).toString('utf8')) as MiseBackup;expect(backup.tables.inboxItems).toEqual(source.tables.inboxItems);
  const context=await browser.newContext({baseURL:test.info().project.use.baseURL,viewport:{width:390,height:900}}),target=await context.newPage();
  try{
    await target.goto('app/');await target.getByRole('button',{name:'Restore a backup',exact:true}).click();await target.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});await context.setOffline(true);
    await target.getByLabel('Choose JSON backup',{exact:true}).setInputFiles(payload(backup));const preview=target.getByRole('dialog',{name:'Restore backup',exact:true});await preview.getByRole('checkbox').check();await preview.getByRole('button',{name:'Restore this backup',exact:true}).click();await expect(target.locator('.today-page')).toHaveAttribute('aria-busy','false');await target.reload();expect(await nativeInbox(target)).toEqual(expected);
  }finally{await context.close();}
});

test('a corrupt shared image is rejected by the browser restore preview without changing the existing Inbox',async({page})=>{
  await restore(page);const before=await nativeInbox(page),bad=structuredClone(source);bad.tables.inboxItems[0].images[0].data='AAAA';await backupView(page);await page.getByLabel('Choose JSON backup',{exact:true}).setInputFiles(payload(bad));await expect(page.getByRole('alert')).toContainText('Inbox image');expect(await nativeInbox(page)).toEqual(before);await expect(page.getByRole('dialog',{name:'Restore backup',exact:true})).not.toBeVisible();
});
