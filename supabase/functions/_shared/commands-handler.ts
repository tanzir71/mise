import {parseCloudCommand,parseCloudCommandReceipt,type CloudCommand} from '../../../packages/core/cloud-commands.ts';
import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
export class CommandDenied extends Error {constructor(readonly status:401|403=403){super('Command access denied.');}}
export class CommandConflict extends Error {}
export interface CommandStore {apply(jwt:string,command:CloudCommand):Promise<unknown>}
export function createCommandsHandler(deps:{store:CommandStore;origins:ReadonlySet<string>}){
  const origins=new Set(deps.origins);
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
    const auth=request.headers.get('authorization')||'',jwt=auth.length<=8192?auth.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
    if(!jwt)return reply(401,{error:'Sign in again to make this change.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    let raw:unknown;try{raw=await readAuthBody(request);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the command request.'});}
    let command:CloudCommand;try{command=parseCloudCommand(raw);}catch{return reply(400,{error:'Choose a supported catalogue action and its exact fields.'});}
    try{return reply(200,parseCloudCommandReceipt(await deps.store.apply(jwt,command),command));}
    catch(error){return error instanceof CommandDenied?reply(error.status,{error:'This change is unavailable for this account.'}):error instanceof CommandConflict?reply(409,{error:'This command conflicts with an existing or newer change. Refresh before trying again.'}):reply(503,{error:'Changes are unavailable. Try again with the same command ID.'});}
  };
}
export function createCommandStore(apiUrl:string,publishableKey:string,send:typeof fetch=fetch):CommandStore {
  const root=new URL(apiUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw new Error('Commands are not configured.');
  return {apply:async(jwt,c)=>{
    const r=await send(new URL('rest/v1/rpc/apply_catalogue_command',root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{apikey:publishableKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify({p_id:c.id,p_type:c.type,p_item_id:c.type==='catalogue.availability'?c.itemId:null,p_available:c.type==='catalogue.availability'?c.available:null,p_undo_of:c.type==='catalogue.undo'?c.undoOf:null})});
    if(r.status===401||r.status===403)throw new CommandDenied(r.status);if(r.status===409)throw new CommandConflict();if(!r.ok)throw new Error('Command unavailable');return r.json();
  }};
}
