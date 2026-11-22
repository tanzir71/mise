import {parseScreenJournalRecord, type ScreenJournalRecord} from '@mise/core/device-screen-state';
import {parseStaffDeviceAccess} from '@mise/core/device-access';
import {kitchenReadyPath, newKitchenId, prepareKitchenAction, type KitchenActionKind} from '@mise/core/kitchen';
import {appendKitchenTap,beginKitchenTapClose,finishKitchenTapClose,finishKitchenTap,kitchenTapAcknowledges, receiveKitchenChanges, receiveKitchenPage, sameKitchenSession, type KitchenScreenState,type KitchenTap} from '@mise/core/kitchen-screen';
import {retainedKitchenTap,type KitchenCloseIntent} from '@mise/core/kitchen-recovery';
import type {KitchenTicket} from '@mise/core/kitchen-tickets';
import {assertCommandReceipt} from './command-request';
import {assertBlankScreenProfile, ScreenStorageError, type ScreenJournal} from './device-screen-journal';
import {createDeviceScreenRemote, DeviceScreenRequestError} from './device-screen-remote';

export function createKitchenScreenSession(journal: ScreenJournal, input: ScreenJournalRecord,
  deps: {blank?: () => Promise<void>; send?: typeof fetch; changed?: (state: KitchenScreenState) => void; now?: () => number} = {}) {
  const original = parseScreenJournalRecord(input);
  if (original.state.phase !== 'signed-in') throw new ScreenStorageError('changed');
  const {credential, session} = original.state, blank = deps.blank ?? assertBlankScreenProfile, now = deps.now ?? Date.now;
  let disposed = false, pulling = false, delivering = false, recovering=false, local: Promise<unknown> = Promise.resolve();
  const controller = new AbortController();
  const current = () => {if (disposed) throw new ScreenStorageError('changed');};
  const expected = {device: credential.device, session};
  const api = createDeviceScreenRemote({connection: credential.connection, requestId: credential.device.id, token: credential.token}, current, deps.send ?? fetch);
  async function verify() {current(); await blank(); current(); await journal.assertCurrent(original); current();}
  async function read() {await verify(); const saved = await journal.readKitchen(original); current(); return saved;}
  function actor(state: KitchenScreenState) {return parseStaffDeviceAccess(state.access, expected);}
  function edit(change: (state: KitchenScreenState | null) => KitchenScreenState, proof?: object) {
    const saving = local.catch(() => {}).then(async () => {
      // A sibling tab can append while HTTP is in flight. Reload and merge the
      // complete queue; never replace it with an earlier network snapshot.
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = await read(), next = change(before);
        try {
          const saved = await journal.replaceKitchen(original, before, next, {signal: controller.signal, assertCurrent: () => {current(); if (proof) assertCommandReceipt(proof);}});
          current(); deps.changed?.(saved); return saved;
        } catch (error) {
          if (!(error instanceof ScreenStorageError) || error.kind !== 'changed' || attempt === 3) throw error;
          await verify();
        }
      }
      throw new ScreenStorageError('changed');
    });
    local = saving;
    return saving;
  }
  async function recoverOriginal(original:KitchenTap,intent:KitchenCloseIntent|null=null){
    await verify();
    const outcome=await api.recoverKitchenTap(credential.device,session,retainedKitchenTap(original),intent,controller.signal);
    await verify();
    if(outcome.outcome==='pending')return read();
    return edit(latest=>{
      if(!latest)throw new ScreenStorageError('changed');
      return outcome.receipt?finishKitchenTap(latest,original,outcome.receipt,newKitchenId()):
        finishKitchenTapClose(latest,original,outcome.closure!,newKitchenId());
    },outcome);
  }
  return {
    async load() {
      const state = await read();
      if (!state) return null;
      // Another staff member's saved preparation screen is not shown before
      // a fresh authorized read. Their original pending taps remain retained.
      try {actor(state);} catch {return null;}
      return state;
    },
    async pull() {
      if (pulling) return;
      pulling = true;
      try {
        await verify();
        for (;;) {
          const state = await read();
          let same = false;
          if (state) try {actor(state); same = true;} catch {/* Fresh read below. */}
          if (!same || state!.cursor === null) {
            const after = same ? state!.after : null, page = await api.tickets(credential.device, session, after, controller.signal);
            await verify();
            const saved = await edit(latest => {
              if (!same) {
                if (latest && (latest.access.deviceId !== page.access.deviceId || latest.access.businessId !== page.access.businessId || latest.access.outletId !== page.access.outletId)) throw new ScreenStorageError('changed');
                const retained = latest ? {...latest, access: page.access, at: page.at, tickets: [], after: null, bootstrapWatermark: null, cursor: null, until: null} : null;
                return receiveKitchenPage(retained, page, newKitchenId());
              }
              if (!latest || latest.cursor !== null || JSON.stringify(latest.after) !== JSON.stringify(after)) throw new ScreenStorageError('changed');
              return receiveKitchenPage(latest, page, newKitchenId());
            }, page);
            if (saved.cursor === null) continue;
          } else {
            const page = await api.ticketChanges(credential.device, session, state!.cursor!, state!.until, controller.signal);
            await verify();
            const saved = await edit(latest => {
              if (!latest || latest.cursor !== state!.cursor || latest.until !== state!.until) throw new ScreenStorageError('changed');
              return receiveKitchenChanges(latest, page, newKitchenId());
            }, page);
            if (saved.until === null) return;
          }
        }
      } finally {pulling = false;}
    },
    async tap(inputTicket: KitchenTicket, kind: KitchenActionKind) {
      // Capture the displayed ticket and gesture clock before ANY asynchronous
      // profile/cache work. A newer cached ticket must be reviewed separately.
      const source = structuredClone(inputTicket), occurredAt = now();
      const before = await read();
      if (!before) throw new DeviceScreenRequestError('review');
      const access = actor(before);
      if (access.expiresAt <= occurredAt || !access.permissions.includes(kind === 'kitchen.acknowledge' ? 'orders.acknowledge' : 'orders.ready')) throw new DeviceScreenRequestError('auth');
      const pendingAck = before.taps.find(tap => kitchenTapAcknowledges(before,source,tap));
      const parent = source.acknowledgement?.id ?? pendingAck?.action.id ?? null;
      if (kind === 'kitchen.ready' && (!source.priced || !parent || !kitchenReadyPath(source)?.length)) throw new DeviceScreenRequestError('review');
      const action = await prepareKitchenAction(source, kind, kind === 'kitchen.ready' ? parent : null, occurredAt);
      return edit(latest => {
        if (!latest || !sameKitchenSession(latest.access, access)) throw new ScreenStorageError('changed');
        return appendKitchenTap(latest, source, action, newKitchenId());
      });
    },
    async recoverTap(inputTap:KitchenTap){return recoverOriginal(structuredClone(inputTap));},
    async closeTap(inputTap:KitchenTap){
      // The retained source, reviewer and gesture time are captured before
      // asynchronous profile work. Persist the request before any HTTP write.
      const original=structuredClone(inputTap),occurredAt=now(),id=newKitchenId(occurredAt),before=await read();
      if(!before)throw new DeviceScreenRequestError('review');
      const access=actor(before);
      if(access.expiresAt<=occurredAt||!access.permissions.includes(original.action.type==='kitchen.acknowledge'?'orders.acknowledge':'orders.ready'))throw new DeviceScreenRequestError('auth');
      const saved=await edit(latest=>{
        if(!latest)throw new ScreenStorageError('changed');
        return beginKitchenTapClose(latest,original,{id,access,occurredAt},newKitchenId());
      });
      return saved;
    },
    async recover(){
      if(recovering)return;recovering=true;
      try{
        const state=await read();if(!state)return;
        const access=actor(state);if(access.expiresAt<=now())throw new DeviceScreenRequestError('auth');
        for(const tap of state.taps){
          if(tap.receipt||tap.closure||sameKitchenSession(tap.access,access)&&!tap.review&&!tap.closeIntents?.length)continue;
          const canClose=access.permissions.includes(tap.action.type==='kitchen.acknowledge'?'orders.acknowledge':'orders.ready');
          const intent=canClose?tap.closeIntents?.find(intent=>sameKitchenSession(intent.access,access))??null:null;
          // A previous reviewer's missing reply is looked up, never sent as
          // the newly signed-in member. A fresh close needs their own click.
          try{await recoverOriginal(tap,intent);}
          catch(error){
            if(!(error instanceof DeviceScreenRequestError)||error.kind!=='review')throw error;
            await edit(latest=>{if(!latest)throw new ScreenStorageError('changed');return finishKitchenTap(latest,tap,null,newKitchenId());});
          }
        }
      }finally{recovering=false;}
    },
    async deliver() {
      if (delivering) return;
      delivering = true;
      try {
        for (;;) {
          const state = await read();
          if (!state) return;
          let access;
          try {access = actor(state);} catch {return;}
          if (access.expiresAt <= now()) throw new DeviceScreenRequestError('auth');
          const next = state.taps.find(tap => !tap.receipt && !tap.review && !tap.closure && !tap.closeIntents?.length && sameKitchenSession(tap.access, access) &&
            (tap.action.type === 'kitchen.acknowledge' || tap.source.acknowledgement?.id === tap.action.parentAckId ||
              state.taps.some(parent => parent.action.id === tap.action.parentAckId && parent.receipt?.type === 'kitchen.acknowledge')));
          if (!next) return;
          try {
            const receipt = await api.kitchenAction(credential.device, session, next.access, next.action, controller.signal);
            await verify();
            await edit(latest => {
              if (!latest) throw new ScreenStorageError('changed');
              return finishKitchenTap(latest, next, receipt, newKitchenId());
            }, receipt);
          } catch (error) {
            if (!(error instanceof DeviceScreenRequestError) || error.kind !== 'review') throw error;
            await verify();
            await edit(latest => {
              if (!latest) throw new ScreenStorageError('changed');
              return finishKitchenTap(latest, next, null, newKitchenId());
            });
          }
        }
      } finally {delivering = false;}
    },
    dispose() {disposed = true; controller.abort();},
  };
}
