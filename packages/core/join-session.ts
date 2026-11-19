import { operatorAuthKey, operatorId } from './operators';
import {
  parseSyncDownloadTarget,
  type SyncDownloadTarget,
} from './sync-download';
import { parseSyncScope } from './sync-read';

export const localJoinTableNames = ['joinSessions'] as const;
export type JoinProblem = 'auth' | 'retry' | 'review';
export interface JoinSession {
  id: string;
  version: 1;
  readId: string;
  target: SyncDownloadTarget;
  authKey: string;
  epoch: string;
  scopeVersion: string;
  operatorRevision: number;
  createdAt: number;
  phase: 'pending' | 'paused' | 'ready' | 'cancelled';
  problem: JoinProblem | null;
}
export class JoinSessionError extends Error {
  constructor(readonly kind: JoinProblem = 'review') {
    super(
      kind === 'auth'
        ? 'Verify the original phone and outlet before continuing this join.'
        : kind === 'retry'
          ? 'The join is unconfirmed. Your saved download and local records are kept.'
          : 'Review this join. Keep the original download and this device’s local records.',
    );
  }
}
export function parseJoinSession(input: unknown): JoinSession {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new JoinSessionError();
  const v = input as Record<string, unknown>,
    keys =
      'id,version,readId,target,authKey,epoch,scopeVersion,operatorRevision,createdAt,phase,problem'
        .split(',')
        .sort()
        .join(',');
  if (
    Object.keys(v).sort().join(',') !== keys ||
    v.version !== 1 ||
    !operatorId(v.readId) ||
    !(v.id === 'active' || v.id === 'saved:' + v.readId) ||
    !operatorAuthKey(v.authKey) ||
    typeof v.operatorRevision !== 'number' ||
    !Number.isSafeInteger(v.operatorRevision) ||
    v.operatorRevision < 1 ||
    typeof v.createdAt !== 'number' ||
    !Number.isSafeInteger(v.createdAt) ||
    v.createdAt < 0 ||
    v.createdAt > 8640000000000000 ||
    !['pending', 'paused', 'ready', 'cancelled'].includes(v.phase as string) ||
    (v.phase !== 'paused' && v.problem !== null) ||
    !(
      v.problem === null ||
      ['auth', 'retry', 'review'].includes(v.problem as string)
    )
  )
    throw new JoinSessionError();
  const target = parseSyncDownloadTarget(v.target),
    scope = parseSyncScope({
      ...target,
      epoch: v.epoch,
      scopeVersion: v.scopeVersion,
    });
  return {
    id: v.id,
    version: 1,
    readId: v.readId,
    target,
    authKey: v.authKey,
    epoch: scope.epoch,
    scopeVersion: scope.scopeVersion,
    operatorRevision: v.operatorRevision,
    createdAt: v.createdAt,
    phase: v.phase as JoinSession['phase'],
    problem: v.problem as JoinProblem | null,
  };
}
