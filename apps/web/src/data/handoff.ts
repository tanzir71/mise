import type { MiseDatabase } from './db';
import { changeHandoffCommand,handoffDraftToken,handoffEventSession,handoffSessionToken,handoffSourceTables,handoffTopic,newHandoffActionId,normaliseHandoffDraft,prepareHandoffCommand,type HandoffDraft,type HandoffSession } from '@mise/core/handoff';
import type { HandoffChoice } from '@mise/core/handoff-progress';
import type { SetupSnapshot } from '@mise/core/models';

async function setup(db:MiseDatabase):Promise<SetupSnapshot>{const value=await db.setup();if(!value)throw new Error('Set up your shop first.');return value;}
async function subject(db:MiseDatabase,draft:HandoffDraft,current:SetupSnapshot):Promise<void>{
  const source=await db.table(handoffSourceTables[draft.source.kind]).get(draft.source.id) as Record<string,unknown>|undefined;
  if(!source||(draft.source.kind==='shop'?source.id!==current.outlet.id:draft.source.kind==='customer'?source.businessId!==current.business.id:source.outletId!==current.outlet.id))throw new Error('This message belongs to a missing or different shop record.');
}
async function latest(db:MiseDatabase,id:string,outletId:string):Promise<HandoffSession>{
  const event=await db.events.where('[handoffId+handoffRevision]').between([id,1],[id,Number.MAX_SAFE_INTEGER],true,true).last();
  if(!event)throw new Error('This message attempt could not be found.');
  const state=handoffEventSession(event),root=await db.events.get(id);
  if(!root||root.command!=='handoff.prepare'||state.outletId!==outletId)throw new Error('This message belongs to another shop.');
  const original=handoffEventSession(root);
  if(original.outletId!==state.outletId||original.generation!==state.generation||original.createdAt!==state.createdAt||handoffDraftToken(original.draft)!==handoffDraftToken(state.draft))throw new Error('The original message attempt changed.');
  return state;
}
export async function readDatabaseHandoff(db:MiseDatabase,id:string):Promise<HandoffSession>{
  return db.transaction('r',db.tables,async()=>latest(db,id,(await setup(db)).outlet.id));
}
export async function prepareDatabaseHandoff(db:MiseDatabase,input:HandoffDraft,fresh=false):Promise<HandoffSession>{
  const draft=normaliseHandoffDraft(input);if(typeof fresh!=='boolean')throw new Error('Choose whether to start another attempt.');
  return db.transaction('rw',db.tables,async()=>{
    const current=await setup(db);await subject(db,draft,current);
    const preparations=await db.events.where('handoffTopic').equals(handoffTopic(draft)).filter(event=>event.outletId===current.outlet.id&&event.command==='handoff.prepare').toArray();
    const previous=preparations.map(handoffEventSession).reduce<HandoffSession|undefined>((best,row)=>!best||row.generation>best.generation?row:best,undefined);
    const active=previous?await latest(db,previous.id,current.outlet.id):undefined;
    if(active&&!fresh&&handoffDraftToken(active.draft)===handoffDraftToken(draft))return active;
    const change=prepareHandoffCommand(draft,current,(active?.generation||0)+1,Math.max(Date.now(),active?.progress.updatedAt||0));
    await db.events.add(change.event);return change.session;
  });
}
export async function changeDatabaseHandoff(db:MiseDatabase,id:string,revision:number,choice:HandoffChoice,requestId=newHandoffActionId()):Promise<HandoffSession>{
  return db.transaction('rw',db.tables,async()=>{
    const current=await setup(db),existing=await db.events.get(requestId);
    if(existing){
      const saved=handoffEventSession(existing);
      if(existing.handoffId!==id||existing.command!==`handoff.${choice.type}`||saved.outletId!==current.outlet.id)throw new Error('This message action ID was used for another choice.');
      const expected=changeHandoffCommand(existing.before as HandoffSession,choice,current,revision,requestId,existing.at);
      if(handoffSessionToken(saved)!==handoffSessionToken(expected.session))throw new Error('This message action ID was used for another choice.');
      return latest(db,id,current.outlet.id);
    }
    const before=await latest(db,id,current.outlet.id);await subject(db,before.draft,current);
    const change=changeHandoffCommand(before,choice,current,revision,requestId,Math.max(Date.now(),before.progress.updatedAt));
    await db.events.add(change.event);return change.session;
  });
}
