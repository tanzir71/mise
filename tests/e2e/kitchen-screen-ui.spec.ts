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
 await initialize(page);service.loseNext();await page.getByRole('button',{name:'Got it',exact:true}).click();
 await expect.poll(async()=>service.inspect()).toMatchObject({receipts:1});await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toBeVisible();
 const saved=await page.evaluate(()=>window.miseKitchenUiTest.inspect());await page.getByRole('button',{name:'Check now',exact:true}).click();await expect(page.getByText('1 saved tap needs confirmation.',{exact:false})).toHaveCount(0);
 expect((await page.evaluate(()=>window.miseKitchenUiTest.inspect()))!.taps[0]).toMatchObject({id:saved!.taps[0].id,receipt:saved!.taps[0].id});expect(await service.inspect()).toMatchObject({receipts:1,actionCalls:2});
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
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await context.setOffline(false);await enterNextPin(page);
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
