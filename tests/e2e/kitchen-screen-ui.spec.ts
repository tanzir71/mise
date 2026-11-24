import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdirSync} from 'node:fs';
import {installKitchenUi,startKitchenUiService} from '../fixtures/install-kitchen-ui.mjs';
import type {startKitchenUiService as Factory} from '../fixtures/kitchen-ui-service';
let service:Awaited<ReturnType<typeof Factory>>;
test.beforeAll(async()=>{service=await startKitchenUiService();});
test.afterAll(async()=>{await service?.close();});
async function initialize(page:Page){const config=await service.prepare();await page.goto('app/screen/kitchen?flags=kitchenScreen');await installKitchenUi(page);await page.evaluate(screen=>window.miseKitchenUiTest.initialize(screen),config.screen);await page.reload();await expect(page.getByRole('heading',{name:'Kitchen',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();await installKitchenUi(page);return config;}
async function enterNextPin(page:Page){
 await expect(page.getByRole('combobox',{name:'Your name',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Your name',exact:true}).selectOption({label:'Member 104'});
 await page.getByLabel('Four-digit PIN',{exact:true}).fill('0042');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Kitchen',exact:true})).toBeVisible();await installKitchenUi(page);
}

test('actual Team permission changes disable and restore preparation without granting money access',async({page})=>{
 await initialize(page);const before=await service.inspect();await service.setTeamConfirmation(false);await page.getByRole('button',{name:'Check now',exact:true}).click();
 await expect(page.getByText('Preparation is read-only.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Got it',exact:true})).toBeDisabled();expect(await service.inspect()).toMatchObject({status:before.status,receipts:0,payment:before.payment,total:before.total});
 await service.setTeamConfirmation(true);await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByRole('button',{name:'Got it',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByRole('button',{name:'Ready',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Ready',exact:true}).click();
 await expect.poll(()=>service.inspect()).toMatchObject({status:'ready',receipts:2,payment:before.payment,total:before.total});
});
test('personal originals remain recoverable with zero current order rights and a later PIN on the same screen',async({page,context})=>{
 await initialize(page);const before=await service.inspect();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);
 await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];
 await service.setTeamConfirmation(false);await service.denyOrderRead();await context.setOffline(false);await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Sign in with your PIN again.'})).toBeVisible();
 await page.getByRole('button',{name:'My saved taps',exact:true}).click();await expect(page.getByRole('heading',{name:'My saved taps',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Got it',exact:true})).toHaveCount(0);
 await context.setOffline(true);await page.getByRole('button',{name:'Close saved tap',exact:true}).click();await expect(page.getByText('Close request saved on this screen · waiting for confirmation.',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'My saved taps',exact:true}).click();await expect(page.getByText('Close request saved on this screen · waiting for confirmation.',{exact:true})).toBeVisible();
 await context.setOffline(false);await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('combobox',{name:'Your name',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Your name',exact:true}).selectOption({label:'Member 105'});await page.getByLabel('Four-digit PIN',{exact:true}).fill('0042');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'My saved taps',exact:true})).toBeVisible();await page.getByRole('button',{name:'My saved taps',exact:true}).click();
 await page.getByRole('button',{name:'Check confirmation',exact:true}).click();await expect(page.getByText('Confirmation is still needed.',{exact:false})).toHaveCount(0);expect((await service.inspect()).closures).toBe(0);
 await page.getByRole('button',{name:'Close saved tap',exact:true}).click();await expect(page.getByText('Closed after review. The original ticket is kept.',{exact:true})).toBeVisible();await installKitchenUi(page);const saved=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(saved.id).toBe(original.id);expect(saved.source).toEqual(original.source);expect(saved.closeIntents).toHaveLength(2);expect(saved.closeIntents[0].sessionId).not.toBe(saved.closeIntents[1].sessionId);
 expect(await service.inspect()).toMatchObject({status:before.status,payment:before.payment,total:before.total,actionCalls:0,receipts:0,closures:1});
});
test('a different member sees no saved original from the previous PIN in personal recovery',async({page,context})=>{
 await initialize(page);await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();await context.setOffline(false);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await enterNextPin(page);await page.getByRole('button',{name:'My saved taps',exact:true}).click();await expect(page.getByText('No saved preparation taps for your PIN on this screen.',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'A-2041 · Got it',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Copy original ticket',exact:true})).toHaveCount(0);
});
test('personal original copy remains usable offline when the clipboard is unavailable',async({page,context})=>{
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Unavailable');}}}));
 await initialize(page);await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();await page.getByRole('button',{name:'My saved taps',exact:true}).click();
 await page.getByRole('button',{name:'Copy original ticket',exact:true}).click();const field=page.getByRole('textbox',{name:'Original ticket for manual copy',exact:true});await expect(field).toBeVisible();await expect(field).toBeFocused();await expect(field).toHaveValue(/চিকেন বিরিয়ানি/);
 expect(await service.inspect()).toMatchObject({actionCalls:0,receipts:0,closures:0});
});
test('an offline original survives Team No and can be closed from its saved review without a preparation request',async({page,context})=>{
 await initialize(page);const before=await service.inspect();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();
 const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];await service.setTeamConfirmation(false);await context.setOffline(false);await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByText('Preparation is read-only.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:/Saved taps ·/}).click();await page.getByRole('button',{name:'Close saved tap',exact:true}).click();await expect(page.getByText('Closed after review. The original ticket is kept.',{exact:true})).toBeVisible();
 expect(await service.inspect()).toMatchObject({status:before.status,receipts:0,closures:1,actionCalls:0,payment:before.payment,total:before.total});const saved=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(saved.id).toBe(original.id);expect(saved.source).toEqual(original.source);
});

test('owner handoff and undo update the focused board while offline original taps and cached history stay intact',async({page,context})=>{
 await initialize(page);const before=await service.inspect();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);
 await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByRole('button',{name:'Ready',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Ready',exact:true}).click();await expect(page.getByText('2 saved taps need confirmation.',{exact:false})).toBeVisible();
 const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;expect(original).toHaveLength(2);
 await service.handoffFromDesk();await page.reload();await installKitchenUi(page);expect((await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps).toEqual(original);
 await context.setOffline(false);await page.getByRole('button',{name:'Check now',exact:true}).click();
 await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toHaveCount(0);
 await expect.poll(async()=>page.evaluate(()=>window.miseKitchenUiTest.inspect())).toMatchObject({tickets:1,ticketStates:[{status:'delivering'}]});
 const saved=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;for(let i=0;i<2;i++){expect(saved[i].id).toBe(original[i].id);expect(saved[i].source).toEqual(original[i].source);expect(saved[i].receipt).toBeNull();}
 expect(await service.inspect()).toMatchObject({status:'delivering',receipts:0,payment:before.payment,total:before.total});
 await service.undoLastStatus();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();
 const after=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;for(let i=0;i<2;i++){expect(after[i].id).toBe(original[i].id);expect(after[i].source).toEqual(original[i].source);expect(after[i].receipt).toBeNull();}
 expect(await service.inspect()).toMatchObject({status:'ready',receipts:0,payment:before.payment,total:before.total});
});

test('a future schedule updates the actual warning deadline and remains quiet through an offline reload',async({page,context})=>{
 await initialize(page);await service.ageOrder();await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toBeVisible();
 const start=Date.now()+3600000;await service.scheduleFromDesk(start);await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toHaveCount(0);
 await expect.poll(async()=>page.evaluate(()=>window.miseKitchenUiTest.inspect())).toMatchObject({ticketStates:[{scheduledFor:start}]});
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toHaveCount(0);
 await context.setOffline(false);await service.scheduleFromDesk(Date.now()-180000);await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toBeVisible();
 expect(await service.inspect()).toMatchObject({status:'accepted',receipts:0});
});

declare global{interface Window{miseKitchenControls:{sounds:number;requests:string[];releases:number;current:WakeLockSentinel|null}}}
test('sound needs the actual gesture and visible work, and an involuntary wake-lock release clears its On claim',async({page})=>{
 await page.addInitScript(()=>{
  const trace:Window['miseKitchenControls']={sounds:0,requests:[],releases:0,current:null};window.miseKitchenControls=trace;
  const Original=window.AudioContext;class ObservedAudio extends Original{createOscillator(){trace.sounds++;return super.createOscillator();}}
  Object.defineProperty(window,'AudioContext',{value:ObservedAudio});
  class ScreenLock extends EventTarget{released=false;readonly type='screen' as const;onrelease=null;async release(){if(this.released)return;this.released=true;trace.releases++;this.dispatchEvent(new Event('release'));}}
  Object.defineProperty(navigator,'wakeLock',{value:{request:async(type:string)=>{trace.requests.push(type);const lock=new ScreenLock();trace.current=lock;return lock;}}});
 });
 await initialize(page);expect(await page.evaluate(()=>window.miseKitchenControls.sounds)).toBe(0);
 await page.getByRole('button',{name:'Sound off',exact:true}).click();await expect(page.getByRole('button',{name:'Sound on',exact:true})).toHaveAttribute('aria-pressed','true');
 const first=await page.evaluate(()=>window.miseKitchenControls.sounds);expect(first).toBeGreaterThan(0);
 const next=await service.addOrder(2042);await expect(page.getByRole('heading',{name:next.number,exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>window.miseKitchenControls.sounds)).toBeGreaterThan(first);
 await service.handoffFromDesk();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toHaveCount(0);const quiet=await page.evaluate(()=>window.miseKitchenControls.sounds),start=Date.now()+3600000;
 await service.scheduleFromDesk(start);await expect.poll(async()=>{await installKitchenUi(page);return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.ticketStates.find(ticket=>ticket.status==='delivering')?.scheduledFor;}).toBe(start);
 expect(await page.evaluate(()=>window.miseKitchenControls.sounds)).toBe(quiet);
 await page.getByRole('button',{name:'Sound on',exact:true}).click();const last=await page.evaluate(()=>window.miseKitchenControls.sounds),third=await service.addOrder(2043);await expect(page.getByRole('heading',{name:third.number,exact:true})).toBeVisible();expect(await page.evaluate(()=>window.miseKitchenControls.sounds)).toBe(last);
 await page.getByRole('button',{name:'Keep awake off',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.miseKitchenControls.requests)).toEqual(['screen']);
 await page.evaluate(()=>window.miseKitchenControls.current!.release());await expect(page.getByRole('button',{name:'Keep awake off',exact:true})).toHaveAttribute('aria-pressed','false');
 await expect(page.getByText('Keep this screen open and adjust the device’s sleep setting if needed.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Keep awake off',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.miseKitchenControls.requests.length)).toBe(2);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.miseKitchenControls.releases)).toBe(2);
});

test('unavailable audio and rejected wake lock leave visible manual controls and no false On state',async({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(window,'AudioContext',{value:undefined});Object.defineProperty(navigator,'wakeLock',{value:{request:async()=>{throw Error('Synthetic device denial');}}});});
 await initialize(page);const before=await service.inspect();await page.getByRole('button',{name:'Sound off',exact:true}).click();await expect(page.getByText('Sound could not start. Check new tickets on this screen.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Sound off',exact:true})).toHaveAttribute('aria-pressed','false');await page.getByRole('button',{name:'Keep awake off',exact:true}).click();
 await expect(page.getByText('Keep this screen open and adjust the device’s sleep setting if needed.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Keep awake off',exact:true})).toHaveAttribute('aria-pressed','false');await expect(page.getByRole('button',{name:'Copy ticket',exact:true})).toBeVisible();
 expect(await service.inspect()).toMatchObject({status:before.status,receipts:0,payment:before.payment,total:before.total});
});

test('Understood retains the cancellation through offline reload and confirms one original receipt after a lost reply',async({page,context})=>{
 await initialize(page);await service.cancelFromDesk();await expect(page.getByRole('button',{name:'Understood',exact:true})).toBeVisible();const before=await service.inspect();
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);
 await page.getByRole('button',{name:'Understood',exact:true}).click();await expect(page.getByText('Understood saved on this screen · waiting for confirmation',{exact:true})).toBeVisible();
 const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(original.receipt).toBeNull();expect(original.source.status).toBe('cancelled');
 await page.reload();await installKitchenUi(page);await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();expect((await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0]).toEqual(original);
 service.loseNext();await context.setOffline(false);await page.getByRole('button',{name:'Check now',exact:true}).click();
 await expect.poll(async()=>service.inspect()).toMatchObject({status:'cancelled',receipts:1,payment:before.payment,total:before.total});
 await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toHaveCount(0);
 const saved=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(saved).toMatchObject({...original,receipt:original.id});expect(saved.source).toEqual(original.source);
});

test('a genuine older Understood cannot dismiss a new cancellation after an owner undo',async({page})=>{
 await initialize(page);await service.cancelFromDesk();await expect(page.getByRole('button',{name:'Understood',exact:true})).toBeVisible();const before=await service.inspect();
 await page.getByRole('button',{name:'Understood',exact:true}).click();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toHaveCount(0);
 const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(original.receipt).toBe(original.id);
 await service.undoLastStatus();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();await service.cancelFromDesk();await expect(page.getByRole('button',{name:'Understood',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Understood',exact:true}).click();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toHaveCount(0);
 const taps=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;expect(taps).toHaveLength(2);expect(taps[0]).toEqual(original);expect(taps[1].receipt).toBe(taps[1].id);expect(taps[1].id).not.toBe(original.id);expect(taps[1].source.revision).toBeGreaterThan(original.source.revision);
 expect(await service.inspect()).toMatchObject({status:'cancelled',receipts:2,payment:before.payment,total:before.total});
});
test('live outlet warning settings reach the actual screen and remain disabled after an offline reload',async({page,context})=>{
 await initialize(page);const before=await service.inspect();await service.ageOrder();
 await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toBeVisible();
 await service.setAlarmSettings(true,5);await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toHaveCount(0);
 await service.setAlarmSettings(false,2);await page.getByRole('button',{name:'Check now',exact:true}).click();
 await expect.poll(async()=>page.evaluate(()=>window.miseKitchenUiTest.inspect())).toMatchObject({warningMinutes:null});
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);await page.reload();
 await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toHaveCount(0);
 await installKitchenUi(page);expect(await page.evaluate(()=>window.miseKitchenUiTest.inspect())).toMatchObject({warningMinutes:null});
 await context.setOffline(false);await expect(page.getByText('Live updates connected',{exact:false})).toBeVisible();
 await service.setAlarmSettings(true,2);await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByText('Waiting for acknowledgement',{exact:true})).toHaveCount(0);
 await expect.poll(async()=>service.inspect()).toMatchObject({receipts:1,payment:before.payment,total:before.total});
});
test('native offline Got it and Ready survive reload and converge once without changing payment',async({page,context})=>{
 await initialize(page);const before=await service.inspect();
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
 await context.setOffline(true);await expect(page.getByText('Offline · showing saved tickets',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Got it',exact:true}).click();await expect(page.getByRole('button',{name:'Ready',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Ready',exact:true}).click();await expect(page.getByText('2 saved taps need confirmation.',{exact:false})).toBeVisible();
 const saved=await page.evaluate(()=>window.miseKitchenUiTest.inspect());expect(saved!.taps).toHaveLength(2);expect(saved!.taps[1].parent).toBe(saved!.taps[0].id);
 await page.reload();await expect(page.getByText('2 saved taps need confirmation.',{exact:false})).toBeVisible();await installKitchenUi(page);expect(await page.evaluate(()=>window.miseKitchenUiTest.inspect())).toEqual(saved);
 await context.setOffline(false);await page.getByRole('button',{name:'Check now',exact:true}).click();await expect.poll(async()=>service.inspect()).toMatchObject({status:'ready',receipts:2,payment:before.payment,total:before.total});
 await expect(page.getByText('2 saved taps need confirmation.',{exact:false})).toHaveCount(0);
 const text=await page.locator('main').innerText();for(const privateText of ['PRIVATE MESSAGE','PRIVATE CUSTOMER','PRIVATE ADDRESS','14155550199'])expect(text).not.toContain(privateText);
});
test('a SQL-committed acknowledgement with a lost reply retries the original ID and creates one receipt',async({page})=>{
 const requests:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/functions/v1/kitchen-actions'))requests.push(request.postDataJSON().action.id);});
 await initialize(page);service.loseNext();await page.getByRole('button',{name:'Got it',exact:true}).click();
 await expect.poll(async()=>service.inspect()).toMatchObject({receipts:1});
 const saved=await page.evaluate(()=>window.miseKitchenUiTest.inspect());await page.getByRole('button',{name:'Check now',exact:true}).click();
 await expect.poll(async()=>page.evaluate(()=>window.miseKitchenUiTest.inspect())).toMatchObject({taps:[{id:saved!.taps[0].id,receipt:saved!.taps[0].id}]});
 expect(requests.length).toBeGreaterThanOrEqual(2);expect(requests.every(id=>id===saved!.taps[0].id)).toBe(true);expect(await service.inspect()).toMatchObject({receipts:1});
});
test('a committed order reaches the kitchen through PostgreSQL notify, private WebSocket relay and scoped HTTP within two seconds',async({page})=>{
 await initialize(page);await expect(page.getByText('Live updates connected',{exact:false})).toBeVisible();expect(service.liveCounts().connections).toBeGreaterThan(0);
 const before=service.liveCounts().broadcasts,start=performance.now();const order=await service.addOrder(2042);
 await expect(page.getByRole('heading',{name:order.number,exact:true})).toBeVisible({timeout:2000});expect(performance.now()-start).toBeLessThan(2000);expect(service.liveCounts().broadcasts).toBeGreaterThan(before);
 const text=await page.locator('main').innerText();expect(text).not.toContain('PRIVATE MESSAGE');expect(text).not.toContain('PRIVATE CUSTOMER');
});
for(const width of [360,390,768,1024,1440])test(`kitchen tickets fit ${width}px and meet WCAG AA`,async({page})=>{
 await page.setViewportSize({width,height:900});await initialize(page);await page.evaluate(()=>document.fonts.ready);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 const report=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(report.violations).toEqual([]);
 mkdirSync('.private/kitchen-ui-captures',{recursive:true});await page.screenshot({path:`.private/kitchen-ui-captures/kitchen-${width}.png`,fullPage:true});
});

test('a new staff PIN recovers a committed original Got it with its original actor after the first reply is lost',async({page})=>{
 await initialize(page);service.loseOriginalReplies();await page.getByRole('button',{name:'Got it',exact:true}).click();
 await expect.poll(async()=>service.inspect()).toMatchObject({receipts:1});await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();
 const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await enterNextPin(page);
 await expect.poll(async()=>{await installKitchenUi(page);return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.taps[0].receipt;}).toBe(original.id);
 const recovered=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(recovered.memberId).toBe(original.memberId);expect(recovered.sessionId).toBe(original.sessionId);expect(recovered.source).toEqual(original.source);
 expect(await service.inspect()).toMatchObject({receipts:1,closures:0});
 expect((await service.inspect()).actionOrigins.every(value=>value==='original')).toBe(true);
});
test('earlier offline Got it and Ready require explicit review and closing them never acknowledges the order',async({page,context})=>{
 await initialize(page);await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);
 await page.getByRole('button',{name:'Got it',exact:true}).click();await page.getByRole('button',{name:'Ready',exact:true}).click();
 await expect(page.getByText('2 saved taps need confirmation.',{exact:false})).toBeVisible();
 const originals=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps,before=await service.inspect();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Finish the previous sign-out',exact:true})).toBeVisible();
 await context.setOffline(false);await page.getByRole('button',{name:'Retry sign-out',exact:true}).click();await enterNextPin(page);
 await page.getByRole('button',{name:'Saved taps · 2',exact:true}).click();await expect(page.getByText('Earlier PIN session',{exact:false}).first()).toBeVisible();
 expect(await service.inspect()).toMatchObject({receipts:0,closures:0,actionCalls:0,status:before.status});
 const first=page.locator('.kitchen-review-item').filter({has:page.getByRole('heading',{name:'A-2041 · Got it',exact:true})});
 await first.getByRole('button',{name:'Close saved tap',exact:true}).click();await expect(first.getByText('Closed after review.',{exact:false})).toBeVisible();
 const second=page.locator('.kitchen-review-item').filter({has:page.getByRole('heading',{name:'A-2041 · Ready',exact:true})});
 await second.getByRole('button',{name:'Close saved tap',exact:true}).click();await expect(second.getByText('Closed after review.',{exact:false})).toBeVisible();
 expect(await service.inspect()).toMatchObject({receipts:0,closures:2,actionCalls:0,status:before.status,payment:before.payment,total:before.total});
 const closed=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;for(let i=0;i<2;i++){expect(closed[i].id).toBe(originals[i].id);expect(closed[i].source).toEqual(originals[i].source);expect(closed[i].memberId).toBe(originals[i].memberId);expect(closed[i].closure?.memberId).not.toBe(originals[i].memberId);}
 await page.getByRole('button',{name:'Got it',exact:true}).click();await expect.poll(async()=>service.inspect()).toMatchObject({receipts:1,closures:2,actionCalls:1});
 const after=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;expect(after).toHaveLength(3);expect(after[2].id).not.toBe(originals[0].id);expect(after[2].memberId).not.toBe(originals[0].memberId);
});
test('an offline close request survives a lost committed reply and browser reload with one original resolution',async({page,context})=>{
 await initialize(page);const before=await service.inspect();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);
 await page.getByRole('button',{name:'Got it',exact:true}).click();await page.getByRole('button',{name:'Saved taps · 1',exact:true}).click();await page.getByRole('button',{name:'Close saved tap',exact:true}).click();
 await expect(page.getByText('Close request saved on this screen',{exact:false})).toBeVisible();const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(original.closeIntents).toHaveLength(1);
 service.loseNextClose();await context.setOffline(false);await expect.poll(async()=>service.inspect()).toMatchObject({closures:1});await page.reload();await installKitchenUi(page);
 await expect.poll(async()=>{await installKitchenUi(page);return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.taps[0].closure?.id;}).toBe(original.closeIntents[0].id);
 const recovered=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];expect(recovered.closeIntents).toEqual(original.closeIntents);expect(recovered.source).toEqual(original.source);expect(recovered.receipt).toBeNull();
 expect(await service.inspect()).toMatchObject({closures:1,receipts:0,actionCalls:0,status:before.status,payment:before.payment,total:before.total});
});
test('a held saved-tap recovery reply cannot delay another real committed order beyond two seconds',async({page,context})=>{
 await initialize(page);await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);
 await page.getByRole('button',{name:'Got it',exact:true}).click();await page.getByRole('button',{name:'Saved taps · 1',exact:true}).click();await page.getByRole('button',{name:'Close saved tap',exact:true}).click();
 await expect(page.getByText('Close request saved on this screen',{exact:false})).toBeVisible();const held=service.holdNextRecovery();
 try{await context.setOffline(false);await held.started;await expect(page.getByText('Live updates connected',{exact:false})).toBeVisible();
  const start=performance.now(),order=await service.addOrder(2042);await expect(page.getByRole('heading',{name:order.number,exact:true})).toBeVisible({timeout:2000});expect(performance.now()-start).toBeLessThan(2000);
 }finally{held.release();}
 await expect.poll(async()=>service.inspect()).toMatchObject({closures:1,receipts:0});await expect(page.getByRole('heading',{name:'A-2042',exact:true})).toBeVisible();
});
test('a historical Ready receipt does not override the newer real order state after an owner undo',async({page})=>{
 await initialize(page);await page.getByRole('button',{name:'Got it',exact:true}).click();await expect.poll(async()=>service.inspect()).toMatchObject({receipts:1});
 await page.getByRole('button',{name:'Ready',exact:true}).click();await expect.poll(async()=>service.inspect()).toMatchObject({receipts:2,status:'ready'});
 const saved=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;await service.undoLastStatus();
 await expect(page.locator('.kitchen-ticket').getByText('Cooking',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Ready',exact:true})).toBeEnabled();
 const retained=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;expect(retained.map(tap=>tap.receipt)).toEqual(saved.map(tap=>tap.receipt));
 expect(await service.inspect()).toMatchObject({status:'packing',receipts:2});
});
test('an undone Got it returns to New and a fresh Ready keeps the new actual acknowledgement parent',async({page})=>{
 await initialize(page);const before=await service.inspect();await page.getByRole('button',{name:'Got it',exact:true}).click();
 await expect.poll(async()=>{return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.taps[0]?.receipt??null;}).not.toBeNull();
 const original=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0];await service.undoLastStatus();
 await expect(page.getByRole('button',{name:'Got it',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Ready',exact:true})).toHaveCount(0);
 expect((await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0]).toEqual(original);
 await page.getByRole('button',{name:'Got it',exact:true}).click();await expect.poll(async()=>{return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.taps[1]?.receipt??null;}).not.toBeNull();
 const second=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[1];await page.getByRole('button',{name:'Ready',exact:true}).click();
 await expect.poll(async()=>service.inspect()).toMatchObject({status:'ready',receipts:3,payment:before.payment,total:before.total});
 const saved=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;expect(saved[0]).toEqual(original);expect(saved[2].parent).toBe(second.id);expect(saved[2].parent).not.toBe(original.id);
});
test('an offline queued Ready is retained for review after another screen readies and the owner undoes it',async({page,context})=>{
 await initialize(page);const before=await service.inspect();await page.getByRole('button',{name:'Got it',exact:true}).click();
 await expect.poll(async()=>{return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.taps[0]?.receipt??null;}).not.toBeNull();
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);await page.getByRole('button',{name:'Ready',exact:true}).click();
 await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();const queued=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[1];
 await service.readyFromAnotherScreen();await service.undoLastStatus();await context.setOffline(false);
 await expect.poll(async()=>{return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.taps.find(tap=>tap.id===queued.id)?.review??false;}).toBe(true);
 expect(await service.inspect()).toMatchObject({status:'packing',receipts:2,payment:before.payment,total:before.total});
 const reviewed=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[1];expect(reviewed.source).toEqual(queued.source);expect(reviewed.receipt).toBeNull();
 await page.getByRole('button',{name:'Saved taps · 2',exact:true}).click();await page.getByRole('button',{name:'Close saved tap',exact:true}).click();
 await expect.poll(async()=>{return (await page.evaluate(()=>window.miseKitchenUiTest.inspect()))?.taps[1]?.closure??null;}).not.toBeNull();
 await page.getByRole('button',{name:'Ready',exact:true}).click();await expect.poll(async()=>service.inspect()).toMatchObject({status:'ready',receipts:3,closures:1,payment:before.payment,total:before.total});
 const saved=(await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps;expect(saved[1].source).toEqual(queued.source);expect(saved[1].receipt).toBeNull();expect(saved[2].id).not.toBe(queued.id);expect(saved[2].parent).toBe(queued.parent);
});
for(const width of [360,390,768,1024,1440])test(`saved kitchen tap review fits ${width}px and meets WCAG AA`,async({page,context})=>{
 await page.setViewportSize({width,height:900});await initialize(page);await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await context.setOffline(true);
 await page.getByRole('button',{name:'Got it',exact:true}).click();await page.getByRole('button',{name:'Saved taps · 1',exact:true}).click();await page.getByText('Original ticket',{exact:true}).click();
 await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(result.violations).toEqual([]);
 mkdirSync('.private/kitchen-ui-captures',{recursive:true});await page.screenshot({path:`.private/kitchen-ui-captures/review-${width}.png`,fullPage:true});
});
