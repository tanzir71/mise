import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { normalizeBase } from '../../packages/core/paths';

test('an explicit first-session update reloads this tab and preserves another tab’s draft',async ({page,context}) => {
  const root=resolve('site'), base=normalizeBase(process.env.BASE_PATH), mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'};
  let updated=false;
  // Serve the real app build; changing only the worker bytes creates a genuine update.
  const server=createServer((request,response)=>{
    try {
      const pathname=decodeURIComponent(new URL(request.url!,'http://localhost').pathname);
      if (!pathname.startsWith(base)) { response.writeHead(404).end(); return; }
      let file=resolve(root,pathname.slice(base.length));
      if (file!==root && !file.startsWith(root+sep)) { response.writeHead(403).end(); return; }
      try { if (statSync(file).isDirectory()) file=resolve(file,'index.html'); }
      catch { if (pathname.startsWith(`${base}app/`) && !extname(pathname)) file=resolve(root,'app/index.html'); }
      let body=readFileSync(file);
      if (updated && pathname===`${base}app/sw.js`) body=Buffer.concat([body,Buffer.from('\n// Updated worker for the browser regression test.\n')]);
      response.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-cache','Connection':'close'}).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); if (!address || typeof address==='string') throw new Error('Update fixture did not start.');
  const origin=`http://127.0.0.1:${address.port}${base}app/`, errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.setViewportSize({width:390,height:900}); await page.goto(origin);
    await page.getByRole('radio',{name:/^Corner shop/}).check(); await page.getByRole('button',{name:'Continue',exact:true}).click();
    await page.getByRole('radio',{name:/^Bangladesh/}).check(); await page.getByRole('button',{name:'Continue',exact:true}).click();
    await page.getByLabel('Shop name',{exact:true}).fill('Update test'); await page.getByLabel('Phone number',{exact:true}).fill('01712345482'); await page.getByRole('button',{name:'Open Mise',exact:true}).click();
    await page.locator('.app-bottom-nav').getByRole('link',{name:'Counter',exact:true}).click();
    await page.getByLabel('Calculation',{exact:true}).fill('25'); await page.locator('.counter-cash').click(); await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue('');
    await page.evaluate(async()=>{await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));});
    const other=await context.newPage(); await other.setViewportSize({width:390,height:900}); await other.goto(`${origin}counter`); await other.getByLabel('Calculation',{exact:true}).fill('99');
    let reloads=0; other.on('framenavigated',frame=>{if(frame===other.mainFrame()) reloads++;});
    updated=true; await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready; await registration.update();});
    await expect(page.getByRole('button',{name:'Reload',exact:true})).toBeVisible(); await expect(page.getByLabel('Calculation',{exact:true})).toHaveValue(''); await expect(other.getByLabel('Calculation',{exact:true})).toHaveValue('99');
    const otherController=other.evaluate(()=>new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true})));
    await Promise.all([page.waitForEvent('load'),otherController,page.getByRole('button',{name:'Reload',exact:true}).click()]);
    await expect(page.locator('.counter-log>summary')).toHaveText('Sales log · 1 sale'); await expect(other.getByLabel('Calculation',{exact:true})).toHaveValue('99'); expect(reloads).toBe(0); expect(errors).toEqual([]);
    await context.setOffline(true); await page.reload(); await expect(page.locator('.counter-log>summary')).toHaveText('Sales log · 1 sale');
  } finally { server.closeAllConnections(); server.close(); }
});
