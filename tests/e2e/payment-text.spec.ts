import {expect,test} from '@playwright/test';
import fixtures from '../../packages/core/fixtures/payments/messages.json';
import {setupCommand} from '../../packages/core/setup';
import {saveOrderCommand} from '../../packages/core/orders';
// @ts-expect-error The isolated browser bundler is JavaScript, not production code.
import {paymentTextBrowserModule} from '../fixtures/payment-text-browser.mjs';

test('actual browser parses all thirty unchanged source fixtures without any provider request',async({page,baseURL})=>{
 const url=new URL('app/payment-text-verification.mjs',baseURL!).href,body=await paymentTextBrowserModule(),requests:string[]=[];
 await page.route(url,route=>route.fulfill({contentType:'text/javascript',body}));page.on('request',request=>requests.push(request.url()));
 await page.goto('app/');const results=await page.evaluate(async({url,fixtures})=>{const module=await import(url);return fixtures.map(fixture=>module.parsePaymentText(fixture.text,fixture.context));},{url,fixtures:fixtures.fixtures});
 expect(results).toHaveLength(30);for(let n=0;n<30;n++){expect(results[n],fixtures.fixtures[n].id).toMatchObject(fixtures.fixtures[n].expected);expect(results[n].raw).toBe(fixtures.fixtures[n].text);}
 const unknown=await page.evaluate(async({url,context})=>(await import(url)).parsePaymentText('Unknown transfer notice: Tk 15.25. Balance Tk 1,000. Fee Tk 2.',context),{url,context:fixtures.fixtures[0].context});expect(unknown).toMatchObject({status:'manual',amount:1525});expect(unknown.warnings.some((warning:string)=>warning.startsWith('More than one transfer'))).toBe(false);
 expect(requests.every(request=>new URL(request).origin===new URL(baseURL!).origin)).toBe(true);await test.info().attach('actual-browser-payment-fixtures.json',{body:Buffer.from(JSON.stringify(results)),contentType:'application/json'});
});
test('browser matching is read-only and does not settle a unique open order or select an ambiguous clock',async({page,baseURL})=>{
 const url=new URL('app/payment-text-verification.mjs',baseURL!).href,body=await paymentTextBrowserModule(),fixture=fixtures.fixtures[0],at=fixture.expected.receivedAt;
 const seed=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Browser payment verification',phone:'01712345482'},null,at),order=saveOrderCommand({source:'phone',sourceText:'',name:'Customer',phone:'01712345482',type:'pickup',address:'',table:'',lines:[{name:'Item',unit:'pc',qty:1,unitPrice:150000}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup:seed.snapshot,items:seed.items,sequence:1},null,0,at-60000).order,records={setup:seed.snapshot,orders:[order],sales:[],entries:[],accounts:[],customers:[],refunds:[]};
 await page.route(url,route=>route.fulfill({contentType:'text/javascript',body}));await page.goto('app/');
 const result=await page.evaluate(async({url,fixture,records})=>{const module=await import(url),before=JSON.stringify(records),source=module.parsePaymentText(fixture.text,fixture.context),match=module.findPaymentTextMatches(source,records),ambiguous=module.parsePaymentText('You have received Tk 10 at 01/11/2026 01:30',{...fixture.context,timeZone:'America/New_York',dateOrder:'DMY'});return {match,ambiguous,before,after:JSON.stringify(records)};},{url,fixture,records});
 expect(result.match).toMatchObject({selection:'automatic',eligibleCount:1,candidates:[{kind:'order',id:order.id,state:'open',amount:150000}]});expect(result.before).toBe(result.after);expect(result.ambiguous).toMatchObject({status:'manual',timeSource:'capture'});
});
