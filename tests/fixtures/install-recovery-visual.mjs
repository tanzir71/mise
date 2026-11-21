import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installSyncApplyFixture} from './install-sync-apply.mjs';
import AxeBuilder from '@axe-core/playwright';

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
async function checkLocalInboxAccess(page){await page.evaluate(()=>document.fonts.ready);const result=await new AxeBuilder({page}).analyze();if(result.violations.some(v=>v.impact==='serious'||v.impact==='critical')){writeFileSync('.private/order-review-visual-axe.json',JSON.stringify(result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),null,2));throw Error('The current view has serious or critical accessibility violations; local rule/selector details are retained privately.');}}
export async function captureLocalInboxReview(page,mode='review'){
 service??=start();const {server,installRealtimeFixture}=await service,config=server.config(1);
 await page.evaluate(()=>localStorage.setItem('mise.flags',JSON.stringify({cloudSync:true,shareTarget:true})));
 await installRealtimeFixture(page,config.jwt);await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),config);
 const base=new URL('.',page.url());await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Turn on sync',exact:true}).click();await page.getByRole('link',{name:'Sync: Synced',exact:true}).waitFor({timeout:30000});await installSyncApplyFixture(page);
 const id=await page.evaluate(async()=>{await window.miseSyncApplyTest.lock();return (await window.miseSyncApplyTest.captureImage()).id;});
 await page.goto(new URL('settings/sync?flags=cloudSync',base).href);
 if(mode==='locked'){await page.getByRole('heading',{name:'Choose an outlet and member',exact:true}).waitFor();await page.getByRole('status').filter({hasText:'saved on this device'}).waitFor();await checkLocalInboxAccess(page);return;}
 await page.getByRole('button',{name:'Review cloud access',exact:true}).click();await page.getByRole('button',{name:'Check current access',exact:true}).click();await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await page.getByRole('link',{name:'Sync: Synced',exact:true}).waitFor({timeout:30000});
 if(mode==='list'){await page.goto(new URL('inbox?flags=shareTarget',base).href);await page.getByRole('heading',{name:'Saved on this device',exact:true}).waitFor();await checkLocalInboxAccess(page);return;}
 await page.goto(new URL('inbox/'+id+'?flags=shareTarget',base).href);await page.getByRole('heading',{name:'Saved share',exact:true}).waitFor();await checkLocalInboxAccess(page);
}
/** An empty device with a real local capture, without any seeded account or outlet. */
export async function capturePendingJoinShare(page,mode){
 if(!['setup','join'].includes(mode))throw Error('Choose a setup or join share notice.');
 await installSyncApplyFixture(page);
 await page.evaluate(async mode=>{localStorage.setItem('mise.flags',JSON.stringify({cloudSync:mode==='join',shareTarget:true}));await window.miseSyncApplyTest.captureImage();},mode);
 await page.reload();
 if(mode==='join')await page.getByRole('button',{name:'Join an existing outlet',exact:true}).click();
 else if(await page.getByRole('button',{name:'Join an existing outlet',exact:true}).count())throw Error('The default-off join action must not be advertised during local setup.');
 await page.getByRole('status').filter({hasText:'1 shared item is saved on this device.'}).waitFor();
 await checkLocalInboxAccess(page);
}
/** The actual order-review controls backed by two devices and local SQL/HTTP. */
export async function captureOrderActionReview(page,mode='review'){
 if(!['review','unconfirmed','currency'].includes(mode))throw Error('Choose a saved order review state.');
 // Each capture owns its SQL state: a prior withdrawal deliberately leaves a
 // financial fence, which must not become another viewport's starting context.
 const {server,installRealtimeFixture}=await start();
 const base=new URL('.',page.url()),ownerContext=await page.context().browser().newContext(),owner=await ownerContext.newPage();
 try{
  await owner.goto(base.href);await installSyncApplyFixture(owner);await owner.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(1));
  await owner.evaluate(()=>window.miseSyncApplyTest.pull());
  await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(2));
  if(mode==='currency'){await page.evaluate(()=>window.miseSyncApplyTest.queueNewOrder());await owner.evaluate(()=>window.miseSyncApplyTest.setCurrency('USD'));}
  else{await page.evaluate(async()=>{await window.miseSyncApplyTest.concurrentOrder('payment');await window.miseSyncApplyTest.cash('5');});await owner.evaluate(()=>window.miseSyncApplyTest.concurrentOrder('price'));}
  await owner.evaluate(()=>window.miseSyncApplyTest.deliver());await owner.evaluate(()=>window.miseSyncApplyTest.pull());
  await page.evaluate(()=>window.miseSyncApplyTest.cycle());await installRealtimeFixture(page,server.config(2).jwt);
  await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Review saved order action',exact:true}).click();
  const panel=page.getByRole('region',{name:'Saved order review'});
  await panel.getByRole('button',{name:'Check current values',exact:true}).click();await panel.getByRole('button',{name:'Apply reviewed action',exact:true}).waitFor();
  await page.waitForFunction(disabled=>{const buttons=Array.from(document.querySelectorAll('.order-action-review button'));return buttons.some(b=>b.textContent?.trim()==='Apply reviewed action'&&b.disabled===disabled)&&buttons.some(b=>b.textContent?.trim()==='Withdraw saved action'&&!b.disabled);},mode==='currency');
  if(mode==='unconfirmed'){
   server.loseNextResolution();await panel.getByRole('button',{name:'Withdraw saved action',exact:true}).click();await panel.getByRole('alert').filter({hasText:'unconfirmed'}).waitFor();
  }
  await checkLocalInboxAccess(page);
 }finally{try{await ownerContext.close();}finally{await server.close();}}
}
/** Current credit consent, currency mismatch or an actual lost SQL outcome.
 * Accessibility is checked before screenshot-only styles hide fixed navigation. */
export async function captureMoneyActionReview(page,mode='review'){
 const {server,installRealtimeFixture}=await start(),base=new URL('.',page.url()),ownerContext=await page.context().browser().newContext(),owner=await ownerContext.newPage();
 try{
  await owner.goto(base.href);await installSyncApplyFixture(owner);await owner.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(1));
  await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(2));
  await page.context().setOffline(true);
  if(mode==='currency'){await page.evaluate(()=>window.miseSyncApplyTest.cash('37'));await owner.evaluate(()=>window.miseSyncApplyTest.setCurrency('USD'));}
  else{await page.evaluate(()=>window.miseSyncApplyTest.credit('800'));await owner.evaluate(()=>window.miseSyncApplyTest.credit('700'));}
  await owner.evaluate(()=>window.miseSyncApplyTest.deliver());await owner.evaluate(()=>window.miseSyncApplyTest.pull());
  await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.cycle());await installRealtimeFixture(page,server.config(2).jwt);
  await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Review saved money action',exact:true}).click();
  const panel=page.getByRole('region',{name:'Saved money review'});
  await panel.getByRole('button',{name:'Check money values',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.money-action-review button')).some(b=>b.textContent?.trim()==='Withdraw saved money action'&&!b.disabled));
  if(mode==='currency'){
   if(await panel.getByRole('button',{name:'Apply reviewed money action',exact:true}).isEnabled())throw Error('Do not convert the original currency.');
  }else{
   await panel.getByRole('checkbox',{name:'Allow this credit sale above the checked limit',exact:true}).waitFor();
   if(mode==='unconfirmed'){
    await panel.getByRole('checkbox').check();server.loseNextResolution();await panel.getByRole('button',{name:'Apply reviewed money action',exact:true}).click();await panel.getByRole('alert').filter({hasText:'unconfirmed'}).waitFor();
   }
  }
  await checkLocalInboxAccess(page);
 }finally{try{await ownerContext.close();}finally{await server.close();}}
}
/** A rejected original invoice, a compatible current-value comparison or a lost
 * real SQL outcome. No invoice receipt or choice is fabricated by the fixture. */
export async function capturePurchaseActionReview(page,mode='review'){
 const {server,installRealtimeFixture}=await start(),base=new URL('.',page.url()),ownerContext=await page.context().browser().newContext(),owner=await ownerContext.newPage();
 try{
  await owner.goto(base.href);await installSyncApplyFixture(owner);await owner.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(1));await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(2));
  await page.context().setOffline(true);await page.evaluate(()=>window.miseSyncApplyTest.queuePurchase());await owner.evaluate(()=>window.miseSyncApplyTest.setCurrency('USD'));await owner.evaluate(()=>window.miseSyncApplyTest.deliver());await owner.evaluate(()=>window.miseSyncApplyTest.pull());await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.cycle());
  if(mode!=='currency'){await owner.evaluate(()=>window.miseSyncApplyTest.setCurrency('BDT'));await owner.evaluate(()=>window.miseSyncApplyTest.deliver());await owner.evaluate(()=>window.miseSyncApplyTest.pull());}
  await installRealtimeFixture(page,server.config(2).jwt);await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Review saved invoice',exact:true}).click();const panel=page.getByRole('region',{name:'Saved invoice review'});await panel.getByRole('button',{name:'Check current invoice values',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.purchase-action-review button')).some(button=>button.textContent?.trim()==='Withdraw saved invoice action'&&!button.disabled));
  if(mode==='currency'){if(await panel.getByRole('button',{name:'Apply reviewed invoice action',exact:true}).isEnabled())throw Error('Do not convert the original invoice currency.');}
  else if(mode==='unconfirmed'){server.loseNextResolution();await panel.getByRole('button',{name:'Apply reviewed invoice action',exact:true}).click();await panel.getByRole('alert').filter({hasText:'unconfirmed'}).waitFor();}
  await checkLocalInboxAccess(page);
 }finally{try{await ownerContext.close();}finally{await server.close();}}
}
/** Original stock intent and actual checked/committed SQL outcome. */
export async function captureStockActionReview(page,mode='review'){
 const {server,installRealtimeFixture}=await start(),base=new URL('.',page.url()),ownerContext=await page.context().browser().newContext(),owner=await ownerContext.newPage();
 try{
  await owner.goto(base.href);await installSyncApplyFixture(owner);await owner.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(1));await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(2));await page.context().setOffline(true);
  if(mode==='supplier')await page.evaluate(()=>window.miseSyncApplyTest.stockEdit('Saved supplier · বাংলা',7));else await page.evaluate(()=>window.miseSyncApplyTest.stock('count',7));
  if(mode==='supplier')await owner.evaluate(()=>window.miseSyncApplyTest.stockEdit('Current supplier',10));else await owner.evaluate(()=>window.miseSyncApplyTest.stock('count',10));await owner.evaluate(()=>window.miseSyncApplyTest.deliver());await owner.evaluate(()=>window.miseSyncApplyTest.pull());await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.cycle());await installRealtimeFixture(page,server.config(2).jwt);await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Review saved stock',exact:true}).click();const panel=page.getByRole('region',{name:'Saved stock review'});await panel.getByRole('button',{name:'Check current stock values',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.stock-action-review button')).some(button=>button.textContent?.trim()==='Withdraw saved stock action'&&!button.disabled));
  if(mode==='unconfirmed'){server.loseNextResolution();await panel.getByRole('button',{name:'Apply reviewed stock action',exact:true}).click();await panel.getByRole('alert').filter({hasText:'unconfirmed'}).waitFor();}await checkLocalInboxAccess(page);
 }finally{try{await ownerContext.close();}finally{await server.close();}}
}
/** A genuine rejected counter command; no order review or resolution is invented. */
export async function captureMoneyCurrencyReview(page){
 const {server,installRealtimeFixture}=await start(),base=new URL('.',page.url()),ownerContext=await page.context().browser().newContext(),owner=await ownerContext.newPage();
 try{
  await owner.goto(base.href);await installSyncApplyFixture(owner);await owner.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(1));await owner.evaluate(()=>window.miseSyncApplyTest.pull());
  await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(2));
  await page.context().setOffline(true);await page.evaluate(()=>window.miseSyncApplyTest.cash('37'));
  await owner.evaluate(()=>window.miseSyncApplyTest.setCurrency('USD'));await owner.evaluate(()=>window.miseSyncApplyTest.deliver());await owner.evaluate(()=>window.miseSyncApplyTest.pull());
  await page.context().setOffline(false);await page.evaluate(()=>window.miseSyncApplyTest.cycle());await installRealtimeFixture(page,server.config(2).jwt);
  await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByText('Some saved work needs review. Your local records and downloaded pages are kept.').waitFor();
  if(await page.getByRole('button',{name:'Review saved order action',exact:true}).count())throw Error('Do not advertise order-only review for a counter action.');
  await page.getByRole('link',{name:'Download a JSON backup',exact:true}).waitFor();await checkLocalInboxAccess(page);
 }finally{try{await ownerContext.close();}finally{await server.close();}}
}
/** A real full-scope recovery refuses changed-currency pending money before admission. */
export async function capturePendingCurrencyRecovery(page){
 const {server,installRealtimeFixture}=await start(),base=new URL('.',page.url()),ownerContext=await page.context().browser().newContext(),owner=await ownerContext.newPage();
 try{
  await owner.goto(base.href);await installSyncApplyFixture(owner);await owner.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(1));await owner.evaluate(()=>window.miseSyncApplyTest.pull());
  await installSyncApplyFixture(page);await page.evaluate(config=>window.miseSyncApplyTest.initialize(config),server.config(2));await installRealtimeFixture(page,server.config(2).jwt);
  await page.goto(new URL('settings/sync?flags=cloudSync',base).href);await page.getByRole('button',{name:'Turn on sync',exact:true}).click();await page.getByRole('link',{name:'Sync: Synced',exact:true}).waitFor({timeout:30000});await installSyncApplyFixture(page);
  await page.context().setOffline(true);await page.evaluate(async()=>{await window.miseSyncApplyTest.cash('37');await window.miseSyncApplyTest.captureImage();});
  await owner.evaluate(()=>window.miseSyncApplyTest.setCurrency('USD'));await owner.evaluate(()=>window.miseSyncApplyTest.deliver());await owner.evaluate(()=>window.miseSyncApplyTest.pull());await server.changeEpoch();await page.context().setOffline(false);
  await page.getByRole('button',{name:'Review outlet access',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'Review outlet access',exact:true}).click();await page.getByRole('button',{name:'Check current access',exact:true}).click();await page.getByRole('alert').waitFor({timeout:30000});
  if(await page.getByRole('button',{name:'Apply reviewed changes',exact:true}).count())throw Error('Do not admit a recovery that changes the original monetary unit.');
  await page.getByRole('button',{name:'Download saved shop backup',exact:true}).waitFor();await checkLocalInboxAccess(page);
 }finally{try{await ownerContext.close();}finally{await server.close();}}
}
export async function closeRecoveryVisual(){const previous=service;service=undefined;if(previous){let value;try{value=await previous;}catch{return;}await value.server.close();}}
