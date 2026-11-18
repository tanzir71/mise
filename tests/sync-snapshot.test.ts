import {afterAll,beforeAll,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {parseSyncSnapshot,syncSnapshotDelta,syncTransactionVisible} from '../packages/core/sync-snapshot';
let db:PGlite;
beforeAll(async()=>{db=await PGlite.create();});afterAll(async()=>{await db?.close();});
it('visibility matches PostgreSQL across pending transactions, boundaries and values beyond Number precision',async()=>{
 for(const start of [1n,3n,2147483647n,4294967295n,9007199254740993n,18446744073709551590n]){
  const snapshot=`${start}:${start+20n}:${start+2n},${start+7n},${start+19n}`;
  for(const delta of [0n,1n,2n,6n,7n,8n,18n,19n,20n,21n]){const id=String(start+delta),r=await db.query<{visible:boolean}>('select pg_visible_in_snapshot($1::xid8,$2::pg_snapshot) visible',[id,snapshot]);expect(syncTransactionVisible(id,snapshot)).toBe(r.rows[0].visible);}
 }
});
it('a late commit remains in the next delta even when a later allocated row or transaction has already committed',()=>{const previous='10:15:10,12',current='12:18:12,16';expect(syncSnapshotDelta('10',previous,current)).toBe(true);expect(syncSnapshotDelta('14',previous,current)).toBe(false);expect(syncSnapshotDelta('12',previous,current)).toBe(false);expect(syncSnapshotDelta('17',previous,current)).toBe(true);expect(syncSnapshotDelta('16',previous,current)).toBe(false);expect(syncSnapshotDelta('18',previous,current)).toBe(false);});
it('first pull includes only complete transactions and exact cursor replay yields no delta',()=>{for(const id of ['0','9','10','11','12','13','14','15']){expect(syncSnapshotDelta(id,null,'10:15:10,12')).toBe(syncTransactionVisible(id,'10:15:10,12'));expect(syncSnapshotDelta(id,'10:15:10,12','10:15:10,12')).toBe(false);}});
it.each(['','0:2:','1:0:','1:2','2:1:','3:9:2','3:9:9','3:9:5,4','3:9:5,5','03:9:','3:09:','3:9:05','-1:2:','1:2:1,','1:18446744073709551616:','1:2: '+('1'.repeat(65536))])('rejects damaged or ambiguous snapshot case %#',value=>{expect(()=>parseSyncSnapshot(value)).toThrow();});
it.each(['-1','01','1.5','9007199254740993e0','18446744073709551616',9007199254740992])('rejects an ambiguous transaction identity %s',value=>{expect(()=>syncTransactionVisible(value,'3:9:')).toThrow();});
it.each(['9:16:12','10:14:12','10:17:11,12'])('keeps the previous cursor after a backwards snapshot %s',value=>{expect(()=>syncSnapshotDelta('12','10:15:10,12',value)).toThrow('backwards');});
it('does not expose mutable snapshot state to later caller changes',()=>{const snapshot=parseSyncSnapshot('3:9:4,7');expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.inProgress)).toBe(true);expect(snapshot.text).toBe('3:9:4,7');});
