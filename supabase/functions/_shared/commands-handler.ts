import {parseCloudCommand,parseCloudCommandReceipt,type CloudCommand} from '../../../packages/core/cloud-commands.ts';
import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {catalogueFingerprint,catalogueWriteFields} from './catalogue-write.ts';
import {deviceAuthId} from './device-pin-handler.ts';
export class CommandDenied extends Error {constructor(readonly status:401|403=403){super('Command access denied.');}}
export class CommandConflict extends Error {}
class CatalogueSnapshotChanged extends Error {}
export interface CommandStore {apply(jwt:string,command:CloudCommand):Promise<unknown>}
export function createCommandsHandler(deps:{store:CommandStore;origins:ReadonlySet<string>}){
  const origins=new Set(deps.origins);
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
    const auth=request.headers.get('authorization')||'',jwt=auth.length<=8192?auth.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
    if(!jwt)return reply(401,{error:'Sign in again to make this change.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    let raw:unknown;try{raw=await readAuthBody(request,4096);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the command request.'});}
    let command:CloudCommand;try{command=parseCloudCommand(raw);}catch{return reply(400,{error:'Choose a supported catalogue action and its exact fields.'});}
    try{return reply(200,parseCloudCommandReceipt(await deps.store.apply(jwt,command),command));}
    catch(error){return error instanceof CommandDenied?reply(error.status,{error:'This change is unavailable for this account.'}):error instanceof CommandConflict?reply(409,{error:'This command conflicts with an existing or newer change. Refresh before trying again.'}):reply(503,{error:'Changes are unavailable. Try again with the same command ID.'});}
  };
}
export function createCommandStore(apiUrl:string,publishableKey:string,send:typeof fetch=fetch,options:{serviceKey?:string;newId?:()=>string}={}):CommandStore {
  const root=new URL(apiUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw new Error('Commands are not configured.');
  async function rpc(name:string,args:Record<string,unknown>,key:string,jwt?:string,retry=false){
    const headers:Record<string,string>={apikey:key,'Content-Type':'application/json'};if(jwt)headers.Authorization='Bearer '+jwt;
    const r=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers,body:JSON.stringify(args)});
    if(r.status===401&&!jwt)throw new Error('Server command credentials unavailable');
    if(r.status===401||r.status===403)throw new CommandDenied(r.status);
    if(r.status===409){let code:unknown,details:unknown;try{const error=await r.json();code=error.code;details=error.details;}catch{/* Only the fixed error tag controls retry; backend details remain private. */}if(retry&&code==='PT409'&&details==='catalogue_snapshot_changed')throw new CatalogueSnapshotChanged();throw new CommandConflict();}
    if(!r.ok)throw new Error('Command unavailable');return r.json();
  }
  return {apply:async(jwt,c)=>{
    if(c.type==='catalogue.create'||c.type==='catalogue.update'||c.type==='catalogue.delete'){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Catalogue writes unavailable');
      const hash=await catalogueFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_catalogue_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_item_id:c.itemId,p_outlet_id:c.type==='catalogue.create'?c.outletId:null,p_hash:hash},publishableKey,jwt);
        if(prepared?.done===true)return prepared.receipt;
        const fields=catalogueWriteFields(prepared,c,ticket,newId);
        try{return await rpc('finish_catalogue_write',fields,options.serviceKey,undefined,true);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    return rpc('apply_catalogue_command',{p_id:c.id,p_type:c.type,p_item_id:c.type==='catalogue.availability'?c.itemId:null,p_available:c.type==='catalogue.availability'?c.available:null,p_undo_of:c.type==='catalogue.undo'?c.undoOf:null},publishableKey,jwt);
  }};
}
