import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installSyncApplyFixture} from './install-sync-apply.mjs';

let service;
async function start(){
 const vitePath=createRequire(resolve('package.json')).resolve('vite',{paths:[resolve('apps/web')]}),{build}=await import(pathToFileURL(vitePath).href);
 const result=await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{alias:{'@mise/core':resolve('packages/core')}},ssr:{noExternal:['lz-string']},build:{ssr:'tests/fixtures/recovery-visual-service.ts',write:false,minify:false,rollupOptions:{external:['@electric-sql/pglite']}}});
 const output=Array.isArray(result)?result[0].output:result.output,chunk=output.find(item=>item.type==='chunk');
 if(!chunk||output.filter(item=>item.type==='chunk').length!==1)throw Error('Expected one isolated recovery service');
 mkdirSync('.private',{recursive:true});const path=resolve('.private/recovery-visual-service.mjs');writeFileSync(path,chunk.code);
 const module=await import(pathToFileURL(path).href+'?time='+Date.now()),server=await module.startConvergenceServer({originalOwner:true});
 return {server,installRealtimeFixture:module.installRealtimeFixture};
}
/** Fresh app state and real scoped SQL/HTTP; Auth, Realtime and Storage are local fixtures. */
export async function captureRecoveryReview(page){
 service??=start();const {server,installRealtimeFixture}=await service,config=server.config(1);
 await installRealtimeFixture(page,config.jwt);await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),config);
 const base=new URL('.',page.url());await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Turn on sync',exact:true}).click();
 await page.getByRole('link',{name:'Sync: Synced',exact:true}).waitFor({timeout:30000});await installSyncApplyFixture(page);
 await page.context().setOffline(true);await page.evaluate(async()=>{await window.miseSyncApplyTest.cash('73');await window.miseSyncApplyTest.captureImage();});await server.changeEpoch();await page.context().setOffline(false);
 await page.getByRole('button',{name:'Review outlet access',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'Review outlet access',exact:true}).click();
 await page.getByRole('button',{name:'Check current access',exact:true}).click();await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).waitFor({timeout:30000});
}
export async function captureOwnerResumeReview(page){
 service??=start();const {server,installRealtimeFixture}=await service,config=server.config(1);
 await installRealtimeFixture(page,config.jwt);await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),config);await page.evaluate(()=>window.miseSyncApplyTest.lock());
 const base=new URL('.',page.url());await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Review cloud access',exact:true}).click();
 await page.getByRole('heading',{name:'Restore the original connection',exact:true}).waitFor();await page.getByRole('button',{name:'Restore original connection',exact:true}).waitFor();
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.cloud-owner-resume button')).some(button=>button.textContent?.trim()==='Restore original connection'&&!button.disabled));
}
export async function closeRecoveryVisual(){const previous=service;service=undefined;if(previous){let value;try{value=await previous;}catch{return;}await value.server.close();}}
