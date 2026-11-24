import {expect,test,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import fixtures from '../fixtures/ocr/expected.json';
import {reportBackupFixture} from '../report-backup-fixture';
import {ocrAssets} from '../../apps/web/src/ocr/assets';
// @ts-expect-error Test-only standalone bundler helper.
import {ocrBrowserModule} from '../fixtures/ocr-browser.mjs';

const seed=reportBackupFixture(),normalized=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim();
async function setup(page:Page,baseURL:string){
 const base=new URL('app/',baseURL).pathname,moduleUrl=new URL('ocr-verification.mjs',new URL('app/',baseURL)).href;
 const body=await ocrBrowserModule(base);await page.route(moduleUrl,route=>route.fulfill({contentType:'text/javascript',body}));
 await page.goto('app/?flags=shareTarget');await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
 await page.getByRole('button',{name:'Restore a backup',exact:true}).click();await page.getByLabel('Choose JSON backup',{exact:true}).setInputFiles({name:'shop.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(seed))});const preview=page.getByRole('dialog',{name:'Restore backup',exact:true});await preview.getByRole('checkbox').check();await preview.getByRole('button',{name:'Restore this backup',exact:true}).click();await expect(page.locator('.today-page')).toHaveAttribute('aria-busy','false');
 return {base,moduleUrl};
}
async function read(page:Page,moduleUrl:string,file:string){
 const bytes=[...readFileSync(resolve('tests/fixtures/ocr',file))];
 return page.evaluate(async({moduleUrl,bytes,file})=>{const reader=await import(moduleUrl),result=await reader.readImageOnDevice(new Blob([new Uint8Array(bytes)],{type:file.endsWith('.jpg')?'image/jpeg':'image/png'}),{signal:new AbortController().signal});return {...result,invoice:reader.parseOcrInvoice(result,'BDT')};},{moduleUrl,bytes,file});
}
test('real eng+ben worker reads all 15 fixed printed invoices, remains lazy, and works after an offline reload',async({page,baseURL})=>{
 test.setTimeout(240_000);const requests:{url:string;method:string}[]=[];page.context().on('request',request=>requests.push({url:request.url(),method:request.method()}));const {base,moduleUrl}=await setup(page,baseURL!);
 expect(requests.filter(request=>new URL(request.url).pathname.includes('/ocr/'))).toEqual([]);
 const results=[];
 for(const fixture of fixtures.fixtures){
  const result=await read(page,moduleUrl,fixture.file),lines=result.text.split(/\r?\n/).map(normalized).filter(Boolean),correct=fixture.lines.filter(line=>lines.includes(normalized(line))).length;
  const items=result.invoice.items.map((item:{name:string;quantity:number;unit:string;unitPrice:number;printedAmount:number})=>({name:item.name,quantity:item.quantity,unit:item.unit,unitPrice:item.unitPrice,printedAmount:item.printedAmount}));
  results.push({id:fixture.id,correct,total:fixture.lines.length,itemCorrect:items.filter((item:unknown,index:number)=>JSON.stringify(item)===JSON.stringify(fixture.itemValues[index])).length,itemTotal:fixture.itemValues.length,text:result.text,items});
  expect.soft(correct/fixture.lines.length,fixture.id+' complete literal printed lines').toBeGreaterThanOrEqual(.8);expect.soft(items,fixture.id+' exact priced item fields').toEqual(fixture.itemValues);expect.soft(result.invoice.totalCheck,fixture.id+' totals').toBe('matches');expect(result.lines.length).toBeGreaterThan(0);expect(result.lines.some((line:{confidence:number|null})=>line.confidence!==null)).toBe(true);
 }
 await test.info().attach('actual-15-invoice-ocr.json',{body:Buffer.from(JSON.stringify(results,null,2)),contentType:'application/json'});
 expect(requests.every(request=>new URL(request.url).origin===new URL(baseURL!).origin&&request.method==='GET')).toBe(true);
 const cached=await page.evaluate(async()=>{const names=await caches.keys(),name=names.find(name=>name.startsWith('mise-ocr:'));return name?(await (await caches.open(name)).keys()).map(request=>new URL(request.url).pathname.split('/').pop()):[];});expect(cached.sort()).toEqual(ocrAssets.files.map(file=>file.name).sort());
 await page.context().setOffline(true);await page.reload();await expect(page.locator('.today-page')).toHaveAttribute('aria-busy','false');
 // Fulfil only the test module; every engine/model request uses the built worker.
 const offline=await read(page,moduleUrl,fixtures.fixtures[0].file);expect(normalized(offline.text)).toContain(normalized(fixtures.fixtures[0].itemLines[0]));
 expect(await page.evaluate(base=>location.pathname.startsWith(base),base)).toBe(true);
});
test('real Bangla recognition returns literal Unicode text without an external OCR request',async({page,baseURL})=>{
 test.setTimeout(90_000);const {moduleUrl}=await setup(page,baseURL!),result=await read(page,moduleUrl,fixtures.languageFixture.file);
 await test.info().attach('actual-bangla-ocr.json',{body:Buffer.from(JSON.stringify(result,null,2)),contentType:'application/json'});
 expect(result.text).toContain('চাল');expect(result.text).toContain('চিনি');expect(result.text).toContain('লবণ');
});
test('cancelling real initialization terminates it and permits a fresh read of the same original',async({page,baseURL})=>{
 test.setTimeout(90_000);const {moduleUrl}=await setup(page,baseURL!),bytes=[...readFileSync(resolve('tests/fixtures/ocr',fixtures.fixtures[0].file))];
 const cancelled=await page.evaluate(async({moduleUrl,bytes})=>{
  const reader=await import(moduleUrl),controller=new AbortController();
  try{await reader.readImageOnDevice(new Blob([new Uint8Array(bytes)],{type:'image/png'}),{signal:controller.signal,onProgress:(progress:{stage:string})=>{if(progress.stage==='load')controller.abort();}});return 'unexpected success';}catch(error){return error instanceof DOMException?error.name:String(error);}
 },{moduleUrl,bytes});expect(cancelled).toBe('AbortError');
 const result=await read(page,moduleUrl,fixtures.fixtures[0].file);expect(result.invoice.items.map((item:{name:string})=>item.name)).toEqual(['Chicken','Oil','Yogurt']);
});
