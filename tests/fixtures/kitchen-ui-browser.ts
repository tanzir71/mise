import {openScreenJournal} from '../../apps/web/src/data/device-screen-journal';
import type {ScreenState} from '../../packages/core/device-screen-state';
const base=()=>location.pathname.replace(/\/app\/.*$/,'/app/');
async function initialize(state:ScreenState){const journal=await openScreenJournal(base());try{await journal.replace(await journal.read(),state);localStorage.setItem('mise.flags',JSON.stringify({kitchenScreen:true,deviceAccess:true,cloudSetup:true}));}finally{journal.close();}}
async function inspect(){const journal=await openScreenJournal(base());try{const record=await journal.read();const cache=record.state.phase==='signed-in'?await journal.readKitchen(record):null;return cache?{taps:cache.taps.map(tap=>({id:tap.action.id,type:tap.action.type,parent:tap.action.parentAckId,receipt:tap.receipt?.id??null,review:tap.review,sourceHash:tap.action.contentHash,
  memberId:tap.access.memberId,sessionId:tap.access.sessionId,source:tap.source,
  closeIntents:tap.closeIntents?.map(intent=>({id:intent.id,memberId:intent.access.memberId,sessionId:intent.access.sessionId,occurredAt:intent.occurredAt}))??[],
  closure:tap.closure?{id:tap.closure.id,memberId:tap.closure.memberId,sessionId:tap.closure.sessionId}:null})),cursor:cache.cursor,tickets:cache.tickets.length,warningMinutes:cache.warningMinutes}:null;}finally{journal.close();}}
window.miseKitchenUiTest={initialize,inspect};
declare global{interface Window{miseKitchenUiTest:{initialize:typeof initialize;inspect:typeof inspect}}}
