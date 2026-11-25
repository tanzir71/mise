import { originalCopyFetchJson } from '@mise/core/original-copy-wire';
import Dexie, { type EntityTable, type Table } from 'dexie';
import type { PortableBackup } from '@mise/core/payment-archive';
import {
  prepareOriginalCopy,
  parseOriginalCopyManifest,
  parseOriginalCopyReceipt,
  readOriginalCopy,
  inspectOriginalCopy,
  originalCopyHash,
  originalCopyNodeRefs,
  originalCopyBatches,
  originalCopyPartBytes,
  originalCopyBase64,
  originalCopyBytes,
  type OriginalCopyManifest,
  type OriginalCopyReceipt,
  type OriginalCopyPlan,
  type OriginalCopyScope,
} from '@mise/core/original-copy';
import { sharedJsonHash, type SharedJsonNode } from '@mise/core/shared-json';
import { literalToken } from '@mise/core/literal-token';
export interface OriginalCopyIdentity extends OriginalCopyScope {
  targetHash: string;
  accountHash: string;
}
interface CopyRow {
  id: string;
  version: 1;
  identity: OriginalCopyIdentity;
  ownerKey: string;
  manifest: OriginalCopyManifest;
  keys: string[];
  receipt: OriginalCopyReceipt | null;
  verified: boolean;
}
interface CopyValue extends SharedJsonNode {
  ownerKey: string;
}
export interface OriginalCopyRemote {
  scope: OriginalCopyScope;
  call(op: string, id: string, body: Record<string, unknown>): Promise<unknown>;
}
const encoder = new TextEncoder(),
  hex = /^[a-f0-9]{64}$/;
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the original copy and verify the same account and connection.',
    );
}
const identityKey = (i: OriginalCopyIdentity) => {
  ensure(
    i &&
      Object.getPrototypeOf(i) === Object.prototype &&
      Object.keys(i).sort().join(',') ===
        'accountHash,actorId,businessId,outletId,targetHash' &&
      [i.businessId, i.outletId, i.actorId].every(
        (value) =>
          typeof value === 'string' &&
          /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value),
      ) &&
      typeof i.targetHash === 'string' &&
      typeof i.accountHash === 'string' &&
      hex.test(i.targetHash) &&
      hex.test(i.accountHash),
  );
  return originalCopyHash(i);
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Private transfer state, outside ordinary shop/backup tables. Never stores JWTs,
 * keys, connection URLs or new financial permissions. */
export class OriginalCopyJournal extends Dexie {
  copies!: EntityTable<CopyRow, 'id'>;
  values!: Table<CopyValue, [string, string]>;
  constructor(name = 'mise-original-copies') {
    super(name);
    this.version(1).stores({
      copies: 'id,ownerKey',
      values: '[ownerKey+digest],ownerKey',
    });
  }
  async prepare(
    portable: PortableBackup,
    identity: OriginalCopyIdentity,
    id: string,
    current: () => void,
  ) {
    current();
    identity = structuredClone(identity);
    const plan = prepareOriginalCopy(portable, identity, id),
      ownerKey = identityKey(identity);
    current();
    return this.transaction('rw', this.tables, async () => {
      current();
      const old = await this.copies.get(id);
      if (old) {
        ensure(
          old.ownerKey === ownerKey &&
            originalCopyHash(old.manifest) === originalCopyHash(plan.manifest),
        );
        return structuredClone(old.manifest);
      }
      const existing = await this.values.bulkGet(
          plan.nodes.map((n) => [ownerKey, n.digest] as [string, string]),
        ),
        added: CopyValue[] = [];
      plan.nodes.forEach((n, index) => {
        const prior = existing[index];
        ensure(!prior || prior.json === n.json);
        if (!prior) added.push({ ...n, ownerKey });
      });
      await this.values.bulkAdd(added);
      await this.copies.add({
        id,
        version: 1,
        identity,
        ownerKey,
        manifest: plan.manifest,
        keys: plan.nodes.map((n) => n.digest),
        receipt: null,
        verified: false,
      });
      current();
      return plan.manifest;
    });
  }
  private async plan(
    id: string,
    identity: OriginalCopyIdentity,
  ): Promise<{ row: CopyRow; plan: OriginalCopyPlan }> {
    const row = await this.copies.get(id);
    ensure(
      row &&
        row.version === 1 &&
        row.ownerKey === identityKey(identity) &&
        literalToken(row.identity) === literalToken(identity),
    );
    const manifest = parseOriginalCopyManifest(row.manifest);
    ensure(
      manifest.id === id &&
        manifest.businessId === identity.businessId &&
        manifest.outletId === identity.outletId &&
        manifest.actorId === identity.actorId &&
        row.keys.length === manifest.nodeCount &&
        new Set(row.keys).size === row.keys.length,
    );
    const data = await this.values.bulkGet(
      row.keys.map((k) => [row.ownerKey, k] as [string, string]),
    );
    ensure(data.every(Boolean));
    const nodes = data.map((n) => ({ digest: n!.digest, json: n!.json }));
    const pool = new Map(nodes.map((n) => [n.digest, n.json]));
    readOriginalCopy(manifest, (key) => pool.get(key));
    return { row, plan: { manifest, nodes } };
  }
  private async receipt(
    row: CopyRow,
    receipt: unknown,
    verified: boolean,
    current: () => void,
  ) {
    const checked = parseOriginalCopyReceipt(receipt, row.manifest);
    current();
    return this.transaction('rw', this.copies, async () => {
      current();
      const saved = await this.copies.get(row.id);
      ensure(
        saved &&
          saved.ownerKey === row.ownerKey &&
          originalCopyHash(saved.manifest) === originalCopyHash(row.manifest) &&
          (!saved.receipt ||
            literalToken(saved.receipt) === literalToken(checked)),
      );
      await this.copies.put({
        ...saved,
        receipt: checked,
        verified: saved.verified || verified,
      });
      current();
      return checked;
    });
  }
  async deliver(
    id: string,
    identity: OriginalCopyIdentity,
    remote: OriginalCopyRemote,
    current: () => void,
  ) {
    current();
    ensure(
      literalToken(remote.scope) ===
        literalToken({
          businessId: identity.businessId,
          outletId: identity.outletId,
          actorId: identity.actorId,
        }),
    );
    const { row, plan } = await this.plan(id, identity);
    current();
    if (row.receipt)
      return parseOriginalCopyReceipt(row.receipt, plan.manifest);
    const invoke = async (op: string, body: Record<string, unknown>) => {
      current();
      const v = await remote.call(op, id, body);
      current();
      return v;
    };
    const start = await invoke('begin', {
      manifest: literalToken(plan.manifest),
    });
    ensure(
      object(start) &&
        originalCopyHash(start.manifest) === originalCopyHash(plan.manifest),
    );
    if (start.receipt) return this.receipt(row, start.receipt, false, current);
    const needed = new Set<string>();
    for (let i = 0; i < plan.nodes.length; i += 512) {
      const keys = plan.nodes.slice(i, i + 512).map((n) => n.digest),
        missing = await invoke('missing', { digests: keys });
      ensure(
        Array.isArray(missing) &&
          missing.every((k) => typeof k === 'string' && keys.includes(k)) &&
          new Set(missing).size === missing.length,
      );
      for (const k of missing) needed.add(k);
    }
    for (const batch of originalCopyBatches(
      plan.nodes.filter((n) => needed.has(n.digest)),
    )) {
      if (
        batch.length === 1 &&
        encoder.encode(JSON.stringify(batch[0])).length > 192 * 1024
      ) {
        const node = batch[0],
          raw = encoder.encode(node.json);
        for (
          let at = 0, index = 0;
          at < raw.length;
          at += originalCopyPartBytes, index++
        )
          ensure(
            (await invoke('part', {
              digest: node.digest,
              bytes: raw.length,
              index,
              data: originalCopyBase64(
                raw.subarray(at, at + originalCopyPartBytes),
              ),
            })) === true,
          );
        ensure((await invoke('seal', { digest: node.digest })) === true);
      } else ensure((await invoke('put', { nodes: batch })) === true);
    }
    let checked = 0;
    for (;;) {
      const progress = await invoke('verify', {});
      ensure(
        object(progress) &&
          typeof progress.done === 'boolean' &&
          Number.isSafeInteger(progress.checked) &&
          Number.isSafeInteger(progress.queued) &&
          Number.isSafeInteger(progress.bytes) &&
          (progress.checked as number) >= checked &&
          (progress.checked as number) <= (progress.queued as number) &&
          (progress.queued as number) <= plan.manifest.nodeCount &&
          (progress.bytes as number) >= 0 &&
          (progress.bytes as number) <= plan.manifest.nodeBytes,
      );
      if (progress.done) {
        ensure(
          progress.checked === plan.manifest.nodeCount &&
            progress.bytes === plan.manifest.nodeBytes,
        );
        break;
      }
      ensure((progress.checked as number) > checked);
      checked = progress.checked as number;
    }
    return this.receipt(row, await invoke('finish', {}), false, current);
  }
  async readback(
    id: string,
    identity: OriginalCopyIdentity,
    remote: OriginalCopyRemote,
    current: () => void,
  ) {
    current();
    const { row, plan } = await this.plan(id, identity);
    const result = await this.download(
      id,
      identity,
      remote,
      current,
      plan.manifest,
    );
    await this.receipt(row, result.receipt, true, current);
    return result.decoded;
  }
  /** Same authenticated account can restore a known original to an empty private
   * journal. The decoded copy is not installed into current shop/financial rows. */
  async recover(
    id: string,
    identity: OriginalCopyIdentity,
    remote: OriginalCopyRemote,
    current: () => void,
  ) {
    const result = await this.download(id, identity, remote, current);
    await this.prepare(result.portable, identity, id, current);
    const row = await this.copies.get(id);
    ensure(row);
    current();
    await this.receipt(row, result.receipt, true, current);
    return result.decoded;
  }
  private async download(
    id: string,
    identity: OriginalCopyIdentity,
    remote: OriginalCopyRemote,
    current: () => void,
    expected?: OriginalCopyManifest,
  ) {
    current();
    identityKey(identity);
    ensure(
      literalToken(remote.scope) ===
        literalToken({
          businessId: identity.businessId,
          outletId: identity.outletId,
          actorId: identity.actorId,
        }),
    );
    const invoke = async (op: string, body: Record<string, unknown>) => {
      current();
      const v = await remote.call(op, id, body);
      current();
      return v;
    };
    const state = await invoke('inspect', {});
    ensure(object(state));
    const manifest = parseOriginalCopyManifest(state.manifest);
    ensure(
      manifest.id === id &&
        manifest.businessId === identity.businessId &&
        manifest.outletId === identity.outletId &&
        manifest.actorId === identity.actorId &&
        (!expected ||
          originalCopyHash(expected) === originalCopyHash(manifest)),
    );
    const receipt = parseOriginalCopyReceipt(state.receipt, manifest),
      nodes = new Map<string, string>(),
      pending = [manifest.root],
      discovered = new Set(pending);
    let keptBytes = 0;
    const keep = (digest: string, json: string) => {
      ensure(!nodes.has(digest) && sharedJsonHash(json) === digest);
      nodes.set(digest, json);
      keptBytes += encoder.encode(json).length;
      ensure(
        nodes.size <= manifest.nodeCount && keptBytes <= manifest.nodeBytes,
      );
      for (const key of originalCopyNodeRefs(json))
        if (!discovered.has(key)) {
          discovered.add(key);
          ensure(discovered.size <= manifest.nodeCount);
          pending.push(key);
        }
    };
    while (pending.length) {
      const keys = [
        ...new Set(pending.splice(Math.max(0, pending.length - 128), 128)),
      ].filter((k) => !nodes.has(k));
      if (!keys.length) continue;
      const response = await invoke('read', { digests: keys });
      ensure(
        object(response) &&
          Array.isArray(response.nodes) &&
          Array.isArray(response.large),
      );
      const seen = new Set<string>();
      for (const n of response.nodes) {
        ensure(
          object(n) &&
            typeof n.digest === 'string' &&
            keys.includes(n.digest) &&
            !seen.has(n.digest) &&
            typeof n.json === 'string',
        );
        seen.add(n.digest);
        keep(n.digest, n.json);
      }
      for (const n of response.large) {
        ensure(
          object(n) &&
            typeof n.digest === 'string' &&
            keys.includes(n.digest) &&
            !seen.has(n.digest) &&
            Number.isSafeInteger(n.bytes) &&
            (n.bytes as number) > 0 &&
            (n.bytes as number) <= manifest.nodeBytes - keptBytes,
        );
        seen.add(n.digest);
        const raw = new Uint8Array(n.bytes as number);
        for (
          let index = 0, at = 0;
          at < raw.length;
          index++, at += originalCopyPartBytes
        ) {
          const v = await invoke('read-part', { digest: n.digest, index });
          ensure(
            object(v) &&
              v.digest === n.digest &&
              v.bytes === raw.length &&
              v.index === index &&
              typeof v.data === 'string',
          );
          const part = originalCopyBytes(v.data);
          ensure(
            part.length === Math.min(originalCopyPartBytes, raw.length - at),
          );
          raw.set(part, at);
        }
        keep(n.digest, new TextDecoder('utf-8', { fatal: true }).decode(raw));
      }
      ensure(seen.size > 0);
      pending.unshift(...keys.filter((k) => !seen.has(k)));
    }
    return {
      ...inspectOriginalCopy(manifest, (key) => nodes.get(key)),
      receipt,
    };
  }
}
export function createOriginalCopyRemote(
  scope: OriginalCopyScope,
  url: string,
  publishableKey: string,
  jwt: () => Promise<string>,
  send: typeof fetch = fetch,
): OriginalCopyRemote {
  const root = new URL(url);
  ensure(
    !root.username &&
      !root.password &&
      !root.search &&
      !root.hash &&
      root.pathname === '/' &&
      (root.protocol === 'https:' ||
        (root.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(root.hostname))) &&
      /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey),
  );
  return {
    scope: structuredClone(scope),
    async call(op, id, body) {
      const token = await jwt();
      return originalCopyFetchJson(
        send,
        new URL('functions/v1/native-original-copy', root),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + token,
            apikey: publishableKey,
            'Content-Type': 'application/json',
            'X-Mise-Original-Action': op,
            'X-Mise-Original-Id': id,
            'X-Mise-Original-Outlet': scope.outletId,
          },
          body: JSON.stringify(body),
        },
      );
    },
  };
}
