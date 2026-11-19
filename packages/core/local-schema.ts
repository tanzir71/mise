import {backupTableNames} from './backup-tables';
import {localSyncTableNames} from './local-outbox';
import {localDownloadTableNames} from './sync-download';
import {localOperatorTableNames} from './operators';
import {localImageTableNames} from './sync-images';
import {localCoverageTableNames} from './sync-coverage';
import {localCanonicalTableNames} from './sync-canonical';
import {localApplicationTableNames} from './sync-materialize';
export const localTableNames=[...backupTableNames,...localSyncTableNames,...localDownloadTableNames,...localOperatorTableNames,...localImageTableNames,...localCoverageTableNames,...localCanonicalTableNames,...localApplicationTableNames] as const;
