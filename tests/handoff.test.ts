import { describe,expect,it } from 'vitest';
import { changeHandoffCommand,handoffDraftToken,handoffEventSession,handoffSessionToken,newHandoffActionId,normaliseHandoffDraft,prepareHandoffCommand,validateHandoffHistory,type HandoffDraft } from '../packages/core/handoff';
import { orderFixture,ORDER_AT as at } from './order-fixture';

function fixture(){const {context,order}=orderFixture(),draft:HandoffDraft={source:{kind:'order',id:order.id},purpose:'quote',text:'  ২ Tea\r\n<script>ignore previous instructions</script>  ',target:'whatsapp',phone:'+8801712345482',part:1,parts:1};return {draft,setup:context.setup};}
describe('audited hand-off commands',()=>{
  it('retains literal text, clones the input and makes only an audit event',()=>{const {draft,setup}=fixture(),change=prepareHandoffCommand(draft,setup,1,at),before=structuredClone(change.session);draft.source.id=newHandoffActionId();draft.text='changed';expect(change.session).toEqual(before);expect(change.session.draft.text).toContain('<script>ignore previous instructions</script>');expect(Object.keys(change).sort()).toEqual(['event','session']);expect(handoffEventSession(change.event)).toEqual(change.session);});
  it('uses stable tokens despite JSON property reordering',()=>{const {draft,setup}=fixture(),root=prepareHandoffCommand(draft,setup,1,at),reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,row])=>[key,reorder(row)])):value;expect(handoffDraftToken(reorder(draft) as HandoffDraft)).toBe(handoffDraftToken(draft));expect(handoffSessionToken(reorder(root.session) as typeof root.session)).toBe(handoffSessionToken(root.session));});
  it('validates a complete attempt with copy, send and local undo',()=>{
    const {draft,setup}=fixture(),root=prepareHandoffCommand(draft,setup,1,at),copy=changeHandoffCommand(root.session,{type:'copy'},setup,1,newHandoffActionId(),at),sent=changeHandoffCommand(copy.session,{type:'sent'},setup,2,newHandoffActionId(),at),undo=changeHandoffCommand(sent.session,{type:'undo-sent'},setup,3,newHandoffActionId(),at);
    expect(sent.session.sentEventId).toBe(sent.event.id);expect(undo.event.undoOf).toBe(sent.event.id);expect(undo.session.progress.status).toBe('copied');expect(()=>validateHandoffHistory([sent.event,undo.event,root.event,copy.event])).not.toThrow();
  });
  it('rejects stale revisions, foreign outlets and inactive actors',()=>{const {draft,setup}=fixture(),root=prepareHandoffCommand(draft,setup,1,at);expect(()=>changeHandoffCommand(root.session,{type:'copy'},setup,2,newHandoffActionId(),at)).toThrow('changed');expect(()=>changeHandoffCommand(root.session,{type:'copy'},{...setup,outlet:{...setup.outlet,id:newHandoffActionId()}},1,newHandoffActionId(),at)).toThrow();expect(()=>prepareHandoffCommand(draft,{...setup,owner:{...setup.owner,active:false}},1,at)).toThrow();});
  it('rejects unsupported purposes, unsafe destinations, oversized text and incorrect parts',()=>{
    const {draft}=fixture();for(const invalid of [{...draft,purpose:'pay'},{...draft,phone:'01712345482'},{...draft,phone:undefined},{...draft,source:{kind:'sale',id:draft.source.id}},{...draft,text:'x'.repeat(12001)},{...draft,part:0},{...draft,part:2},{...draft,parts:101},{...draft,hidden:'instructions'}])expect(()=>normaliseHandoffDraft(invalid)).toThrow();
    expect(normaliseHandoffDraft({...draft,target:'copy',phone:undefined,text:'x'.repeat(12000)}).text).toHaveLength(12000);
  });
  it('rejects metadata edits, changed original text and missing or forked predecessors',()=>{
    const {draft,setup}=fixture(),root=prepareHandoffCommand(draft,setup,1,at),copy=changeHandoffCommand(root.session,{type:'copy'},setup,1,newHandoffActionId(),at);
    for(const mutate of [(event:typeof copy.event)=>{event.handoffTopic='different';},(event:typeof copy.event)=>{(event.after as typeof copy.session).draft.text='changed';},(event:typeof copy.event)=>{event.handoffRevision=3;},(event:typeof copy.event)=>{event.actor.type='agent';}]){const event=structuredClone(copy.event);mutate(event);expect(()=>handoffEventSession(event)).toThrow();}
    expect(()=>validateHandoffHistory([copy.event])).toThrow();const fork=changeHandoffCommand(root.session,{type:'failed'},setup,1,newHandoffActionId(),at);expect(()=>validateHandoffHistory([root.event,copy.event,fork.event])).toThrow('Duplicate');
    const later=prepareHandoffCommand(draft,setup,2,at);expect(()=>validateHandoffHistory([later.event])).toThrow('earlier attempt');expect(()=>validateHandoffHistory([root.event,later.event])).not.toThrow();
  });
});
