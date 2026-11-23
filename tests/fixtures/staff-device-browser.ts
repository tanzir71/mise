import {openScreenJournal} from '../../apps/web/src/data/device-screen-journal';
import type {ScreenState} from '../../packages/core/device-screen-state';
const base=()=>location.pathname.replace(/\/app\/.*$/,'/app/');
async function initialize(state:ScreenState){const journal=await openScreenJournal(base());try{await journal.replace(await journal.read(),state);localStorage.setItem('mise.flags',JSON.stringify({staffTeam:true,deviceAccess:true,kitchenScreen:true}));}finally{journal.close();}}
async function inspect(){const journal=await openScreenJournal(base());try{const source=await journal.read();return {phase:source.state.phase,memberId:source.state.phase==='signed-in'?source.state.session.memberId:null,attendance:source.state.phase==='signed-in'?await journal.readAttendance(source):null};}finally{journal.close();}}
window.miseStaffDeviceTest={initialize,inspect};
declare global{interface Window{miseStaffDeviceTest:{initialize:typeof initialize;inspect:typeof inspect}}}
