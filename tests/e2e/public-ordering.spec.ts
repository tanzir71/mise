import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {startCustomerLinkService,installCustomerLinks} from '../fixtures/install-customer-links.mjs';
import {readFileSync} from 'node:fs';
import {get} from 'node:http';
import {normalizeBase} from '../../packages/core/paths';
let service:Awaited<ReturnType<typeof startCustomerLinkService>>;
test.describe.configure({timeout:90000});
test.use({launchOptions:{ignoreDefaultArgs:['--disable-back-forward-cache']}});
test.beforeAll(async()=>{service=await startCustomerLinkService({ordering:true});});
test.beforeEach(async()=>{await service.reset();});
test.afterAll(async()=>{await service?.close();});
async function owner(page:Page){await page.goto('app/?flags=publicOrders,cloudSetup');await installCustomerLinks(page);const config=service.config();await page.evaluate(v=>window.miseCustomerLinkTest.initialize(v),config);await page.goto('app/settings/shop-link?flags=publicOrders,cloudSetup');const panel=page.getByLabel('Online ordering',{exact:true});await expect(panel.getByRole('button',{name:'Publish ordering link',exact:true})).toBeEnabled();return panel;}
async function form(page:Page,url:string){await page.goto(url);await expect(page.getByRole('heading',{level:1})).toHaveText('Dhanmondi');await expect(page.getByRole('button',{name:'Place order',exact:true})).toBeEnabled();}
async function fields(page:Page){await page.getByRole('button',{name:'Pickup',exact:true}).click();await page.getByLabel('Your name',{exact:true}).fill('Sadia');await page.getByLabel('Your phone number',{exact:true}).fill('+14155550150');await page.getByLabel('What do you need?',{exact:true}).fill('২ কেজি চাল\n1 kg Rice');}
async function original(page:Page){return page.evaluate(()=>{const row=Object.entries(localStorage).find(([key])=>key.startsWith('mise.public-orders.v1.'));if(!row)throw Error('No saved original');return JSON.parse(row[1]).attempts.at(-1);});}
test('owner publication creates a real account-free order and opens its own actual tracker without credentials',async({page,browser})=>{
 const panel=await owner(page);await panel.getByRole('button',{name:'Publish ordering link',exact:true}).click();const url=await panel.getByLabel('Confirmed ordering link').inputValue();expect(url).toContain('/app/o/');expect(url).not.toContain(service.config().publishableKey);expect(url).not.toContain(service.config().jwt);
 const context=await browser.newContext(),customer=await context.newPage();try{
  await form(customer,url);await fields(customer);service.calls.splice(0);await customer.getByRole('button',{name:'Place order',exact:true}).click();await expect(customer).toHaveURL(/\/app\/t\/[A-Za-z0-9_-]{43}/);await expect(customer.getByText('Order A-2042',{exact:true})).toBeVisible();
  await expect(customer.getByText('Subtotal',{exact:true})).toHaveCount(0);expect(await service.orderCounts()).toMatchObject({orders:2,submitted:1,publications:1,sales:0,entries:1});expect(service.calls.every(c=>!c.auth&&!c.apikey)).toBe(true);expect(service.calls.some(c=>c.path==='/functions/v1/public/orders')).toBe(true);
  const privacy=await customer.evaluate(async()=>({db:await indexedDB.databases(),keys:Object.keys(localStorage)}));expect(privacy.db).toEqual([]);expect(privacy.keys.some(k=>k.startsWith('mise.cloud.'))).toBe(false);
 }finally{await context.close();}
});
test('lost publication completion reloads its original capability and never creates a replacement',async({page})=>{
 let panel=await owner(page);service.loseNext('publish_public_shop');await panel.getByRole('button',{name:'Publish ordering link',exact:true}).click();await expect(panel.getByRole('alert')).toBeVisible();
 await page.reload();panel=page.getByLabel('Online ordering',{exact:true});await expect(panel.getByRole('button',{name:'Check original publication',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'Check original publication',exact:true}).click();await expect(panel.getByLabel('Confirmed ordering link')).toBeVisible();expect((await service.orderCounts()).publications).toBe(1);
});
test.describe('browser history recovery',()=>{
 test('history and persisted-page restoration recover a usable original without submitting a second order',async({page})=>{
  const {url}=await service.publishShop();await form(page,url);await fields(page);
  await page.getByRole('button',{name:'Place order',exact:true}).click();await expect(page).toHaveURL(/\/app\/t\//);
  await page.goBack();await expect(page).toHaveURL(url);await expect(page.getByRole('button',{name:'Check original request',exact:true})).toBeEnabled();
  // Headless Chromium may decline BFCache. Exercise its persisted lifecycle too,
  // preserving the actual journal and checking the reloaded form's behavior.
  await page.evaluate(()=>{document.documentElement.dataset.historyLifecycle='stopped';window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await expect(page.locator('html')).not.toHaveAttribute('data-history-lifecycle','stopped');await expect(page.getByRole('button',{name:'Check original request',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Check original request',exact:true}).click();await expect(page).toHaveURL(/\/app\/t\//);
  expect((await service.orderCounts()).submitted).toBe(1);
 });
});
test('lost customer completion reloads the exact original and inspects one real order before opening tracking',async({page})=>{
 const {url}=await service.publishShop();await form(page,url);await fields(page);await expect(page.locator('#public-offline')).toHaveText('Form ready offline');service.loseNext('orders');await page.getByRole('button',{name:'Place order',exact:true}).click();await expect(page.getByLabel('Online order',{exact:true}).getByRole('alert')).toContainText('unconfirmed');const before=await original(page);
 await page.reload();await expect(page.getByRole('button',{name:'Check original request',exact:true})).toBeEnabled();expect((await original(page)).submission).toEqual(before.submission);await page.getByRole('button',{name:'Check original request',exact:true}).click();await expect(page).toHaveURL(/\/app\/t\//);expect((await service.orderCounts()).submitted).toBe(1);
});
test('offline reload retains closure, blocks sending a new request and later records its actual server fence',async({page,context})=>{
 const {url}=await service.publishShop();await form(page,url);await fields(page);await expect(page.locator('#public-offline')).toHaveText('Form ready offline');await context.setOffline(true);await page.getByRole('button',{name:'Place order',exact:true}).click();await expect(page.getByLabel('Online order',{exact:true}).getByRole('alert')).toContainText('unconfirmed');const before=await original(page);
 await page.getByRole('button',{name:'Clear form details',exact:true}).click();await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('');expect((await original(page)).submission).toEqual(before.submission);
 await page.getByRole('button',{name:'Close unfinished request',exact:true}).click();await expect.poll(async()=>(await original(page)).closeRequested).toBe(true);await page.reload();await expect(page.getByRole('button',{name:'Close unfinished request',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Send original request',exact:true})).toBeHidden();expect((await original(page)).submission).toEqual(before.submission);
 await context.setOffline(false);await page.getByRole('button',{name:'Close unfinished request',exact:true}).click();await expect(page.getByLabel('Online order',{exact:true}).getByRole('status')).toContainText('closed before');expect((await service.orderCounts()).submitted).toBe(0);await expect(page.getByRole('button',{name:'Start a new order',exact:true})).toBeEnabled();
});
test('table publication opens the real table tracker and a forged display label cannot create an order',async({page})=>{
 const {url}=await service.publishShop('Table 4'),u=new URL(url),wire=JSON.parse(decodeURIComponent(u.hash.slice(12)));wire.table='Table 9';u.hash='mise-order='+encodeURIComponent(JSON.stringify(wire));await form(page,u.href);await page.getByLabel('Your name',{exact:true}).fill('Sadia');await page.getByLabel('Your phone number',{exact:true}).fill('+14155550150');await page.getByLabel('What do you need?',{exact:true}).fill('1 Rice');await page.getByRole('button',{name:'Place order',exact:true}).click();await expect(page.getByLabel('Online order',{exact:true}).getByRole('alert')).toContainText('review');expect((await service.orderCounts()).submitted).toBe(0);
 await page.goto(url);await expect(page.getByRole('button',{name:'Place order',exact:true})).toBeEnabled();await page.getByLabel('Your name',{exact:true}).fill('Sadia');await page.getByLabel('Your phone number',{exact:true}).fill('+14155550150');await page.getByLabel('What do you need?',{exact:true}).fill('1 Rice');await page.getByRole('button',{name:'Place order',exact:true}).click();await expect(page).toHaveURL(/\/app\/t\//);await expect(page.getByText('Table 4',{exact:false})).toBeVisible();expect((await service.orderCounts()).submitted).toBe(1);
});
for(const width of [360,390,768,1024,1440])test(`online owner controls and anonymous form fit ${width}px and meet AA checks`,async({page})=>{
 await page.setViewportSize({width,height:1000});const panel=await owner(page);await expect(panel).toBeVisible();let result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(result.violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 const {url}=await service.publishShop();await form(page,url);result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(result.violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('the complete new ordering offline bundle stays below 75,000 encoded bytes and excludes owner Auth/database code',async({baseURL})=>{
 const base=normalizeBase(process.env.BASE_PATH)+'app/',manifest=JSON.parse(readFileSync('site/app/o/resources.json','utf8')) as {resources:string[]};let total=0;
 for(const resource of manifest.resources){const url=new URL(resource,baseURL),bytes=await new Promise<number>((resolve,reject)=>{get(url,{headers:{'Accept-Encoding':'gzip'}},response=>{if(response.statusCode!==200){response.resume();reject(Error('Missing ordering resource'));return;}let n=0;response.on('data',chunk=>n+=chunk.length);response.on('end',()=>resolve(n));response.on('error',reject);}).on('error',reject);});total+=bytes;}
 expect(total).toBeLessThan(75000);expect(manifest.resources.every(url=>url.startsWith(base+'o/')||url===base+'mise-mark.svg')).toBe(true);
 for(const resource of manifest.resources.filter(r=>r.endsWith('.js'))){const code=readFileSync('site/'+resource.slice(normalizeBase(process.env.BASE_PATH).length),'utf8');expect(code).not.toContain('supabase.auth');expect(code).not.toContain('mise-local:');expect(code).not.toContain('sb_publishable_');}
});
