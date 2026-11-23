import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createStaffLinkDatabase} from './staff-link-fixture';
import {createStaffLinkHandler} from '../supabase/functions/_shared/staff-link-handler';
import {createStaffPublicSession} from '../apps/web/src/data/staff-public-session';
let f:Awaited<ReturnType<typeof createStaffLinkDatabase>>;
beforeAll(async()=>{f=await createStaffLinkDatabase();},30000);beforeEach(async()=>{await f.seed();await f.issue();});afterAll(async()=>{await f?.db.close();});
function boot(){
 let held=false,offline=false,lost=false,quota=false;const values=new Map<string,string>(),calls:{operation:string;auth:boolean;key:boolean}[]=[];
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(quota)throw Error('quota');values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 const locks={request:async(_key:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'staff',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
 const handler=createStaffLinkHandler({store:{visit:(input,limits)=>f.visit(input,limits)},origins:new Set(['https://shop.example.invalid'])});
 const send:typeof fetch=async(input,init)=>{if(offline)throw Error('offline');const request=new Request(input,init),body=await request.clone().json();calls.push({operation:body.operation,auth:request.headers.has('Authorization'),key:request.headers.has('apikey')});
  const response=await handler(request);if(lost&&body.operation!=='read'){lost=false;throw Error('lost completion');}return response;
 };
 const session=()=>createStaffPublicSession({v:1,apiUrl:'https://backend.example.invalid',token:f.token},{storage,locks,send});
 return {values,calls,session,set held(v:boolean){held=v;},set offline(v:boolean){offline=v;},set lost(v:boolean){lost=v;},set quota(v:boolean){quota=v;}};
}
it('saves the complete original before HTTP and recovers one real check-in after a lost reply',async()=>{
 const b=boot(),s=await b.session(),view=await s.read(),i=await s.prepare(view,'in');expect(b.calls.map(c=>c.operation)).toEqual(['read']);expect(s.saved().actions[0].intent).toEqual(i);
 b.lost=true;await expect(s.call(i.id,'submit')).rejects.toMatchObject({kind:'unavailable'});expect(s.saved().actions[0].outcome).toBe(null);const reload=await b.session();expect((await reload.call(i.id,'inspect')).state).toBe('applied');expect(reload.saved().actions[0].intent).toEqual(i);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.check_ins')).rows[0].n).toBe(1);expect(b.calls.every(c=>!c.auth&&!c.key)).toBe(true);
});
it('persists offline closure before HTTP and later fences a delayed submit without claiming an attendance record',async()=>{
 const b=boot(),s=await b.session(),view=await s.read(),i=await s.prepare(view,'in');b.offline=true;await expect(s.call(i.id,'close')).rejects.toThrow();expect(s.saved().actions[0].closeRequested).toBe(true);
 b.offline=false;const reload=await b.session();expect((await reload.call(i.id,'submit')).state).toBe('closed');expect((await reload.read()).latest).toBe(null);
});
it('retains a readable manual view while quota prevents any new original from being sent',async()=>{
 const b=boot();b.quota=true;const s=await b.session(),view=await s.read();expect(view.name).toBe('Karim Uddin');expect(s.storageReady).toBe(false);await expect(s.prepare(view,'in')).rejects.toThrow();expect(b.calls.map(c=>c.operation)).toEqual(['read']);expect(b.values.size).toBe(0);
});
it('lets only one native tab hold the original and never replaces an unfinished tap',async()=>{
 const b=boot(),s=await b.session(),view=await s.read();b.held=true;await expect(s.prepare(view,'in')).rejects.toThrow();b.held=false;const i=await s.prepare(view,'in'),other=await b.session();await expect(other.prepare(view,'in')).rejects.toThrow();expect(other.saved().actions[0].intent).toEqual(i);expect(b.calls.map(c=>c.operation)).toEqual(['read']);
});
it('keeps its own saved action after revocation but offers no fresh records or another person’s context',async()=>{
 const b=boot(),s=await b.session(),view=await s.read(),i=await s.prepare(view,'in');await s.call(i.id,'submit');await f.db.exec('update private.staff_links set revoked_at=created_at');await expect(s.read()).rejects.toMatchObject({kind:'missing'});expect(s.saved().actions[0].intent).toEqual(i);expect((await s.call(i.id,'inspect')).state).toBe('applied');
 s.stop();await expect(s.read()).rejects.toThrow();
});
it('retains a stale original for explicit closure when a newer departure already exists',async()=>{
 const b=boot(),s=await b.session(),view=await s.read(),stale=await s.prepare(view,'in');const other=await b.session();
 const first={...stale,id:'0'+stale.id.slice(1,-1)+(stale.id.endsWith('Z')?'Y':'Z'),eventId:'00000000000000000000009999'};
 expect((await f.visit({token:f.token,operation:'submit',intent:first,after:null})).state).toBe('applied');
 const departure={...first,id:'00000000000000000000009998',eventId:'00000000000000000000009997',type:'out' as const,expectedLastId:first.id,occurredAt:first.occurredAt+1};
 expect((await f.visit({token:f.token,operation:'submit',intent:departure,after:null})).state).toBe('applied');
 await expect(s.call(stale.id,'submit')).rejects.toMatchObject({kind:'changed'});expect(other.saved().actions[0].intent).toEqual(stale);expect((await s.call(stale.id,'close')).state).toBe('closed');
});
