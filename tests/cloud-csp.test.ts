import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
// @ts-expect-error The build hardening entry is a standalone Node script.
import {hardenSite} from '../scripts/harden.mjs';
it('limits runtime cloud connections to owner pages and preserves public page isolation',()=>{
 const prefix=join(tmpdir(),'mise-cloud-csp-'),directory=mkdtempSync(prefix);
 try{for(const path of ['app','app/s','bd'])mkdirSync(join(directory,path),{recursive:true});for(const path of ['app/index.html','app/s/index.html','bd/index.html','404.html'])writeFileSync(join(directory,path),'<html><head></head><body></body></html>');hardenSite(directory);
  for(const path of ['app/index.html','404.html']){const html=readFileSync(join(directory,path),'utf8');expect(html).toContain("connect-src 'self' https: http://localhost:* http://127.0.0.1:*");expect(html).toContain("object-src 'none'");expect(html).toContain("form-action 'self'");}
  for(const path of ['app/s/index.html','bd/index.html']){const html=readFileSync(join(directory,path),'utf8');expect(html).not.toContain("connect-src 'self' https:");expect(html).not.toContain('http://localhost:');expect(html).not.toContain(' blob:');}
 }finally{if(!resolve(directory).startsWith(resolve(prefix)))throw new Error('Invalid CSP fixture cleanup path.');rmSync(directory,{recursive:true,force:true});}
});
