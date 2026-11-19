import {
  parseSyncDownloadTarget,
  type SyncDownloadTarget,
} from './sync-download';
import { parseSyncScope } from './sync-read';
import { operatorAuthKey, operatorId } from './operators';

export const localSessionTableNames = ['syncSessions'] as const;
export type SyncProblem = 'retry' | 'auth' | 'review';
export interface SyncSession {
  id: string;
  version: 1;
  paused: boolean;
  sessionId: string;
  generation: number;
  target: SyncDownloadTarget;
  authKey: string;
  operatorRevision: number;
  epoch: string;
  scopeVersion: string;
  bindingHash: string;
  readId: string | null;
  readQueueHash: string | null;
  lease: { id: string; until: number } | null;
  failures: number;
  retryAt: number;
  problem: SyncProblem | null;
  lastConfirmedAt: number | null;
  requested: number;
  confirmed: number;
}
export class SyncSessionError extends Error {
  constructor(readonly kind: SyncProblem = 'review') {
    super(
      kind === 'auth'
        ? 'Verify the original account and operator to continue syncing.'
        : kind === 'retry'
          ? 'Sync is unconfirmed. Your local records are kept.'
          : 'Review sync before continuing. Your local records and saved downloads are kept.',
    );
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, list: string) =>
  Object.keys(v).sort().join(',') === list.split(',').sort().join(',');
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): v is number => count(v) && v <= 8640000000000000;
export function parseSyncSession(value: unknown): SyncSession {
  if (
    !object(value) ||
    !keys(
      value,
      'id,version,paused,sessionId,generation,target,authKey,operatorRevision,epoch,scopeVersion,bindingHash,readId,readQueueHash,lease,failures,retryAt,problem,lastConfirmedAt,requested,confirmed',
    ) ||
    value.version !== 1 ||
    typeof value.paused !== 'boolean' ||
    !operatorId(value.sessionId) ||
    !(value.id === 'active' || value.id === 'saved:' + value.sessionId) ||
    !count(value.generation) ||
    !value.generation ||
    !operatorAuthKey(value.authKey) ||
    !count(value.operatorRevision) ||
    !value.operatorRevision ||
    typeof value.bindingHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.bindingHash) ||
    !(value.readId === null || operatorId(value.readId)) ||
    !(
      value.readQueueHash === null ||
      (typeof value.readQueueHash === 'string' &&
        /^[a-f0-9]{64}$/.test(value.readQueueHash))
    ) ||
    (value.readId === null) !== (value.readQueueHash === null) ||
    !count(value.failures) ||
    value.failures > 30 ||
    !time(value.retryAt) ||
    !(
      value.problem === null ||
      ['retry', 'auth', 'review'].includes(value.problem as string)
    ) ||
    !(value.lastConfirmedAt === null || time(value.lastConfirmedAt)) ||
    !count(value.requested) ||
    !count(value.confirmed) ||
    value.confirmed > value.requested
  )
    throw new SyncSessionError();
  let lease: SyncSession['lease'] = null;
  if (value.lease !== null) {
    if (
      !object(value.lease) ||
      !keys(value.lease, 'id,until') ||
      !operatorId(value.lease.id) ||
      !time(value.lease.until)
    )
      throw new SyncSessionError();
    lease = { id: value.lease.id, until: value.lease.until };
  }
  const target = parseSyncDownloadTarget(value.target),
    scope = parseSyncScope({
      ...target,
      epoch: value.epoch,
      scopeVersion: value.scopeVersion,
    });
  return {
    id: value.id,
    version: 1,
    paused: value.paused,
    sessionId: value.sessionId,
    generation: value.generation,
    target,
    authKey: value.authKey,
    operatorRevision: value.operatorRevision,
    epoch: scope.epoch,
    scopeVersion: scope.scopeVersion,
    bindingHash: value.bindingHash,
    readId: value.readId as string | null,
    readQueueHash: value.readQueueHash as string | null,
    lease,
    failures: value.failures,
    retryAt: value.retryAt,
    problem: value.problem as SyncProblem | null,
    lastConfirmedAt: value.lastConfirmedAt as number | null,
    requested: value.requested,
    confirmed: value.confirmed,
  };
}
/** Bounded exponential retry with jitter; server failures never change action IDs. */
export function syncRetryDelay(
  failures: number,
  random = Math.random(),
): number {
  if (
    !count(failures) ||
    failures < 1 ||
    !Number.isFinite(random) ||
    random < 0 ||
    random > 1
  )
    throw new SyncSessionError();
  return Math.min(
    60000,
    Math.round(
      Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6)) * (0.5 + random),
    ),
  );
}
export function syncSessionLabel(
  state: SyncSession | null,
  online: boolean,
  unsent: number,
  busy = false,
): string {
  if (!count(unsent)) throw new SyncSessionError();
  if (!online) return 'Offline';
  if (!state) return 'Sync off';
  if (state.paused) return 'Paused';
  if (state.problem === 'auth') return 'Sign in';
  if (state.problem === 'review') return 'Needs review';
  return !busy &&
    !state.lease &&
    !state.problem &&
    !unsent &&
    !state.readId &&
    state.lastConfirmedAt !== null &&
    state.confirmed === state.requested
    ? 'Synced'
    : 'Syncing';
}
