import {afterEach,expect,it,vi} from 'vitest';
import {prepareOcrRaster} from '../apps/web/src/ocr/raster';
afterEach(()=>vi.unstubAllGlobals());
function environment(width=1000,height=600){
 const bitmap={width,height,close:vi.fn()},context={fillStyle:'',fillRect:vi.fn(),drawImage:vi.fn(),imageSmoothingEnabled:false,imageSmoothingQuality:''};
 const canvases:{width:number;height:number}[]=[];
 class Canvas {constructor(public width:number,public height:number){canvases.push(this);}getContext(){return context;}async convertToBlob(){return new Blob(['prepared pixels'],{type:'image/png'});}}
 const decode=vi.fn(async()=>bitmap);vi.stubGlobal('createImageBitmap',decode);vi.stubGlobal('OffscreenCanvas',Canvas);return {bitmap,context,canvases,decode};
}
it('prepares a separate readable raster, releases decoded pixels and leaves the original intact',async()=>{
 const {bitmap,context,canvases}=environment(),original=new Blob(['immutable original'],{type:'image/png'}),result=await prepareOcrRaster(original,new AbortController().signal);
 expect(result.scale).toBe(2);expect(new TextDecoder().decode(result.bytes)).toBe('prepared pixels');expect(await original.text()).toBe('immutable original');expect(context.fillStyle).toBe('white');expect(context.drawImage).toHaveBeenCalledWith(bitmap,0,0,2000,1200);expect(bitmap.close).toHaveBeenCalledOnce();expect(canvases).toEqual([{width:1,height:1}]);
});
it('does not enlarge an already large image and closes pixels on cancellation or oversized decode',async()=>{
 const {bitmap}=environment(3000,2000);expect((await prepareOcrRaster(new Blob(['x']),new AbortController().signal)).scale).toBe(1);expect(bitmap.close).toHaveBeenCalledOnce();
 const controller=new AbortController(),next=environment();next.decode.mockImplementation(async()=>{controller.abort();return next.bitmap;});await expect(prepareOcrRaster(new Blob(['x']),controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(next.bitmap.close).toHaveBeenCalledOnce();expect(next.canvases).toEqual([]);
 const large=environment(5000,4000);await expect(prepareOcrRaster(new Blob(['x']),new AbortController().signal)).rejects.toThrow('16 megapixels');expect(large.bitmap.close).toHaveBeenCalledOnce();expect(large.canvases).toEqual([]);
});
