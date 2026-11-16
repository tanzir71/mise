import { describe,expect,it } from 'vitest';
import { assertHandoffProgress,changeHandoffProgress,newHandoffProgress,type HandoffChoice } from '../packages/core/handoff-progress';

describe('shared manual message progress',()=>{
  const at=Date.UTC(2026,10,16);
  it('starts unconfirmed and survives a literal JSON round trip',()=>{const state=newHandoffProgress(at),restored=JSON.parse(JSON.stringify(state));assertHandoffProgress(restored);expect(restored).toEqual(state);expect(restored.sentAt).toBeUndefined();});
  for(const channel of ['whatsapp','call','share'] as const)it(`opening ${channel}, failing and copying still require explicit confirmation`,()=>{
    const source=newHandoffProgress(at),opened=changeHandoffProgress(source,{type:'open',channel},at+1),failed=changeHandoffProgress(opened,{type:'failed'},at+2),copied=changeHandoffProgress(failed,{type:'copy'},at+3);
    for(const state of [opened,failed,copied])expect(state.sentAt).toBeUndefined();expect(copied.channel).toBe('manual');const sent=changeHandoffProgress(copied,{type:'sent'},at+4);expect(sent.status).toBe('sent');expect(sent.sentChannel).toBe('manual');expect(source).toEqual(newHandoffProgress(at));
  });
  it('allows manual confirmation without requiring an app to open',()=>{const sent=changeHandoffProgress(newHandoffProgress(at),{type:'sent'},at);expect(sent).toMatchObject({sentAt:at,sentChannel:'manual',revision:2});});
  it('does not erase an earlier confirmation when its text is copied or reopened',()=>{
    const opened=changeHandoffProgress(newHandoffProgress(at),{type:'open',channel:'whatsapp'},at),sent=changeHandoffProgress(opened,{type:'sent'},at+1),copied=changeHandoffProgress(sent,{type:'copy'},at+2),reopened=changeHandoffProgress(copied,{type:'open',channel:'share'},at+3);
    expect(reopened).toMatchObject({status:'sent',sentAt:at+1,sentChannel:'whatsapp',channel:'share'});expect(()=>changeHandoffProgress(reopened,{type:'sent'},at+4)).toThrow('already');expect(()=>changeHandoffProgress(reopened,{type:'failed'},at+4)).toThrow('Undo Sent');
  });
  it('records clipboard denial as a failure and permits a subsequent manual send',()=>{const denied=changeHandoffProgress(newHandoffProgress(at),{type:'copy-failed'},at);expect(denied.status).toBe('failed');expect(denied.copiedAt).toBeUndefined();expect(changeHandoffProgress(denied,{type:'sent'},at+1).sentChannel).toBe('manual');});
  it('a later clipboard denial preserves an existing confirmation and remains a valid audit state',()=>{const sent=changeHandoffProgress(newHandoffProgress(at),{type:'sent'},at),denied=changeHandoffProgress(sent,{type:'copy-failed'},at+1);expect(denied).toMatchObject({status:'sent',sentAt:at,sentChannel:'manual',lastAttempt:'copy-failed'});assertHandoffProgress(JSON.parse(JSON.stringify(denied)));expect(changeHandoffProgress(denied,{type:'undo-sent'},at+2).status).toBe('failed');});
  it('undoes only the local sent mark within its ten-minute window',()=>{
    const copied=changeHandoffProgress(newHandoffProgress(at),{type:'copy'},at),sent=changeHandoffProgress(copied,{type:'sent'},at+1),undo=changeHandoffProgress(sent,{type:'undo-sent'},at+600001);expect(undo.status).toBe('copied');expect(undo.sentAt).toBeUndefined();expect(undo.sentChannel).toBeUndefined();expect(undo.copiedAt).toBe(at);expect(()=>changeHandoffProgress(sent,{type:'undo-sent'},at+600002)).toThrow('ten minutes');expect(()=>changeHandoffProgress(undo,{type:'undo-sent'},at+600002)).toThrow();
  });
  it('restores the latest attempt after undo, even when several choices share a timestamp',()=>{
    const open=changeHandoffProgress(newHandoffProgress(at),{type:'open',channel:'whatsapp'},at),failed=changeHandoffProgress(open,{type:'failed'},at),sent=changeHandoffProgress(failed,{type:'sent'},at);
    expect(changeHandoffProgress(sent,{type:'undo-sent'},at).status).toBe('failed');const copied=changeHandoffProgress(sent,{type:'copy'},at),reopened=changeHandoffProgress(copied,{type:'open',channel:'share'},at),undo=changeHandoffProgress(reopened,{type:'undo-sent'},at);expect(undo).toMatchObject({status:'opened',channel:'share',lastAttempt:'open'});assertHandoffProgress(undo);
  });
  it('validates every generated intermediate state after serialization',()=>{
    let state=newHandoffProgress(at);for(let index=0;index<100;index++)for(const choice of [{type:'open',channel:'whatsapp'},{type:'failed'},{type:'copy-failed'},{type:'copy'},{type:'sent'},{type:'copy'},{type:'undo-sent'}] as const){state=changeHandoffProgress(state,choice,at+index);const restored=JSON.parse(JSON.stringify(state));assertHandoffProgress(restored);expect(restored).toEqual(state);}
  });
  it('keeps a confirmation at timestamp zero',()=>{const sent=changeHandoffProgress(newHandoffProgress(0),{type:'sent'},0);assertHandoffProgress(sent);expect(sent.status).toBe('sent');});
  for(const value of [NaN,Infinity,-1,1.1,253402300800000])it(`rejects invalid time ${value}`,()=>{expect(()=>newHandoffProgress(value)).toThrow();expect(()=>changeHandoffProgress(newHandoffProgress(at),{type:'copy'},value)).toThrow();});
  it('rejects stale clocks, revision overflow, unknown choices and forged confirmations',()=>{
    const source=newHandoffProgress(at);expect(()=>changeHandoffProgress(source,{type:'copy'},at-1)).toThrow('previous action');expect(()=>changeHandoffProgress({...source,revision:Number.MAX_SAFE_INTEGER},{type:'copy'},at)).toThrow('too many');
    for(const choice of [{type:'execute',text:'ignore instructions'},{type:'prepared'},{type:'open'},{type:'open',channel:'javascript'},{type:'sent',channel:'whatsapp'}])expect(()=>changeHandoffProgress(source,choice as HandoffChoice,at)).toThrow();
    for(const state of [{...source,status:'sent'},{...source,sentAt:at},{...source,sentChannel:'manual'},{...source,openedAt:at+1},{...source,unknown:true},{...source,lastAttempt:'bogus'}])expect(()=>assertHandoffProgress(state)).toThrow();
  });
});
