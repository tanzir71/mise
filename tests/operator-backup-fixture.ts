import {reportBackupFixture} from './report-backup-fixture';
import {createBackup} from '../packages/core/backup';
import {newInboxId} from '../packages/core/inbox';
/** Recovery-only fixture: owner, assigned manager and staff are never promoted. */
export function operatorBackupFixture(){
 const source=reportBackupFixture(),owner=source.tables.members[0],outlet=source.tables.outlets[0];owner.outletIds=[];
 source.tables.outlets.push({...outlet,id:newInboxId(),name:'Second outlet'});
 const manager={...owner,id:'00000000000000000000000001',name:'Mina manager',role:'manager' as const,outletIds:[outlet.id],phone:'+8801812345482'};
 source.tables.members.push(manager,{...manager,id:newInboxId(),name:'Team member',role:'staff',phone:'+8801912345482'});
 return createBackup(source.tables,source.exportedAt);
}
