// Common limits for credential endpoints. No credential values are logged here.
export class AuthBodyError extends Error {constructor(readonly status:400|408|413){super('Invalid authentication request.');}}
export async function readAuthBody(request:Request,maxBytes=2048,deadlineMs=5000):Promise<unknown>{
  if(Number(request.headers.get('content-length')||0)>maxBytes)throw new AuthBodyError(413);
  const reader=request.body?.getReader();if(!reader)throw new AuthBodyError(400);
  const chunks:Uint8Array[]=[];let length=0,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AuthBodyError(408)),deadlineMs);});
  try{
    while(true){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>maxBytes)throw new AuthBodyError(413);chunks.push(part.value);}
  }catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{clearTimeout(timer);reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function authHttp(request:Request,origins:ReadonlySet<string>){
  const origin=request.headers.get('origin'),headers=new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','Vary':'Origin'});
  if(origin&&origins.has(origin))headers.set('Access-Control-Allow-Origin',origin);
  const reply=(status:number,value:unknown,extra:Record<string,string>={})=>{const result=new Headers(headers);for(const [k,v] of Object.entries(extra))result.set(k,v);return new Response(JSON.stringify(value),{status,headers:result});};
  let blocked:Response|undefined;
  if(origin&&!origins.has(origin))blocked=reply(403,{error:'This origin is not allowed.'});
  else if(request.method==='OPTIONS')blocked=new Response(null,{status:204,headers:new Headers([...headers,['Access-Control-Allow-Methods','POST, OPTIONS'],['Access-Control-Allow-Headers','authorization, content-type, apikey']])});
  else if(request.method!=='POST')blocked=reply(405,{error:'Use POST.'},{Allow:'POST, OPTIONS'});
  return {reply,blocked};
}
