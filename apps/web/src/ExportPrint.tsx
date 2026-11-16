import { useEffect,useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@mise/ui/primitives.tsx';
import { Modal } from '@mise/ui/Modal.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import { formatMoney } from '@mise/core/money';
import { exportCellText,type ExportReport,type ExportColumn,type ExportTable } from '@mise/core/exports';
import './export-print.css';

function groups(table:ExportTable):ExportColumn[][] {
  const parts:ExportColumn[][] = [];for (let i=0;i<table.columns.length;i+=5) parts.push(table.columns.slice(i,i+5));return parts;
}
function ReportTables({report,preview = false}:{report:ExportReport;preview?:boolean}) {
  return <>{report.tables.map(table => <section key={table.dataset} className="export-report-section"><h2>{table.name} · {table.rows.length} {table.rows.length===1?'row':'rows'}</h2>{groups(table).map((columns,part) => <table key={part}><caption>{table.name}{table.columns.length>5 ? ` · ${part+1} of ${Math.ceil(table.columns.length/5)}` : ''}</caption><thead><tr><th scope="col">Row</th>{columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead><tbody>{(preview ? table.rows.slice(0,3) : table.rows).map((row,index) => <tr key={index}><th scope="row">{index+1}</th>{columns.map(column => {const value=row[column.key] ?? null;return <td key={column.key}>{value !== null && typeof value==='object' ? formatMoney(value.minor,value.currency) : exportCellText(value)}</td>;})}</tr>)}{table.rows.length===0 ? <tr><td colSpan={columns.length+1}>No records in this period.</td></tr> : null}</tbody></table>)}{preview && table.rows.length>3 ? <p>Preview shows 3 rows. The PDF includes all {table.rows.length} rows.</p> : null}</section>)}</>;
}
export function ExportPrint({report,onClose}:{report:ExportReport;onClose:()=>void}) {
  const [error,setError] = useState('');
  useEffect(() => {const title=document.title;document.title=`Mise export - ${report.shopName}`;document.body.classList.add('mise-export-printing');return () => {document.body.classList.remove('mise-export-printing');document.title=title;};},[report]);
  async function print() {try {await document.fonts.ready;window.print();}catch{setError('Printing is unavailable here. Export CSV or Excel to keep the same records.');}}
  return <><Modal open title="Print report" closeLabel="Close print preview" onClose={onClose}><div className="export-print-preview"><p>{report.shopName} · {report.rowCount} rows · {report.timezone}</p><p>Choose Save as PDF in your browser’s print options. All selected rows and columns are included.</p><Button onClick={() => void print()}><MiseIcon name="download" size={16} />Print / Save PDF</Button>{error ? <p role="alert" className="form-error">{error}</p> : null}<details><summary>Preview selected records</summary><ReportTables report={report} preview /></details></div></Modal>{createPortal(<article className="export-print-document"><header><h1>{report.shopName}</h1><p>Mise export · {report.outletName} · {report.rowCount} rows</p><p>{report.period.from || 'All dates'} to {report.period.to || 'all dates'} · {report.timezone}</p><p>Prepared {new Date(report.createdAt).toISOString()}</p></header><ReportTables report={report} /><footer>{report.notes.map(note => <p key={note}>{note}</p>)}</footer></article>,document.body)}</>;
}
