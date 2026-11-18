import { ulid } from 'ulid';
import { validateShop,type ShopSetup } from './shop-access';
import { exportDatasets, type ExportDataset } from './exports';
import type { AuditEvent } from './models';

export interface ExportAuditInput {
  outletId:string;actorId:string;
  format:'csv'|'xlsx'|'pdf'|'json'|'zip';datasets:ExportDataset[];rows:number;filename:string;capturedAt:number;
  from:string|null;to:string|null;includePhones:boolean;
}
export type ExportAuditDetails=Omit<ExportAuditInput,'outletId'|'actorId'>;
export function exportAuditDetails(input:ExportAuditDetails,at:number):ExportAuditDetails {
  if (!['csv','xlsx','pdf','json','zip'].includes(input.format) || !Array.isArray(input.datasets)||input.datasets.some(key => !exportDatasets.includes(key)) || new Set(input.datasets).size !== input.datasets.length || !Number.isSafeInteger(input.rows) || input.rows < 0) throw new Error('Choose a supported export.');
  if (typeof input.filename!=='string'||!input.filename || input.filename.length > 160 || /[\/\\\u0000-\u001f]/.test(input.filename) || !Number.isSafeInteger(input.capturedAt) || input.capturedAt < 0 || input.capturedAt > at) throw new Error('The prepared export has invalid file details.');
  if(typeof input.includePhones!=='boolean' || (input.format!=='json' && input.datasets.length===0)) throw new Error('Choose the export data and phone preference.');
  const day=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
  if((input.from!==null||input.to!==null)&&(!day(input.from)||!day(input.to)||input.from>input.to))throw new Error('Keep the prepared export dates in order.');
  return {format:input.format,datasets:[...input.datasets],rows:input.rows,filename:input.filename,capturedAt:input.capturedAt,from:input.from,to:input.to,includePhones:input.includePhones};
}
export function exportPreparedCommand(input:ExportAuditInput,setup:ShopSetup,at = Date.now(),newId:()=>string=()=>ulid(at)):AuditEvent {
  validateShop(setup);
  if(input.outletId!==setup.outlet.id || input.actorId!==setup.owner.id) throw new Error('The shop or owner changed. Prepare the export again.');
  return {id:newId(),outletId:setup.outlet.id,actor:{type:'member',id:setup.owner.id},command:'export.prepare',before:null,after:exportAuditDetails(input,at),at};
}
