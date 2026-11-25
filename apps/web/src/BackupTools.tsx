import { useRef,useState,type ChangeEvent } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { backupCounts,type BackupPreview } from '@mise/core/backup';
import { MAX_BACKUP_BYTES,backupTableNames,type BackupTable } from '@mise/core/backup-tables';
import type { SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { backupFile,canShareFile,downloadFile,shareFile } from './data/export-files';
import { errorText } from './khata-data';
import './exports.css';

const tableLabels:Record<BackupTable,string> = {businesses:'Shops',outlets:'Outlets',members:'Members',categories:'Categories',items:'Catalogue items',events:'Recorded actions',sales:'Sales',customers:'Customers',creditAccounts:'Credit accounts',creditEntries:'Credit entries',orders:'Orders',orderNotes:'Order notes',orderCommunications:'Order contact records',orderRefunds:'Refunds',stockItems:'Stock items',stockMoves:'Stock moves',suppliers:'Suppliers',supplierMessages:'Supplier contact records',dayClosings:'Day summaries',purchases:'Purchases',inboxItems:'Shared inbox items',payments:'Payment sources'};
export function BackupTools({setup,recovery=false}:{setup?:SetupSnapshot;recovery?:boolean}) {
  const [preview,setPreview] = useState<BackupPreview|null>(null),[text,setText] = useState(''),[filename,setFilename] = useState(''),[confirmed,setConfirmed] = useState(false),[saving,setSaving] = useState(false),[error,setError] = useState(''),[message,setMessage] = useState(''),[ready,setReady] = useState<File|null>(null),[backupFallback,setBackupFallback]=useState(false);
  const busy = useRef(false),fileInput = useRef<HTMLInputElement>(null);
  async function backup(share = false) {
    if (busy.current) return;busy.current=true;setSaving(true);setError('');setMessage('');setReady(null);setBackupFallback(false);
    let prepared:File|undefined,historySaved=false;
    try {
      const snapshot=await db.readBackup(),file=backupFile(snapshot);
      prepared=file;setReady(file);
      if (setup) await db.recordPreparedExport({outletId:setup.outlet.id,actorId:setup.owner.id,format:'json',datasets:[],rows:Object.values(backupCounts(snapshot)).reduce((a,b)=>a+b,0),filename:file.name,capturedAt:snapshot.exportedAt,from:null,to:null,includePhones:true});
      historySaved=true;
      if (preview) {setConfirmed(false);setPreview(await db.previewRestore(text));}
      if (share) {const opened=await shareFile(file);if (opened) setMessage('Backup handed to the share sheet.');}
      else {downloadFile(file);setMessage('Backup download started. Keep the JSON file to restore your shop.');}
    }catch(error){if(prepared){setBackupFallback(true);setError(historySaved?'Your prepared backup is ready. Try downloading it below.':'Your backup is ready, but its history could not be saved. Download the prepared file below.');}else setError(errorText(error));}finally{busy.current=false;setSaving(false);}
  }
  function downloadPreparedBackup(){if(!ready||busy.current)return;try{downloadFile(ready);setError('');setMessage('Prepared backup download started. Keep the JSON file to restore your shop.');}catch{setError('The prepared file could not be downloaded. Try again.');}}
  const preparedBackup=ready&&backupFallback?<Button kind="secondary" disabled={saving} onClick={downloadPreparedBackup}>Download prepared backup</Button>:null;
  async function select(event:ChangeEvent<HTMLInputElement>) {
    const file=event.target.files?.[0];event.target.value='';if (!file || busy.current) return;
    busy.current=true;setSaving(true);setError('');setConfirmed(false);setMessage('');
    try {
      if (file.size>MAX_BACKUP_BYTES) throw new Error('Choose a backup smaller than 50 MB.');
      const contents=await file.text(),review=await db.previewRestore(contents);setText(contents);setFilename(file.name);setPreview(review);
    }catch(error){setError(errorText(error));}finally{busy.current=false;setSaving(false);}
  }
  async function refresh() {
    if (busy.current) return;busy.current=true;setSaving(true);setConfirmed(false);setError('');
    try {setPreview(await db.previewRestore(text));}catch(error){setError(errorText(error));}finally{busy.current=false;setSaving(false);}
  }
  async function restore() {
    if (!preview || !confirmed || busy.current) return;busy.current=true;setSaving(true);setError('');
    try {await db.restoreBackup(text,preview);location.assign(import.meta.env.BASE_URL);}catch(error){setError(errorText(error));setConfirmed(false);}finally{busy.current=false;setSaving(false);}
  }
  return <div className="backup-tools"><p>A JSON backup keeps your complete shop, including history and full phone numbers. Reports and their date filters do not limit it.</p>{setup||recovery ? <div className="export-actions"><Button kind="secondary" disabled={saving} onClick={()=>void backup()}><MiseIcon name="download" size={16} />Download JSON backup</Button>{typeof navigator.share==='function' ? <Button kind="secondary" disabled={saving} onClick={()=>void backup(true)}>Share backup</Button> : null}</div> : null}<label className="button button-secondary backup-file-label"><MiseIcon name="database" size={16} />Choose JSON backup<input ref={fileInput} type="file" accept=".json,application/json" disabled={saving} onChange={event=>void select(event)} /></label>{saving && !preview ? <p role="status">Preparing backup…</p> : null}{!preview && error ? <p role="alert" className="form-error">{error}</p> : null}{!preview?preparedBackup:null}{!preview && message ? <p role="status">{message}</p> : null}{ready && canShareFile(ready) ? <Button kind="ghost" onClick={()=>void shareFile(ready).catch(error=>setError(errorText(error)))}>Share prepared backup</Button> : null}<Modal open={preview!==null} title="Restore backup" closeLabel="Close restore preview" variant="sheet" onClose={()=>{if (!busy.current) {setPreview(null);setError('');setConfirmed(false);}}}>{preview ? <div className="restore-preview"><p className="export-eyebrow">{filename}</p><h3>{preview.shopName}</h3><p>{preview.outletName} · {preview.currency} · {preview.timezone}</p><p>Backup from {new Intl.DateTimeFormat('en-GB',{timeZone:preview.timezone,dateStyle:'medium',timeStyle:'short'}).format(preview.exportedAt)}.</p><dl className="restore-counts"><div><dt>Orders</dt><dd>{preview.counts.orders}</dd></div><div><dt>Sales</dt><dd>{preview.counts.sales}</dd></div><div><dt>Customers</dt><dd>{preview.counts.customers}</dd></div></dl><details><summary>See all {preview.records} records</summary><dl className="restore-all-counts">{backupTableNames.map(name=><div key={name}><dt>{tableLabels[name]}</dt><dd>{preview.counts[name]}</dd></div>)}</dl></details><p>{preview.replacesShopName ? `This replaces ${preview.replacesShopName} and its data in this browser. Download a current backup first if you need to keep it.` : 'This restores the shop on this browser. All records stay on this device.'}</p>{setup ? <Button kind="secondary" disabled={saving} onClick={()=>void backup()}>Download current backup</Button> : null}{message ? <p role="status">{message} Review and confirm the replacement below.</p> : null}<label className="export-checkbox"><input type="checkbox" checked={confirmed} disabled={saving} onChange={event=>setConfirmed(event.target.checked)} />{preview.replacesShopName ? 'Replace data in this browser with this backup' : 'Restore this shop on this browser'}</label>{error ? <><p role="alert" className="form-error">{error}</p><Button kind="secondary" disabled={saving} onClick={()=>void refresh()}>Review latest data</Button></> : null}{preparedBackup}<footer className="sheet-actions"><Button disabled={!confirmed || saving} onClick={()=>void restore()}>{saving ? 'Restoring…' : 'Restore this backup'}</Button></footer></div> : null}</Modal></div>;
}
export function RestorePage({onBack}:{onBack:()=>void}) {
  return <main className="onboarding"><section className="card onboarding-card"><h1>Restore your shop</h1><p>Choose a Mise JSON backup. You can review its shop and records before restoring.</p><BackupTools /><Button kind="ghost" onClick={onBack}>Back to setup</Button></section></main>;
}
