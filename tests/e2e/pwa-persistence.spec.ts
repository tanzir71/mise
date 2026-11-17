import {test,expect,chromium,type BrowserContext} from '@playwright/test';
import {normalizeBase} from '../../packages/core/paths';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {flags,setup,device,controlled,cash} from './helpers/pwa';
async function closePersistent(context:BrowserContext){
  const browser=context.browser();
  if(browser?.isConnected()){
    // Release the offline emulation and pages before Chromium flushes the profile.
    // Every offline/persistence assertion runs before this teardown begins.
    await context.setOffline(false);
    await Promise.all(context.pages().map(page=>page.close()));
  }
  await context.close();
  if(browser)expect(browser.isConnected()).toBe(false);
}

// Recording two manually relaunched contexts can stall Windows profile shutdown
// and produce a truncated trace ZIP. CDP lifecycle evidence remains attached.
test.use({trace:'off'});
test('the real manifest is installable and a closed browser reopens its saved shop offline',async({baseURL},info)=>{
  test.setTimeout(60000);
  // Chromium's nested disk-cache paths can exceed Windows MAX_PATH beneath a
  // long test-output/repeat name. Keep this real persistent profile short.
  const profileRoot=await realpath(tmpdir()),profile=await mkdtemp(join(profileRoot,'mise-pwa-'));
  const options={baseURL,headless:true,channel:'chromium',args:['--bypass-app-banner-engagement-checks'],viewport:{width:390,height:844}};
  const workerLog:unknown[]=[];
  let context:BrowserContext|undefined;
  try{
    context=await chromium.launchPersistentContext(profile,options);
    await flags(context);let page=await context.newPage();const cdp=await context.newCDPSession(page);
    cdp.on('ServiceWorker.workerErrorReported',event=>workerLog.push({error:event}));cdp.on('ServiceWorker.workerVersionUpdated',event=>workerLog.push({versions:event.versions}));await cdp.send('ServiceWorker.enable');
    await setup(page);await controlled(page);
    const manifest=await cdp.send('Page.getAppManifest'),data=JSON.parse(manifest.data!);expect(manifest.errors).toEqual([]);expect(data).toMatchObject({name:'Mise',display:'standalone',theme_color:'#141414',start_url:`${normalizeBase(process.env.BASE_PATH)}app/`,scope:`${normalizeBase(process.env.BASE_PATH)}app/`,id:`${normalizeBase(process.env.BASE_PATH)}app/`});
    expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    for(const icon of data.icons as {src:string;sizes:string}[]){const size=Number(icon.sizes.split('x')[0]),image=await page.evaluate(async({src,url})=>{const image=new Image();image.src=new URL(src,url).href;await image.decode();return {width:image.naturalWidth,height:image.naturalHeight};},{src:icon.src,url:manifest.url});expect(image).toEqual({width:size,height:size});}
    const manifestResponse=await page.request.get(manifest.url);expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');await cdp.detach();
    await cash(page,'100');await device(page);await expect(page.locator('.pwa-offline')).toContainText('Ready offline');await closePersistent(context);
    context=await chromium.launchPersistentContext(profile,options);await context.setOffline(true);page=await context.newPage();await page.goto('app/');await expect(page.locator('[data-metric=sales] strong')).toHaveText('৳100');await cash(page,'25');await page.goto('app/');await expect(page.locator('[data-metric=sales] strong')).toHaveText('৳125');await device(page);await expect(page.locator('.pwa-offline')).toContainText('Ready offline');
  }finally{
    await info.attach('service-worker-lifecycle',{body:JSON.stringify(workerLog),contentType:'application/json'});
    if(context)await closePersistent(context);
    const target=await realpath(profile);if(dirname(target)!==profileRoot||!basename(target).startsWith('mise-pwa-'))throw new Error('Invalid test profile cleanup path.');
    await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});
