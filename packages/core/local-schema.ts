import {backupTableNames} from './backup-tables';
import {localSyncTableNames} from './local-outbox';
import {localDownloadTableNames} from './sync-download';
import {localOperatorTableNames} from './operators';
import {localImageTableNames} from './sync-images';
export const localTableNames=[...backupTableNames,...localSyncTableNames,...localDownloadTableNames,...localOperatorTableNames,...localImageTableNames] as const;
