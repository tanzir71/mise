import {newInboxId} from '../packages/core/inbox';
import {cloudConnectionTarget} from '../packages/core/cloud-connection';
import {operatorAccountHash} from '../packages/core/operators';
import {parseSyncScope} from '../packages/core/sync-read';
import {syncCoverageIntents,type SyncCoverageSource,type SyncCoveragePage,type SyncCoverageFact} from '../packages/core/sync-coverage';
import type {MoneyCommand} from '../packages/core/money-commands';
export const coverageConfig={apiUrl:'https://coverage.test',publishableKey:'sb_publishable_test_only'},coverageScope='/mise/app/shop',coverageUid='00000000-0000-4000-8000-000000000001';
export function coverageCash(outletId=newInboxId()):Extract<MoneyCommand,{type:'sale.record'}>{return {id:newInboxId(),outletId,occurredAt:1,type:'sale.record',saleId:newInboxId(),input:{expression:'5',method:'cash',wallet:null,given:null,who:'আসল\0\ud800',items:[]}};}
export async function coverageSource(){
 const target={targetHash:await cloudConnectionTarget(coverageConfig,coverageScope,coverageUid),accountHash:await operatorAccountHash(coverageUid),businessId:newInboxId(),outletId:newInboxId(),actorId:newInboxId(),role:'manager' as const},command=coverageCash(target.outletId),readId=newInboxId(),window={...target,epoch:'00000000-0000-4000-8000-000000000002',scopeVersion:'00000000-0000-4000-8000-000000000003',v:1 as const,id:readId,createdAt:1,expiresAt:1000};delete (window as Partial<typeof window>).targetHash;
 const source:SyncCoverageSource={version:1,readId,readSourceHash:'a'.repeat(64),readSeal:'b'.repeat(64),target,window,cursor:'original-signed-cursor',intents:await syncCoverageIntents([command])};return {source,command};
}
export function coverageReply(source:SyncCoverageSource,state:SyncCoverageFact['state']='visible'):SyncCoveragePage{return {...parseSyncScope(source.window),v:1,id:source.readId,ids:source.intents.map(c=>c.id),coverage:source.intents.map(c=>({id:c.id,type:state==='absent'?null:c.type,state,requestHash:state==='absent'?null:c.requestHash})),cursor:source.cursor};}
