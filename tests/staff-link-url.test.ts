import {expect,it} from 'vitest';
import {decodeStaffViewer,staffViewerUrl,parseStaffPublicRequest} from '../packages/core/staff-links';
const token='J'.repeat(43);
it.each(['/app/','/mise/app/'])('keeps the staff link portable at %s with no owner credential or tenant selector',base=>{
 const url=new URL(staffViewerUrl('https://shop.example.invalid',base,{v:1,apiUrl:'https://backend.example.invalid',token}));
 expect(url.pathname).toBe(base+'me/'+token);expect(url.searchParams.get('flags')).toBe('staffTeam');expect(decodeStaffViewer(url.pathname,url.hash,base)).toEqual({v:1,apiUrl:'https://backend.example.invalid',token});
 expect(url.href).not.toContain('apikey');expect(url.href).not.toContain('memberId');
});
it('rejects partial links, credential URLs, extra fields and arbitrary operation/identity selectors',()=>{
 const url=new URL(staffViewerUrl('https://shop.example.invalid','/app/',{v:1,apiUrl:'https://backend.example.invalid',token}));
 for(const hash of ['',url.hash+'garbage','#mise-staff='+encodeURIComponent(JSON.stringify({v:1,apiUrl:'https://backend.example.invalid',role:'owner'}))])expect(()=>decodeStaffViewer(url.pathname,hash,'/app/')).toThrow();
 expect(()=>staffViewerUrl('https://user:secret@shop.example.invalid','/app/',{v:1,apiUrl:'https://backend.example.invalid',token})).toThrow();
 for(const value of [{token,operation:'read',intent:null,after:null,memberId:'other'},{token,operation:'revoke',intent:null,after:null},{token,operation:'read',intent:null,after:{at:0,id:'bad'}}])expect(()=>parseStaffPublicRequest(value)).toThrow();
});
