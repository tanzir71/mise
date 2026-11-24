import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
vi.mock('../apps/web/src/ocr/assets',async importOriginal=>({...await importOriginal<typeof import('../apps/web/src/ocr/assets')>(),prepareOcrDownload:vi.fn(async()=>{})}));
vi.mock('../apps/web/src/ocr/raster',()=>({prepareOcrRaster:async(image:Blob)=>({bytes:new Uint8Array(await image.arrayBuffer()),scale:1})}));
import {readImageOnDevice} from '../apps/web/src/ocr/worker';
import {prepareOcrDownload} from '../apps/web/src/ocr/assets';

type Message={workerId:string;jobId:string;action:string;payload:Record<string,unknown>};
class ReaderWorker {
 static instances:ReaderWorker[]=[];static hold=false;
 onmessage:((event:{data:unknown})=>void)|null=null;onerror:(()=>void)|null=null;onmessageerror:(()=>void)|null=null;terminated=false;messages:Message[]=[];
 constructor(readonly url:URL){ReaderWorker.instances.push(this);}
 postMessage(message:Message){this.messages.push(message);if(ReaderWorker.hold)return;queueMicrotask(()=>this.onmessage?.({data:{...message,status:'resolve',data:message.action==='recognize'?{text:'Original literal text\n',confidence:91,blocks:null}:{}}}));}
 terminate(){this.terminated=true;}
}
function environment(){ReaderWorker.instances=[];ReaderWorker.hold=false;vi.stubGlobal('Worker',ReaderWorker);vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('isSecureContext',true);vi.stubGlobal('caches',{});vi.stubGlobal('navigator',{serviceWorker:{controller:{}}});vi.stubGlobal('location',{origin:'https://example.test'});}
function image(){return new Blob([readFileSync('tests/fixtures/ocr/invoice-01.png')],{type:'image/png'});}
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('sends only checked original bytes to its own pinned worker and always terminates it',async()=>{
 environment();const result=await readImageOnDevice(image(),{signal:new AbortController().signal}),worker=ReaderWorker.instances[0];
 expect(worker.url.origin).toBe('https://example.test');expect(worker.url.pathname).toContain('/ocr/tesseract-7.0.0-eng-ben-1.0.0-v1/worker.min.js');expect(worker.messages.map(m=>m.action)).toEqual(['load','loadLanguage','initialize','setParameters','recognize']);expect(worker.messages[1].payload).toMatchObject({langs:'eng+ben',options:{cacheMethod:'none',gzip:true}});expect(worker.messages[4].payload.image).toEqual(new Uint8Array(await image().arrayBuffer()));expect(result.text).toBe('Original literal text\n');expect(worker.terminated).toBe(true);
});
it('immediately terminates an initializing worker on cancel and frees the next read',async()=>{
 environment();ReaderWorker.hold=true;const controller=new AbortController(),pending=readImageOnDevice(image(),{signal:controller.signal}),rejection=expect(pending).rejects.toMatchObject({name:'AbortError'});
 await vi.waitFor(()=>expect(ReaderWorker.instances).toHaveLength(1));expect(ReaderWorker.instances[0].messages[0].action).toBe('load');
 await expect(readImageOnDevice(image(),{signal:new AbortController().signal})).rejects.toThrow('Another image');controller.abort();await rejection;expect(ReaderWorker.instances[0].terminated).toBe(true);
 ReaderWorker.hold=false;await expect(readImageOnDevice(image(),{signal:new AbortController().signal})).resolves.toMatchObject({text:'Original literal text\n'});
});
it('ignores a reply for another job and stops on a real worker error',async()=>{
 environment();ReaderWorker.hold=true;const pending=readImageOnDevice(image(),{signal:new AbortController().signal}),rejection=expect(pending).rejects.toThrow('reader stopped');await vi.waitFor(()=>expect(ReaderWorker.instances).toHaveLength(1));const worker=ReaderWorker.instances[0];worker.onmessage?.({data:{...worker.messages[0],jobId:'another',status:'resolve',data:{}}});expect(worker.messages).toHaveLength(1);worker.onerror?.();await rejection;expect(worker.terminated).toBe(true);
});
it('rejects unsafe dimensions and oversized blobs before downloading or allocating a worker',async()=>{
 environment();const bytes=Buffer.from(readFileSync('tests/fixtures/ocr/invoice-01.png'));bytes.writeUInt32BE(100000,16);
 await expect(readImageOnDevice(new Blob([bytes],{type:'image/png'}),{signal:new AbortController().signal})).rejects.toThrow('16 megapixels');
 const huge={size:5*1024*1024+1,arrayBuffer:vi.fn()} as unknown as Blob;await expect(readImageOnDevice(huge,{signal:new AbortController().signal})).rejects.toThrow('5 MB');expect(huge.arrayBuffer).not.toHaveBeenCalled();expect(ReaderWorker.instances).toHaveLength(0);expect(prepareOcrDownload).not.toHaveBeenCalled();
});
