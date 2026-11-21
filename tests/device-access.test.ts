import {expect,it} from 'vitest';
import {deviceLabel,deviceLifetime,pairingLifetime,pairingCode,deviceSecretHash,deviceVerification,newDeviceSecret,parseDeviceDirectory,parseDevicePairing,parsePairingOutcome,parsePairingRequest,parseScreenSetupLink,parseSharedDevice,parseSharedDeviceCredential,parseDeviceAdminPage,parseStaffDeviceSession,parseStaffDeviceAccess,deviceSessionLifetime} from '../packages/core/device-access';
const id=(n:number)=>String(n).padStart(26,'0'),device={id:id(5),businessId:id(1),outletId:id(2),name:'Kitchen tablet',mode:'kitchen' as const,createdAt:1000,expiresAt:1000+deviceLifetime,revokedAt:null},connection={apiUrl:'https://screen.test',publishableKey:'sb_publishable_test_only'};
it('accepts Bengali digits and grouped entry without accepting a shorter code or arbitrary input',()=>{expect(pairingCode('১২৩ ৪৫৬')).toBe('123456');expect(pairingCode('123-456')).toBe('123456');for(const v of ['12345','1234567','1a3456',null,123456])expect(()=>pairingCode(v)).toThrow();});
it('new labels match the database character limit while retaining older literal metadata',()=>{
 expect(deviceLabel('  রান্নাঘর  ')).toBe('রান্নাঘর');expect(deviceLabel('😀'.repeat(80))).toBe('😀'.repeat(80));expect(()=>deviceLabel('😀'.repeat(81))).toThrow();expect(()=>deviceLabel('Kitchen\0')).toThrow();
 expect(parseSharedDevice({...device,name:'  Kitchen\n'+('😀'.repeat(70))+'  '}).name).toBe('  Kitchen\n'+('😀'.repeat(70))+'  ');
});
it('generates a screen-owned secret and a separate reproducible 64-bit verification value',async()=>{
 const secret=newDeviceSecret(),other=newDeviceSecret();expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(secret).not.toBe(other);const hash=await deviceSecretHash(secret);expect(hash).toMatch(/^[a-f0-9]{64}$/);expect(hash).not.toBe(await deviceSecretHash(other));expect(deviceVerification(hash)).toBe(hash.slice(0,16).toUpperCase().match(/.{4}/g)!.join('-'));expect(deviceVerification(hash)).not.toContain(secret);expect(()=>deviceVerification('x'.repeat(64))).toThrow();
});
it('pairing metadata cannot extend an invitation, replace its kind or carry a device secret',()=>{
 const pairing={v:1,id:id(10),businessId:id(1),outletId:id(2),name:'Kitchen',mode:'kitchen',code:'123456',createdAt:1000,expiresAt:1000+pairingLifetime,closedAt:null,deviceId:null};expect(parseDevicePairing(pairing)).toEqual(pairing);
 for(const patch of [{expiresAt:pairing.expiresAt+1},{mode:'owner'},{deviceId:id(5)},{token:'S'.repeat(43)}])expect(()=>parseDevicePairing({...pairing,...patch})).toThrow();
});
it('request and outcome responses remain bound to the original screen-owned secret hash and identity',async()=>{
 const tokenHash=await deviceSecretHash(newDeviceSecret()),expected={id:device.id,tokenHash},verification=deviceVerification(tokenHash),receipt={v:1,id:device.id,verification,expiresAt:1000+pairingLifetime};expect(parsePairingRequest(receipt,expected)).toEqual(receipt);
 expect(parsePairingOutcome({...receipt,state:'waiting'},expected).state).toBe('waiting');expect(parsePairingOutcome({v:1,id:device.id,state:'approved',device,outletNameJson:JSON.stringify('Shop')},expected).state).toBe('approved');
 expect(()=>parsePairingRequest({...receipt,id:id(6)},expected)).toThrow();expect(()=>parsePairingRequest({...receipt,verification:'0000-0000-0000-0000'},expected)).toThrow();expect(()=>parsePairingOutcome({v:1,id:device.id,state:'approved',device:{...device,id:id(6)},outletNameJson:'"Shop"'},expected)).toThrow();
});
it('the staff directory retains literal text and cannot change the device scope or smuggle contact data',()=>{
 const name='বাংলা <script>inert</script>'+String.fromCharCode(0,0xd800),page={v:1,device,outletNameJson:JSON.stringify('Shop'),members:[{id:id(7),nameJson:JSON.stringify(name)}],next:null};expect(JSON.parse(parseDeviceDirectory(page,device).members[0].nameJson)).toBe(name);
 for(const patch of [{device:{...device,outletId:id(3)}},{device:{...device,mode:'counter'}},{device:{...device,revokedAt:1001}},{phone:'PRIVATE'},{members:[{...page.members[0],phone:'PRIVATE'}]},{members:[{id:id(7),nameJson:'unquoted'}]}])expect(()=>parseDeviceDirectory({...page,...patch},device)).toThrow();
});
it('staff page ordering, bounded limits and continuation identity are checked before use',()=>{
 const member={id:id(7),nameJson:'"Person"'},page={v:1,device,outletNameJson:'"Shop"',members:[member],next:id(7)};expect(parseDeviceDirectory(page,device,null,1).next).toBe(id(7));
 expect(()=>parseDeviceDirectory({...page,next:id(8)},device,null,1)).toThrow();expect(()=>parseDeviceDirectory({...page,members:[member,member],next:null},device)).toThrow();expect(()=>parseDeviceDirectory({...page,next:null},device,id(8))).toThrow();expect(()=>parseDeviceDirectory(page,device,null,0)).toThrow();
});
it('runtime credentials accept only a publishable connection and cannot carry an Auth or staff PIN field',()=>{
 const credential={v:1,connection,device,token:'S'.repeat(43)};expect(parseSharedDeviceCredential(credential)).toEqual(credential);
 for(const patch of [{pin:'0042'},{jwt:'private.session.value'},{connection:{...connection,publishableKey:'sb_secret_test_only'}},{connection:{...connection,apiUrl:'https://screen.test/path'}}])expect(()=>parseSharedDeviceCredential({...credential,...patch})).toThrow();
});
it('setup links contain no device/session credential, even as an extra nested property',()=>{
 const link={v:1,connection,pairingId:id(10),code:'123456'};expect(parseScreenSetupLink(link)).toEqual(link);
 for(const patch of [{token:'S'.repeat(43)},{sessionToken:'S'.repeat(43)},{code:'123 456'},{connection:{...connection,token:'S'.repeat(43)}}])expect(()=>parseScreenSetupLink({...link,...patch})).toThrow();
});
it('staff sessions and checked access stay pinned to the original member/device/outlet, including their expiry',()=>{
 const session=parseStaffDeviceSession({id:id(8),token:'S'.repeat(43),deviceId:device.id,memberId:id(7),createdAt:1000,expiresAt:1000+deviceSessionLifetime},{deviceId:device.id,memberId:id(7)}),access={v:1,sessionId:session.id,deviceId:device.id,businessId:device.businessId,outletId:device.outletId,memberId:session.memberId,role:'kitchen',mode:'kitchen',permissions:['orders.read'],expiresAt:session.expiresAt};
 expect(parseStaffDeviceAccess(access,{device,session}).permissions).toEqual(['orders.read']);
 for(const patch of [{sessionId:id(9)},{outletId:id(9)},{memberId:id(9)},{expiresAt:session.expiresAt+1},{mode:'counter'},{role:'owner'}])expect(()=>parseStaffDeviceAccess({...access,...patch},{device,session})).toThrow();
 expect(()=>parseStaffDeviceSession({...session,pin:'0042'},{deviceId:device.id,memberId:id(7)})).toThrow();
});
it('admin responses cannot switch the operator/outlet or add private member fields',()=>{
 const expected={businessId:id(1),outletId:id(2),actorId:id(3)},page={v:1,...expected,actorRole:'owner',kind:'members',entries:[{id:id(7),nameJson:'"Person"',role:'staff',active:true,assigned:true,configured:true}],next:null};expect(parseDeviceAdminPage(page,expected,'members').kind).toBe('members');
 for(const patch of [{actorId:id(9)},{actorRole:'manager'},{outletId:id(9)},{entries:[{...page.entries[0],phone:'PRIVATE'}]},{entries:[{...page.entries[0],configured:'true'}]}])expect(()=>parseDeviceAdminPage({...page,...patch},expected,'members')).toThrow();
 expect(()=>parseDeviceAdminPage({...page,kind:'devices',entries:[{...device,outletId:id(9)}]},expected,'devices')).toThrow();
});
