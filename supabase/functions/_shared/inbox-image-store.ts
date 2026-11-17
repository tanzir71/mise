import {ImageAccessDenied,readImageBody,type ImageContext,type InboxImageStore} from './inbox-image-handler.ts';
export function createInboxImageStore(apiUrl:string,publishableKey:string,serviceKey:string,send:typeof fetch=fetch):InboxImageStore{
  const root=new URL(apiUrl),part='[0-7][0-9A-HJKMNP-TV-Z]{25}',pathPattern=new RegExp(`^${part}/${part}/${part}/${part}$`);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw new Error('Images are not configured.');
  async function rpc(jwt:string,name:string,args:Record<string,unknown>){
    const r=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{apikey:publishableKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify(args)});
    if(r.status===401||r.status===403)throw new ImageAccessDenied(r.status);if(!r.ok)throw new Error('Image settings unavailable');return r.json();
  }
  function objectUrl(meta:ImageContext,read=false){if(!pathPattern.test(meta.path))throw new Error('Invalid image path');return new URL(`storage/v1/object/${read?'authenticated/':''}mise-inbox/${meta.path}`,root);}
  return {context:(jwt,id)=>rpc(jwt,'inbox_image_context',{p_image_id:id}),complete:(jwt,id,event)=>rpc(jwt,'complete_inbox_image',{p_image_id:id,p_event_id:event}),
    put:async(meta,bytes)=>{const r=await send(objectUrl(meta),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:serviceKey,'Content-Type':meta.type,'cache-control':'max-age=0','x-upsert':'false','x-metadata':btoa(JSON.stringify({sha256:meta.sha256}))},body:new Uint8Array(bytes).buffer});return r.ok;},
    get:async meta=>{const r=await send(objectUrl(meta,true),{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:serviceKey}});if(!r.ok)throw new Error('Image unavailable');return readImageBody(r.body,meta.size,r.headers.get('content-length'),10000);}};
}
