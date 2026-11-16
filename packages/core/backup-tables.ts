import type * as M from './models';

export const BACKUP_SCHEMA_VERSION = 8;
export const BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export interface BackupTables {
  businesses:M.Business[];outlets:M.Outlet[];members:M.Member[];categories:M.Category[];items:M.Item[];events:M.AuditEvent[];
  sales:M.Sale[];customers:M.Customer[];creditAccounts:M.CreditAccount[];creditEntries:M.CreditEntry[];
  orders:M.Order[];orderNotes:M.OrderNote[];orderCommunications:M.OrderCommunication[];orderRefunds:M.OrderRefund[];
  stockItems:M.StockItem[];stockMoves:M.StockMove[];suppliers:M.Supplier[];supplierMessages:M.SupplierMessage[];dayClosings:M.DayClosing[];purchases:M.Purchase[];
}
export const backupTableNames = [
  'businesses','outlets','members','categories','items','events','sales','customers','creditAccounts','creditEntries',
  'orders','orderNotes','orderCommunications','orderRefunds','stockItems','stockMoves','suppliers','supplierMessages','dayClosings','purchases',
] as const satisfies readonly (keyof BackupTables)[];
export type BackupTable = typeof backupTableNames[number];
export interface MiseBackup {
  format:'mise-backup';formatVersion:typeof BACKUP_FORMAT_VERSION;schemaVersion:typeof BACKUP_SCHEMA_VERSION;
  exportedAt:number;tables:BackupTables;
}
export function emptyBackupTables():BackupTables {
  return Object.fromEntries(backupTableNames.map(name => [name,[]])) as unknown as BackupTables;
}
