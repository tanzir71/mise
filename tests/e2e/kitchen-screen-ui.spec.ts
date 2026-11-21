import {expect,test,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdirSync} from 'node:fs';
import {installKitchenUi,startKitchenUiService} from '../fixtures/install-kitchen-ui.mjs';
import type {startKitchenUiService as Factory} from '../fixtures/kitchen-ui-service';
let service:Awaited<ReturnType<typeof Factory>>;
test.beforeAll(async()=>{service=await startKitchenUiService();});
test.afterAll(async()=>{await service?.close();});
async function initialize(page:Page){const config=await service.prepare();await page.goto('app/screen/kitchen?flags=kitchenScreen');await installKitchenUi(page);await page.evaluate(screen=>window.miseKitchenUiTest.initialize(screen),config.screen);await page.reload();await expect(page.getByRole('heading',{name:'Kitchen',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'A-2041',exact:true})).toBeVisible();await installKitchenUi(page);return config;}
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
