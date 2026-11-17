import { inboxLimits, assertInboxId } from '@mise/core/inbox';
import { prepareInboxContent, type SharedInboxInput } from './inbox';

export const maxShareBodyBytes=inboxLimits.totalBytes+128*1024;
class ShareInputError extends Error { constructor(message:string,readonly status=400){super(message);} }
/** Bound the transport before multipart parsing allocates files. */
export async function sharedRequestInput(request:Request):Promise<SharedInboxInput> {
  const type=request.headers.get('content-type')??'';
  if(request.method!=='POST'||!/^multipart\/form-data\s*;/i.test(type))throw new ShareInputError('Share text or JPEG, PNG and WebP images using the share sheet.');
  const length=request.headers.get('content-length');if(length&&Number(length)>maxShareBodyBytes)throw new ShareInputError('Share up to 10 MB of images at a time.',413);
  const reader=request.body?.getReader();if(!reader)throw new ShareInputError('This share is empty.');
  const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
  try {while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>maxShareBodyBytes){await reader.cancel();throw new ShareInputError('Share up to 10 MB of images at a time.',413);}chunks.push(result.value as Uint8Array<ArrayBuffer>);}}finally{reader.releaseLock();}
  let form:FormData;try{form=await new Response(new Blob(chunks),{headers:{'content-type':type}}).formData();}catch{throw new ShareInputError('This share could not be read. Return to the source app and share it again.');}
  for(const key of form.keys())if(!['title','text','url','images'].includes(key))throw new ShareInputError('This share has unsupported fields.');
  const field=(name:string)=>{const values=form.getAll(name);if(values.length>1||values.some(value=>typeof value!=='string'))throw new ShareInputError('The shared text fields could not be read.');return values[0] as string|undefined;};
  const files=form.getAll('images').filter(value=>value!=='');if(files.some(value=>typeof value==='string'))throw new ShareInputError('Choose image files to share.');
  return {title:field('title'),text:field('text'),url:field('url'),files:(files as File[]).filter(file=>file.name!==''||file.size!==0)};
}
const escape=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Persist first, then redirect. A failed write never reports a saved Inbox item. */
export async function receiveSharedRequest(request:Request,base:string,save:(input:SharedInboxInput)=>Promise<{id:string}>):Promise<Response> {
  let input:SharedInboxInput;
  try{input=await sharedRequestInput(request);}catch(error){return failure(error instanceof ShareInputError?error.message:'This share could not be read. Try sharing it again.',error instanceof ShareInputError?error.status:400);}
  try{await prepareInboxContent(input);}catch(error){return failure(error instanceof Error?error.message:'Check the shared text and image limits.',400);}
  try{
    const item=await save(input);assertInboxId(item.id);
    return Response.redirect(new URL(`${base}inbox/${item.id}?flags=shareTarget`,request.url),303);
  }catch{return failure('Mise could not save this share. Return to the source app and try again, or add the details by hand.',503);}
  function failure(message:string,status:number):Response {
    const fallback=new URL(`${base}inbox/new?flags=shareTarget`,request.url).href;
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Share to Mise</title><h1>This share was not saved</h1><p>${escape(message)}</p><p><a href="${escape(fallback)}">Add by hand</a></p><p>The original text and images are still in the app you shared from.</p></html>`,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}});
  }
}
