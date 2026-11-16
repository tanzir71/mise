import { useEffect,useMemo,useRef,useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { buildExportReport,exportDatasets,type ExportDataset,type ExportOptions,type ExportReport } from '@mise/core/exports';
import { dayKey } from '@mise/core/today';
import type { ExportPeriodInput } from '@mise/core/export-period';
import type { SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { reportFile,downloadFile,shareFile,exportFilename } from './data/export-files';
import { errorText } from './khata-data';
import { useTodayClock } from './today-data';

export const exportMeta = [
  {id:'orders',name:'Orders',icon:'receipt',detail:'Items, status, fulfilment and payment'},
  {id:'sales',name:'Sales',icon:'wallet',detail:'Cash, wallets, card, credit and refunds'},
  {id:'stock',name:'Stock moves',icon:'package',detail:'Counts, usage, receipts, waste and corrections'},
  {id:'purchases',name:'Purchases',icon:'clipboard',detail:'Recorded supplier invoices, prices and payment'},
  {id:'credit',name:'Credit',icon:'history',detail:'Charges, payments and running balances'},
  {id:'customers',name:'Customers',icon:'heart',detail:'Contact details, notes and current balances'},
] as const;
export const initialColumns:Record<ExportDataset,string[]> = {
  orders:['number','created','customer','source','status','items','payment','total','currency'],
  sales:['kind','created','order','who','method','status','amount','netSales','cashMovement','currency'],
  credit:['created','customer','type','status','delta','balance','currency','note'],
  stock:['created','name','unit','delta','after','reason','status'],
  customers:['name','phone','address','balances','status'],
  purchases:['created','supplier','reference','items','amount','currency','paid','status'],
};
export function usePhoneExport() {
  const [phone,setPhone]=useState(()=>matchMedia('(max-width:767px)').matches);
  useEffect(()=>{const media=matchMedia('(max-width:767px)'),update=()=>setPhone(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);return phone;
}
export function useExportController(setup:SetupSnapshot) {
  const snapshot=useLiveQuery(async()=>{try{return {data:await db.readBackup(),error:''};}catch(error){return {data:null,error:errorText(error)};}},[]),now=useTodayClock();
  const [datasets,setDatasets]=useState<ExportDataset[]>(()=>matchMedia('(max-width:767px)').matches?['orders','sales']:['orders']),[preset,setPreset]=useState<ExportPeriodInput['preset']>('week'),[from,setFrom]=useState(()=>dayKey(Date.now(),setup.outlet.timezone)),[to,setTo]=useState(()=>dayKey(Date.now(),setup.outlet.timezone)),[format,setFormat]=useState<'xlsx'|'csv'|'pdf'>('xlsx'),[destination,setDestination]=useState<'download'|'share'>('download'),[includePhones,setIncludePhones]=useState(false),[columns,setColumns]=useState(initialColumns);
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[ready,setReady]=useState<File|null>(null),[printReport,setPrintReport]=useState<ExportReport|null>(null),busy=useRef(false);
  const period:ExportPeriodInput = useMemo(()=>preset==='custom'?{preset,from,to}:{preset},[preset,from,to]);
  const options:ExportOptions = useMemo(()=>({datasets,period,includePhones,columns}),[datasets,period,includePhones,columns]);
  const view=useMemo(()=>{if(!snapshot?.data)return {report:null,all:null,error:snapshot?.error||''};try{return {report:buildExportReport(snapshot.data,options,now),all:buildExportReport(snapshot.data,{...options,columns:undefined},now),error:''};}catch(error){return {report:null,all:null,error:errorText(error)};}},[snapshot,options,now]);
  function reset(){setReady(null);setMessage('');setError('');}
  function toggleDataset(id:ExportDataset){reset();setDatasets(before=>before.includes(id)?before.filter(key=>key!==id):[...before,id]);}
  function selectAll(){reset();setDatasets([...exportDatasets]);}
  function changePeriod(value:ExportPeriodInput['preset']){reset();setPreset(value);}
  function changeFrom(value:string){reset();setFrom(value);}
  function changeTo(value:string){reset();setTo(value);}
  function changeFormat(value:typeof format){reset();setFormat(value);if(value==='pdf')setDestination('download');}
  function changeDestination(value:typeof destination){reset();setDestination(value);}
  function changePhones(value:boolean){reset();setIncludePhones(value);}
  function toggleColumn(dataset:ExportDataset,key:string){reset();setColumns(before=>({...before,[dataset]:before[dataset].includes(key)?before[dataset].filter(id=>id!==key):[...before[dataset],key]}));}
  async function prepare(all = false) {
    if(busy.current)return;busy.current=true;setSaving(true);setError('');setMessage('');setReady(null);
    try {
      const data=await db.readBackup(),selected:ExportOptions=all?{datasets:[...exportDatasets],period:{preset:'all'},includePhones}:options,kind=all?'csv':format,report=buildExportReport(data,selected);
      if(kind==='pdf') {
        await db.recordPreparedExport({outletId:data.tables.outlets[0].id,actorId:data.tables.members.find(member=>member.active)!.id,format:'pdf',datasets:selected.datasets,rows:report.rowCount,filename:exportFilename('report',report.createdAt,'pdf'),capturedAt:report.createdAt,from:report.period.from,to:report.period.to,includePhones});setPrintReport(report);
      } else {
        const file=await reportFile(report,kind);await db.recordPreparedExport({outletId:data.tables.outlets[0].id,actorId:data.tables.members.find(member=>member.active)!.id,format:file.name.endsWith('.zip')?'zip':kind,datasets:selected.datasets,rows:report.rowCount,filename:file.name,capturedAt:report.createdAt,from:report.period.from,to:report.period.to,includePhones});setReady(file);
        if(!all && destination==='share'){if(await shareFile(file))setMessage('File handed to the share sheet.');}
        else {downloadFile(file);setMessage(`Download started: ${report.rowCount} ${report.rowCount===1?'row':'rows'}.`);}
      }
    }catch(error){setError(errorText(error));}finally{busy.current=false;setSaving(false);}
  }
  async function shareReady(){if(!ready)return;setError('');try{if(await shareFile(ready))setMessage('File handed to the share sheet.');}catch(error){setError(errorText(error));}}
  return {datasets,preset,from,to,format,destination,includePhones,columns,saving,error,message,ready,printReport,setPrintReport,view,loading:snapshot===undefined,busy,toggleDataset,selectAll,changePeriod,changeFrom,changeTo,changeFormat,changeDestination,changePhones,toggleColumn,prepare,shareReady};
}
