import {parseCloudConnection,type CloudConnection} from './cloud-connection';
import {isDeviceId,isDeviceToken,pairingCode,parsePairingRequest,parseSharedDeviceCredential,parseStaffDeviceSession,type PairingRequest,type SharedDeviceCredential,type StaffDeviceSession} from './device-access';

export interface ScreenPairingSource {connection:CloudConnection;requestId:string;token:string;tokenHash:string;code:string;pairingId:string|null}
export interface ScreenEnrollment {credential:SharedDeviceCredential;outletNameJson:string}
export type ScreenState=
 |{phase:'empty'}
 |{phase:'pairing';source:ScreenPairingSource;receipt:PairingRequest|null}
 |({phase:'enrolled'}&ScreenEnrollment)
 |({phase:'signing-in';attemptId:string;memberId:string}&ScreenEnrollment)
 |({phase:'signed-in';attemptId:string;session:StaffDeviceSession}&ScreenEnrollment)
 |({phase:'resetting';id:string;attemptId:string|null;forget:boolean}&ScreenEnrollment);
export interface ScreenJournalRecord {v:1;id:'current';revision:string;state:ScreenState}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
/** Credentials are allowed only in this dedicated device record. This schema
 * never becomes a shop row, portable backup, audit, QR or URL parameter. */
export function parseScreenState(value:unknown):ScreenState{
 if(!object(value))throw Error('Review this screen’s saved setup.');
 if(value.phase==='empty'&&exact(value,'phase'))return {phase:'empty'};
 if(value.phase==='pairing'&&exact(value,'phase,source,receipt')){
  const s=value.source;if(!object(s)||!exact(s,'connection,requestId,token,tokenHash,code,pairingId')||!isDeviceId(s.requestId)||!isDeviceToken(s.token)||typeof s.tokenHash!=='string'||!(/^[a-f0-9]{64}$/).test(s.tokenHash)||typeof s.code!=='string'||s.code!==pairingCode(s.code)||s.pairingId!==null&&!isDeviceId(s.pairingId)||s.requestId===s.pairingId)throw Error('Keep the complete original screen request.');
  const source:ScreenPairingSource={connection:parseCloudConnection(s.connection),requestId:s.requestId,token:s.token,tokenHash:s.tokenHash,code:s.code,pairingId:s.pairingId as string|null};
  return {phase:'pairing',source,receipt:value.receipt===null?null:parsePairingRequest(value.receipt,{id:source.requestId,tokenHash:source.tokenHash})};
 }
 if(!['enrolled','signing-in','signed-in','resetting'].includes(value.phase as string))throw Error('Review the current screen state.');
 const credential=parseSharedDeviceCredential(value.credential);if(credential.device.revokedAt!==null||typeof value.outletNameJson!=='string')throw Error('Review this screen’s enrollment.');
 try{if(typeof JSON.parse(value.outletNameJson)!=='string')throw Error();}catch{throw Error('Keep the original outlet name.');}
 const enrollment={credential,outletNameJson:value.outletNameJson};
 if(value.phase==='enrolled'&&exact(value,'phase,credential,outletNameJson'))return {phase:'enrolled',...enrollment};
 if(value.phase==='signing-in'&&exact(value,'phase,credential,outletNameJson,attemptId,memberId')&&isDeviceId(value.attemptId)&&isDeviceId(value.memberId)&&value.attemptId!==credential.device.id)return {phase:'signing-in',...enrollment,attemptId:value.attemptId,memberId:value.memberId};
 if(value.phase==='signed-in'&&exact(value,'phase,credential,outletNameJson,attemptId,session')&&isDeviceId(value.attemptId)&&value.attemptId!==credential.device.id&&object(value.session)&&isDeviceId(value.session.memberId))return {phase:'signed-in',...enrollment,attemptId:value.attemptId,session:parseStaffDeviceSession(value.session,{deviceId:credential.device.id,memberId:value.session.memberId})};
 if(value.phase==='resetting'&&exact(value,'phase,credential,outletNameJson,id,attemptId,forget')&&isDeviceId(value.id)&&value.id!==credential.device.id&&(value.attemptId===null||isDeviceId(value.attemptId)&&value.attemptId!==credential.device.id&&value.attemptId!==value.id)&&typeof value.forget==='boolean')return {phase:'resetting',...enrollment,id:value.id,attemptId:value.attemptId as string|null,forget:value.forget};
 throw Error('Keep the complete original screen state.');
}
export function parseScreenJournalRecord(value:unknown):ScreenJournalRecord{
 if(!object(value)||!exact(value,'v,id,revision,state')||value.v!==1||value.id!=='current'||!isDeviceId(value.revision))throw Error('Review this screen’s saved setup.');
 return {v:1,id:'current',revision:value.revision,state:parseScreenState(value.state)};
}
