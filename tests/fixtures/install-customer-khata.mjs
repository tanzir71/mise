import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
export async function startCustomerKhataService(){const vite=await import(pathToFileURL(createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]})).href),result=await vite.build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,ssr:'tests/fixtures/customer-khata-service.ts',rollupOptions:{external:['@electric-sql/pglite']}}}),output=Array.isArray(result)?result[0].output:result.output,chunk=output.find(c=>c.type==='chunk');if(!chunk||output.filter(c=>c.type==='chunk').length!==1)throw Error('Expected one khata fixture module');mkdirSync('.private',{recursive:true});const file=resolve('.private/customer-khata-service-'+process.pid+'.mjs');writeFileSync(file,chunk.code);return(await import(pathToFileURL(file).href)).startCustomerKhataService();}
let visualService;const checks=[];
export async function captureCustomerKhata(page,mode){
 visualService??=await startCustomerKhataService();const source=await visualService.prepare(),url=new URL(page.url()),at=url.pathname.lastIndexOf('/app/');if(at<0)throw Error('Missing app base');url.pathname=url.pathname.slice(0,at+5)+'k/'+source.token;url.search='?flags=customerLinks,customerKhata';url.hash='mise-customer='+encodeURIComponent(JSON.stringify({v:1,apiUrl:source.apiUrl}));
 if(mode==='copy')await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('blocked');}}}));await page.goto(url.href);await expect(page.getByRole('heading',{name:'৳960 due',exact:true})).toBeVisible();
 if(mode==='copy')await page.getByRole('button',{name:'Copy number',exact:true}).click();if(mode==='question'){await page.getByRole('button',{name:'বাংলা',exact:true}).click();await page.locator('.customer-khata-entry').click();}
 await page.evaluate(()=>document.fonts.ready);const axes=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),assets=await page.locator('.customer-khata img').evaluateAll(images=>images.map(img=>({file:img.getAttribute('src').split('/').at(-1),width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height})));
 for(const[file,size]of Object.entries({'wallet.svg':14,'clock.svg':14,'copy.svg':16,'receipt.svg':18})){const found=assets.filter(asset=>asset.file===file);expect(found.length).toBeGreaterThan(0);for(const asset of found)expect(asset).toEqual({file,width:size,height:size});}
 checks.push({mode,width:page.viewportSize().width,assets,overflow,violations:axes.violations.map(v=>({id:v.id,impact:v.impact}))});expect(axes.violations).toEqual([]);expect(overflow).toBe(false);
}
export async function closeCustomerKhataVisual(){if(visualService){await visualService.close();visualService=undefined;}if(checks.length)writeFileSync('.private/m35-visual-proof.json',JSON.stringify(checks,null,2)+'\n');}
