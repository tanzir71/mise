import {expect,it,vi} from 'vitest';
import {requestWorkerControl} from '../apps/web/src/pwa-control';
import {claimOwnerClient} from '../apps/web/src/pwa-control-worker';
class Worker extends EventTarget {state:ServiceWorkerState='activated';postMessage=vi.fn();}
const registration=(active:Worker|null,installing:Worker|null=null,waiting:Worker|null=null)=>({active,installing,waiting}) as unknown as ServiceWorkerRegistration;
it('an already controlled document sends no worker takeover message',()=>{const worker=new Worker();requestWorkerControl(registration(worker),{controller:worker as unknown as ServiceWorker});expect(worker.postMessage).not.toHaveBeenCalled();});
it('an activated worker claims an uncontrolled document without activating a waiting update',()=>{const active=new Worker(),waiting=new Worker();waiting.state='installed';requestWorkerControl(registration(active,null,waiting),{controller:null});expect(active.postMessage).toHaveBeenCalledExactlyOnceWith({type:'MISE_CLAIM_CLIENT'});expect(waiting.postMessage).not.toHaveBeenCalled();});
it('first installation waits for activation, then requests control once and removes its listener',()=>{const worker=new Worker();worker.state='installing';requestWorkerControl(registration(null,worker),{controller:null});worker.state='installed';worker.dispatchEvent(new Event('statechange'));expect(worker.postMessage).not.toHaveBeenCalled();worker.state='activated';worker.dispatchEvent(new Event('statechange'));worker.dispatchEvent(new Event('statechange'));expect(worker.postMessage).toHaveBeenCalledTimes(1);});
it('a redundant or missing worker keeps the existing offline fallback',()=>{const worker=new Worker();worker.state='installing';requestWorkerControl(registration(null,worker),{controller:null});worker.state='redundant';worker.dispatchEvent(new Event('statechange'));worker.state='activated';worker.dispatchEvent(new Event('statechange'));requestWorkerControl(registration(null),{controller:null});expect(worker.postMessage).not.toHaveBeenCalled();});
it('a stopped worker cannot replace an open form or cause an unhandled failure',()=>{const worker=new Worker();worker.postMessage.mockImplementation(()=>{throw new Error('Stopped');});expect(()=>requestWorkerControl(registration(worker),{controller:null})).not.toThrow();});
it.each([
 undefined,
 {type:'worker',frameType:'none',url:'https://owner.test/mise/app/'},
 {type:'window',frameType:'nested',url:'https://owner.test/mise/app/'},
 {type:'window',frameType:'top-level',url:'https://foreign.test/mise/app/'},
 {type:'window',frameType:'top-level',url:'https://owner.test/mise/bd/'},
 {type:'window',frameType:'top-level',url:'https://owner.test/mise/app/s'},
 {type:'window',frameType:'top-level',url:'https://owner.test/mise/app/s/shop'},
])('claim request %# cannot take over another surface',async client=>{const claim=vi.fn(),get=vi.fn(async()=>client as unknown as Client);await claimOwnerClient({get,claim},'actual-client','https://owner.test','/mise/app/');expect(claim).not.toHaveBeenCalled();});
it('a real top-level owner URL may request the active registration without a reload',async()=>{const claim=vi.fn(),get=vi.fn(async()=>({type:'window',frameType:'top-level',url:'https://owner.test/mise/app/counter?draft=kept'}) as unknown as Client);await claimOwnerClient({get,claim},'actual-client','https://owner.test','/mise/app/');expect(get).toHaveBeenCalledWith('actual-client');expect(claim).toHaveBeenCalledTimes(1);});
