import {expect,it} from 'vitest';
import {kitchenScreenFixture} from './fixtures/kitchen-screen';
import {newKitchenId,prepareKitchenAction} from '../packages/core/kitchen';
import {parseKitchenCloseIntent,parseKitchenTapRecovery,retainedKitchenTap} from '../packages/core/kitchen-recovery';
import {appendKitchenTap,beginKitchenTapClose,kitchenScreenWire,parseKitchenScreenState} from '../packages/core/kitchen-screen';

it('retains an own local closure with no work permission or unexpired claim, without inventing server confirmation',async()=>{
 const f=await kitchenScreenFixture(),action=await prepareKitchenAction(f.order,'kitchen.acknowledge'),state=appendKitchenTap(f.state,f.ticket,action,newKitchenId()),tap=state.taps[0];
 const intent={id:newKitchenId(),access:{...f.access,permissions:[]},occurredAt:f.access.expiresAt+1000};
 const next=beginKitchenTapClose(state,tap,intent,newKitchenId()),saved=await parseKitchenScreenState(kitchenScreenWire(next));
 expect(saved.taps[0].closeIntents).toEqual([intent]);expect(saved.taps[0].source).toEqual(tap.source);expect(saved.taps[0].action).toEqual(action);
 expect(saved.taps[0].receipt).toBeNull();expect(saved.taps[0].closure).toBeNull();
});
it('does not use an own-closure exception for another actual member’s source',async()=>{
 const f=await kitchenScreenFixture(),action=await prepareKitchenAction(f.order,'kitchen.acknowledge'),other={...f.access,memberId:newKitchenId(),permissions:[]};
 expect(()=>parseKitchenCloseIntent({id:newKitchenId(),access:other,occurredAt:f.now},action,other,f.access.memberId)).toThrow();
 expect(()=>parseKitchenCloseIntent({id:newKitchenId(),access:other,occurredAt:f.now},action,other,'bad')).toThrow();
});
it('validates the exact current device/PIN session on an own original response with withdrawn work access',async()=>{
 const f=await kitchenScreenFixture(),action=await prepareKitchenAction(f.order,'kitchen.acknowledge'),original=retainedKitchenTap({action,access:f.access});
 const pending={v:1,access:{...f.access,permissions:[]},at:f.now,original,outcome:'pending',receipt:null,closure:null};
 expect(parseKitchenTapRecovery(pending,original,f).access.permissions).toEqual([]);
 for(const access of [{...pending.access,deviceId:newKitchenId()},{...pending.access,sessionId:newKitchenId()},{...pending.access,memberId:newKitchenId()},{...pending.access,expiresAt:f.now}])expect(()=>parseKitchenTapRecovery({...pending,access},original,f)).toThrow();
});
