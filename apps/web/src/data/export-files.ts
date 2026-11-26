import type {NativePaymentBackup} from '@mise/core/native-payment-backup';
import {MAX_BACKUP_BYTES} from '@mise/core/backup-tables';
import { zipSync,strToU8 } from 'fflate';
import { exportCsv,type ExportReport } from '@mise/core/exports';
import type { PortableBackup } from '@mise/core/payment-archive';

export type DownloadFormat = 'xlsx'|'csv';
export function exportFilename(kind:string,at:number,extension:string):string {return `mise-${kind}-${new Date(at).toISOString().slice(0,10)}.${extension}`;}
export async function reportFile(report:ExportReport,format:DownloadFormat):Promise<File> {
  if (format === 'xlsx') {
    const {exportXlsx} = await import('./export-xlsx');return new File([exportXlsx(report)],exportFilename('export',report.createdAt,'xlsx'),{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  if (report.tables.length === 1) return new File([exportCsv(report.tables[0])],exportFilename(report.tables[0].dataset,report.createdAt,'csv'),{type:'text/csv;charset=utf-8'});
  const entries:Record<string,Uint8Array> = {};
  for (const table of report.tables) entries[`${table.dataset}.csv`] = strToU8(exportCsv(table));
  entries['readme.txt'] = strToU8([report.shopName,report.outletName,`Period: ${report.period.from || 'all dates'} to ${report.period.to || 'all dates'}`,`Timezone: ${report.timezone}`,...report.notes].join('\r\n'));
  const bytes = zipSync(entries,{level:1});
  return new File([bytes],exportFilename('export',report.createdAt,'zip'),{type:'application/zip'});
}
export function backupFile(backup:PortableBackup|NativePaymentBackup):File {let text=JSON.stringify(backup,null,backup.formatVersion>=2?undefined:2);if(new TextEncoder().encode(text).length>MAX_BACKUP_BYTES)text=JSON.stringify(backup);if(new TextEncoder().encode(text).length>MAX_BACKUP_BYTES)throw Error('Keep a complete backup within the 50 MB limit.');return new File([text],exportFilename('backup',backup.exportedAt,'json'),{type:'application/json'});}
export function downloadFile(file:File):void {
  const url = URL.createObjectURL(file),link = document.createElement('a');link.href = url;link.download = file.name;link.click();setTimeout(() => URL.revokeObjectURL(url),60000);
}
export function canShareFile(file:File):boolean {try {return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({files:[file]});}catch{return false;}}
export async function shareFile(file:File):Promise<boolean> {
  if (!canShareFile(file)) throw new Error('File sharing is unavailable here. Download the file and attach it in your chosen app.');
  try {await navigator.share({files:[file],title:'Mise export'});return true;}catch(error){if (error instanceof Error && error.name === 'AbortError') return false;throw error;}
}
