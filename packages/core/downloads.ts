export type DownloadId = 'extension' | 'order-phone';
export interface DownloadItem {
  id: DownloadId; name: string; version: string; file: string; latest: string;
  bytes: number; sha256: string; minAndroid?: string; minApp?: string;
}
export interface DownloadsManifest { updatedAt: string | null; items: DownloadItem[] }
const latestFiles: Record<DownloadId, string> = { extension: 'latest/mise-extension.zip', 'order-phone': 'latest/mise-order-phone.apk' };

export function parseDownloadsManifest(input: unknown): DownloadsManifest {
  if (!input || typeof input !== 'object') throw new Error('Download list is not an object.');
  const manifest = input as Record<string, unknown>;
  if (!Array.isArray(manifest.items)) throw new Error('Download list is missing its items.');
  if (manifest.updatedAt !== null && (typeof manifest.updatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.updatedAt)))) throw new Error('Download list has an invalid date.');
  const seen = new Set<DownloadId>();
  const items = manifest.items.map((value: unknown): DownloadItem => {
    if (!value || typeof value !== 'object') throw new Error('Invalid download.');
    const item = value as Record<string, unknown>;
    if (item.id !== 'extension' && item.id !== 'order-phone') throw new Error('Unknown download.');
    if (seen.has(item.id)) throw new Error('Duplicate download.');
    seen.add(item.id);
    if (typeof item.name !== 'string' || !item.name || typeof item.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version)) throw new Error('Invalid download version.');
    if (typeof item.file !== 'string' || !/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*\.(zip|apk)$/.test(item.file) || item.latest !== latestFiles[item.id]) throw new Error('Invalid download path.');
    if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 1 || (item.bytes as number) > 50 * 1024 * 1024 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('Invalid file size or checksum.');
    if ((item.id === 'extension' && !item.file.endsWith('.zip')) || (item.id === 'order-phone' && !item.file.endsWith('.apk'))) throw new Error('Wrong file type.');
    return { id: item.id, name: item.name, version: item.version, file: item.file, latest: latestFiles[item.id], bytes: item.bytes as number, sha256: item.sha256.toLowerCase(), minAndroid: typeof item.minAndroid === 'string' ? item.minAndroid : undefined, minApp: typeof item.minApp === 'string' ? item.minApp : undefined };
  });
  return { updatedAt: manifest.updatedAt as string | null, items };
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
