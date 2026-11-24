import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {installStaffDevice} from './install-staff-device.mjs';
async function build(options){const vite=await import(pathToFileURL(createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]})).href),result=await vite.build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,...options}}),output=Array.isArray(result)?result[0].output:result.output,chunk=output.find(item=>item.type==='chunk');if(!chunk||output.filter(item=>item.type==='chunk').length!==1)throw Error('Expected one stock service fixture');return chunk.code;}
export async function startStaffStockService(){const code=await build({ssr:'tests/fixtures/staff-stock-service.ts',rollupOptions:{external:['@electric-sql/pglite']}});mkdirSync('.private',{recursive:true});const file=resolve('.private/staff-stock-service-'+process.pid+'.mjs');writeFileSync(file,code);return(await import(pathToFileURL(file).href)).startStaffStockService();}
let visualService;const accessibility=[];
export async function captureStaffStock(page,mode){
 visualService??=await startStaffStockService();const source=await visualService.prepare();await installStaffDevice(page);await page.evaluate(source=>window.miseStaffDeviceTest.initialize(source),source);await page.reload();await page.getByRole('button',{name:'Stock',exact:true}).click();await expect(page.getByRole('button',{name:'Refresh stock',exact:true})).toBeEnabled();await expect(page.locator('.staff-stock-item')).toHaveCount(6);
 if(mode==='count'){await page.getByRole('button',{name:'Count',exact:true}).click();await page.getByRole('textbox',{name:'Counted Chicken',exact:true}).fill('12.125');}
 else if(mode==='review'){await page.getByLabel('Quick update',{exact:true}).fill('used 2 kg chicken');await page.getByRole('button',{name:'Review',exact:true}).click();await page.getByRole('button',{name:'Compare current quantities',exact:true}).click();await expect(page.getByRole('region',{name:'Current stock comparison'})).toBeVisible();}
 else if(mode==='archive'||mode==='archive-open'){
  await page.getByLabel('Quick update',{exact:true}).fill('used 2 kg chicken');await page.getByRole('button',{name:'Review',exact:true}).click();await page.getByRole('button',{name:'Compare current quantities',exact:true}).click();await page.getByRole('button',{name:'Confirm quantities',exact:true}).click();await expect(page.getByText('Stock batch · Recorded',{exact:true})).toBeVisible();
  const event=page.waitForEvent('download');await page.getByRole('button',{name:'Save completed stock archive',exact:true}).click();const download=await event,path=await download.path();if(!path)throw Error('Saved stock archive missing');
  if(mode==='archive-open'){const file={name:download.suggestedFilename(),mimeType:'application/json',buffer:readFileSync(path)};await page.getByLabel('Select the saved stock archive file',{exact:true}).setInputFiles(file);await page.getByRole('button',{name:'Remove verified stock copies',exact:true}).click();await expect(page.getByRole('region',{name:'Verify saved stock archive'})).toHaveCount(0);await page.getByLabel('Open a stock archive',{exact:true}).setInputFiles(file);await expect(page.getByRole('region',{name:'Opened stock archive'})).toBeVisible();}
 }
 else if(mode!=='stock')throw Error('Unknown staff stock capture');
 await page.evaluate(()=>document.fonts.ready);const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 const assets=await page.locator('.staff-stock img').evaluateAll(images=>images.map(img=>({file:img.getAttribute('src').split('/').at(-1),width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height}))),expected=mode==='count'?{'history.svg':14}:mode.startsWith('archive')?{'count.svg':14,'history.svg':14}:{'count.svg':14,'history.svg':14,'mic.svg':18,'minus.svg':14,'plus.svg':14,'low-dot.svg':6};
 for(const[file,size]of Object.entries(expected)){const matches=assets.filter(asset=>asset.file===file);expect(matches.length).toBeGreaterThan(0);for(const asset of matches)expect(asset).toEqual({file,width:size,height:size});}
 accessibility.push({mode,width:page.viewportSize().width,overflow,assets,violations:result.violations.map(v=>({id:v.id,impact:v.impact}))});expect(result.violations).toEqual([]);expect(overflow).toBe(false);
}
export async function closeStaffStockVisual(){if(visualService){await visualService.close();visualService=undefined;}if(accessibility.length)writeFileSync('.private/staff-stock-ui-visual-axe.json',JSON.stringify(accessibility,null,2)+'\n');}
