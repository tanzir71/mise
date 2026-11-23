import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {emptyStaffProfile,type StaffDraft} from '../packages/core/staff';
import {parseStaffOwnerContext,parseStaffOwnerAction,parseStaffOwnerOutcome} from '../packages/core/staff-protocol';
import {newInboxId} from '../packages/core/inbox';
import {createStaffDeviceHandler} from '../supabase/functions/_shared/staff-device-handler';
import {createDeviceAccessHandler,type DeviceAccessStore} from '../supabase/functions/_shared/device-access-handler';
import {createDevicePinHandler} from '../supabase/functions/_shared/device-pin-handler';
export const staffDeviceOrigin='https://shop.test',staffDeviceConnection={apiUrl:'https://screen.test',publishableKey:'sb_publishable_test_only'};
export async function createStaffDeviceFixture(root?:string){
 const f=await createPairingDatabase(root),scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const};
 async function configure(memberId=deviceId(105),patch:Partial<StaffDraft>={}){
  const context=parseStaffOwnerContext(await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[scope.outletId,memberId]),scope,memberId);
  const draft:StaffDraft={...emptyStaffProfile(),name:memberId===deviceId(105)?'Karim Uddin':'Nadia Akter',nameLocal:'কর্মী',phone:null,role:'kitchen',active:true,methods:['order_phone'],...patch};
  const action=parseStaffOwnerAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),kind:'save',memberId,expected:context.current,latest:null,draft,checkIn:null});
  return parseStaffOwnerOutcome(await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[scope.outletId,JSON.stringify(action),'submit']),action).member!;
 }
 const accessStore:DeviceAccessStore={request:(id,code,parent,hash)=>f.asRole(null,'service_role','select public.request_device_pairing($1,$2,$3,$4) data',[id,code,parent,hash]),poll:(id,secret)=>f.asRole(null,'service_role','select public.read_device_pairing($1,$2) data',[id,secret]),directory:f.directoryRead,session:(secret,token)=>f.asRole(null,'service_role','select public.read_device_session($1,$2) data',[secret,token]),logout:(secret,token,event)=>f.asRole(null,'service_role','select public.end_device_session($1,$2,$3) data',[secret,token,event]),reset:(secret,id,attempt)=>f.asRole(null,'service_role','select public.reset_device_signins($1,$2,$3) data',[secret,id,attempt])};
 function handlers(origin=staffDeviceOrigin,limit=600){return {
  access:createDeviceAccessHandler({store:accessStore,origins:new Set([origin])}),
  pin:createDevicePinHandler({store:{begin:(attempt,secret,member)=>f.asRole(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[attempt,secret,member]),finish:(secret,attempt,proof,session,event)=>f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[secret,attempt,proof,session,event])},origins:new Set([origin]),peppers:new Map([['v1',f.pepper]])}),
  staff:createStaffDeviceHandler({store:{visit:(secret,input,budget)=>f.asRole(null,'service_role','select public.visit_staff_device($1,$2,$3,$4,$5,$6) data',[secret,input.sessionToken,input.operation,input.intent===null?null:JSON.stringify(input.intent),input.after===null?null:JSON.stringify(input.after),budget]),board:(secret,input,budget)=>f.asRole(null,'service_role','select public.read_staff_device_board($1,$2,$3,$4) data',[secret,input.sessionToken,input.after,budget])},origins:new Set([origin]),limit})};}
 function transport(limit=600){const h=handlers(staffDeviceOrigin,limit);return async(url:Parameters<typeof fetch>[0],options?:RequestInit)=>{const headers=new Headers(options?.headers);headers.set('Origin',staffDeviceOrigin);const request=new Request(String(url),{...options,headers}),path=new URL(String(url)).pathname;return path.endsWith('/staff-device')?h.staff(request):path.endsWith('/device-pin')?h.pin(request):h.access(request);};}
 return {...f,scope,configure,handlers,transport};
}
