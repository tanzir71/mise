import { utils, writeXLSX, type CellObject } from 'xlsx';
import { exportCellText, type ExportCell, type ExportReport } from '@mise/core/exports';

/** This wrapper is dynamically imported by the export UI, keeping spreadsheet code out of the app shell. */
export function exportXlsx(report:ExportReport):Blob {
  const workbook = utils.book_new();
  workbook.Props = {Title:`${report.shopName} - Mise export`,Author:report.shopName,CreatedDate:new Date(report.createdAt)};
  const readme = utils.aoa_to_sheet([
    ['Mise export',report.shopName],['Outlet',report.outletName],['Created UTC',new Date(report.createdAt).toISOString()],['Timezone',report.timezone],
    ['From',report.period.from || 'All dates'],['Through',report.period.to || 'All dates'],['Rows',report.rowCount],
    ...report.notes.map(note => ['Note',note]),['Note','Amounts needing more than 15 digits are text, preserving every minor unit.'],
  ]);
  readme['!cols'] = [{wch:18},{wch:100}];utils.book_append_sheet(workbook,readme,'Read me');
  function cell(value:ExportCell):CellObject {
    if (value === null) return {t:'z'};
    const text = exportCellText(value);
    if (typeof value === 'object') {
      const digits = text.replace(/[-.]/g,'').replace(/^0+/,''), decimals = text.split('.')[1]?.length || 0;
      if (digits.length > 15) return {t:'s',v:text};
      return {t:'n',v:Number(text),z:decimals ? `0.${'0'.repeat(decimals)}` : '0'};
    }
    return typeof value === 'number' ? {t:'n',v:value} : {t:'s',v:value};
  }
  for (const table of report.tables) {
    if (table.rows.length >= 1048576) throw new Error('This sheet exceeds Excel’s row limit. Choose a smaller date range.');
    const sheet = utils.aoa_to_sheet([table.columns.map(c => c.label)]);
    table.rows.forEach((row,index) => table.columns.forEach((column,col) => {sheet[utils.encode_cell({r:index+1,c:col})] = cell(row[column.key] ?? null);}));
    sheet['!ref'] = utils.encode_range({s:{r:0,c:0},e:{r:table.rows.length,c:table.columns.length-1}});
    sheet['!autofilter'] = {ref:sheet['!ref']};
    sheet['!cols'] = table.columns.map(column => ({wch:Math.min(60,Math.max(14,column.label.length+2,...table.rows.slice(0,100).map(row => exportCellText(row[column.key] ?? null).split('\n').reduce((max,line) => Math.max(max,line.length),0))))}));
    utils.book_append_sheet(workbook,sheet,table.name);
  }
  return new Blob([writeXLSX(workbook,{type:'array',compression:true})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
