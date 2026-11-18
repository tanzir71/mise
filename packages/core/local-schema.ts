import {backupTableNames} from './backup-tables';
import {localSyncTableNames} from './local-outbox';
import {localDownloadTableNames} from './sync-download';
import {localOperatorTableNames} from './operators';
export const localTableNames=[...backupTableNames,...localSyncTableNames,...localDownloadTableNames,...localOperatorTableNames] as const;
