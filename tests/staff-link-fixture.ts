import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {emptyStaffProfile,type StaffDraft} from '../packages/core/staff';
import {deviceSecretHash} from '../packages/core/device-access';
import {parseStaffOwnerAction,parseStaffOwnerContext,parseStaffOwnerOutcome} from '../packages/core/staff-protocol';
import {parseStaffLinkAction,parseStaffLinkContext,parseStaffLinkOutcome,type StaffLinkAction,type StaffPublicRequest} from '../packages/core/staff-links';
export async function createStaffLinkDatabase(){
 const f=await createPairingDatabase(),scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const},token='J'.repeat(43);
 async function seed(){await f.seed();await f.db.exec('update private.staff_link_budget set window_at=0,requests=0');}
 const context=async(memberId=deviceId(105),after:string|null=null)=>parseStaffLinkContext(await f.asRole(1,'authenticated','select public.read_staff_links($1,$2,$3) data',[scope.outletId,memberId,after]),scope,memberId,after);
 const owner=async(action:StaffLinkAction,operation='submit')=>parseStaffLinkOutcome(await f.asRole(1,'authenticated','select public.change_staff_link($1,$2,$3) data',[scope.outletId,JSON.stringify(action),operation]),action);
 async function configure(memberId=deviceId(105)){
  const c=parseStaffOwnerContext(await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[scope.outletId,memberId]),scope,memberId);
  const draft:StaffDraft={...emptyStaffProfile(),name:'Karim Uddin',nameLocal:'করিম উদ্দিন',phone:null,role:'kitchen',active:true,methods:['link']};
  const action=parseStaffOwnerAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId,kind:'save',expected:c.current,latest:null,draft,checkIn:null});
  return parseStaffOwnerOutcome(await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[scope.outletId,JSON.stringify(action),'submit']),action).member!;
 }
 async function issue(memberId=deviceId(105),secret=token){await configure(memberId);const c=await context(memberId),action=parseStaffLinkAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId,linkId:newInboxId(),kind:'issue',expected:c.current,tokenHash:await deviceSecretHash(secret),expiresAt:c.serverAt+30*86400000});return {action,result:await owner(action),member:c.current!};}
 async function visit(input:StaffPublicRequest,limits={global:10000,link:10000}){return f.asRole<Record<string,unknown>>(null,'service_role','select public.visit_staff_link($1,$2,$3,$4,$5,$6) data',
  [input.token,input.operation,input.intent===null?null:JSON.stringify(input.intent),input.after===null?null:JSON.stringify(input.after),limits.global,limits.link]);}
 return {...f,seed,scope,token,context,owner,configure,issue,visit};
}
