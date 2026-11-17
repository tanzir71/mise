import {cloudUploadFixture,uploadId} from './cloud-upload-fixture';
import {cloudUploadManifestHash,prepareCloudUpload} from '../packages/core/cloud-upload';
import {prepareCloudMigration} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
/** Synthetic data only; a hosted SQL role test must roll back its Auth/domain rows. */
export async function initialUploadHostedFixture(){
  const subject='00000000-0000-4000-8000-000000005001',source=cloudUploadFixture(),plan=await prepareCloudUpload(source,uploadId(7001)),migration=await prepareCloudMigration(source,subject);
  const parts=[];for(const blob of plan.chunks){const bytes=new Uint8Array(await blob.arrayBuffer());let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);parts.push(btoa(raw));}
  return {subject,phone:'14155550199',manifest:plan.manifest,manifestText:JSON.stringify(plan.manifest),manifestHash:await cloudUploadManifestHash(plan.manifest),parts,records:migration.records,files:migration.files,eventId:newInboxId(),leaseId:uploadId(7002),itemId:source.tables.items[0].id,itemNameJson:JSON.stringify(source.tables.items[0].name)};
}
