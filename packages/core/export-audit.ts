import { ulid } from 'ulid';
import { validateShop } from './shop-access';
import { exportDatasets, type ExportDataset } from './exports';
import type { AuditEvent,SetupSnapshot } from './models';

export interface ExportAuditInput {
  outletId:string;actorId:string;
  format:'csv'|'xlsx'|'pdf'|'json'|'zip';datasets:ExportDataset[];rows:number;filename:string;capturedAt:number;
  from:string|null;to:string|null;includePhones:boolean;
}
export function exportPreparedCommand(input:ExportAuditInput,setup:SetupSnapshot,at = Date.now()):AuditEvent {
  validateShop(setup);
  if(input.outletId!==setup.outlet.id || input.actorId!==setup.owner.id) throw new Error('The shop or owner changed. Prepare the export again.');
  if (!['csv','xlsx','pdf','json','zip'].includes(input.format) || input.datasets.some(key => !exportDatasets.includes(key)) || new Set(input.datasets).size !== input.datasets.length || !Number.isSafeInteger(input.rows) || input.rows < 0) throw new Error('Choose a supported export.');
  if (!input.filename || input.filename.length > 160 || /[\/\\\u0000-\u001f]/.test(input.filename) || !Number.isSafeInteger(input.capturedAt) || input.capturedAt < 0 || input.capturedAt > at) throw new Error('The prepared export has invalid file details.');
  if(typeof input.includePhones!=='boolean' || (input.format!=='json' && input.datasets.length===0)) throw new Error('Choose the export data and phone preference.');
  return {id:ulid(at),outletId:setup.outlet.id,actor:{type:'member',id:setup.owner.id},command:'export.prepare',before:null,after:{format:input.format,datasets:[...input.datasets],rows:input.rows,filename:input.filename,capturedAt:input.capturedAt,from:input.from,to:input.to,includePhones:input.includePhones},at};
}
