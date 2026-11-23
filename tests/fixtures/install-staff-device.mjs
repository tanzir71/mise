import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
let bundle;
async function build(options){const vite=await import(pathToFileURL(createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]})).href),result=await vite.build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},build:{write:false,minify:false,...options}}),output=Array.isArray(result)?result[0].output:result.output,chunk=output.find(item=>item.type==='chunk');if(!chunk||output.filter(item=>item.type==='chunk').length!==1)throw Error('Expected one staff fixture');return chunk.code;}
export async function startStaffDeviceService(){const code=await build({ssr:'tests/fixtures/staff-device-service.ts',rollupOptions:{external:['@electric-sql/pglite']}});mkdirSync('.private',{recursive:true});const path=resolve('.private/staff-device-service-'+process.pid+'.mjs');writeFileSync(path,code);return(await import(pathToFileURL(path).href)).startStaffDeviceService();}
export async function installStaffDevice(page){bundle??=build({lib:{entry:resolve('tests/fixtures/staff-device-browser.ts'),formats:['iife'],name:'MiseStaffDeviceTest'},rollupOptions:{output:{inlineDynamicImports:true}}});const code=await bundle,url=new URL('__mise_staff_device_test.js',page.url()).href;await page.route(url,r=>r.fulfill({contentType:'text/javascript',body:code}));await page.addScriptTag({url});}
let visualService;const accessibility=[];
export async function captureStaffDevice(page,mode){visualService??=await startStaffDeviceService();const source=await visualService.prepare(true);await installStaffDevice(page);await page.evaluate(source=>window.miseStaffDeviceTest.initialize(source),source);await page.reload();await expect(page.getByRole('button',{name:'Open my shift',exact:true})).toBeVisible();
 if(mode==='shift'){await page.getByRole('button',{name:'My shift',exact:true}).click();await expect(page.getByRole('heading',{name:'Karim Uddin · Kitchen',exact:true})).toBeVisible();await page.getByRole('button',{name:'বাংলা',exact:true}).click();}
 await page.evaluate(()=>document.fonts.ready);const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 const assets=await page.locator(mode==='shift'?'.staff-public img':'.staff-device-board img').evaluateAll(images=>images.map(img=>({file:img.getAttribute('src').split('/').at(-1),width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height}))),expected=mode==='shift'?{'presence.svg':8,'message.svg':18}:{'check.svg':12,'plus.svg':16};
 for(const[file,size]of Object.entries(expected)){const matches=assets.filter(asset=>asset.file===file);expect(matches.length).toBeGreaterThan(0);for(const asset of matches)expect(asset).toEqual({file,width:size,height:size});}
 accessibility.push({mode,width:page.viewportSize().width,overflow,assets,violations:result.violations.map(v=>({id:v.id,impact:v.impact}))});expect(result.violations).toEqual([]);expect(overflow).toBe(false);
}
export async function closeStaffDeviceVisual(){if(visualService){await visualService.close();visualService=undefined;}if(accessibility.length)writeFileSync('.private/staff-device-ui-visual-axe.json',JSON.stringify(accessibility,null,2)+'\n');}
