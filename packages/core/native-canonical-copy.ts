import { MAX_BACKUP_BYTES } from './backup-tables';
import {
  prepareOriginalCopy,
  type OriginalCopyPlan,
  type OriginalCopyScope,
} from './original-copy';
import { parsePortableBackup, type PortableBackup } from './payment-archive';
import type {
  PaymentOriginalBasis,
  PaymentOriginalNode,
} from './payment-originals';
import { sharedJsonHash, type SharedJsonNode } from './shared-json';

interface CheckedCopy {
  token: string;
  plan: OriginalCopyPlan;
  bases: PaymentOriginalBasis[];
  nodes: PaymentOriginalNode[];
}
let lastChecked: CheckedCopy | undefined;
const encoder = new TextEncoder();
const fail = () =>
  Error('Keep the complete original copy and its exact origin.');
/** Exact data reuse, never a reader, receipt, consent or write capability. The
 * current SDK loader and final role check remain outside this private cache. */
export function prepareNativeCanonicalCopy(
  input: PortableBackup,
  source: OriginalCopyScope,
  copyId: string,
  { fresh = false }: { fresh?: boolean } = {},
) {
  const scope = {
    businessId: source.businessId,
    outletId: source.outletId,
    actorId: source.actorId,
  };
  if (
    typeof copyId !== 'string' ||
    Object.values(scope).some((v) => typeof v !== 'string')
  )
    throw fail();
  const text = JSON.stringify(input);
  if (
    typeof text !== 'string' ||
    text.length > MAX_BACKUP_BYTES ||
    encoder.encode(text).length > MAX_BACKUP_BYTES
  )
    throw fail();
  // Use precisely the bytes that were hashed, even if a caller supplied getters.
  const portable: PortableBackup = JSON.parse(text),
    token = sharedJsonHash(
      JSON.stringify([scope, copyId, sharedJsonHash(text)]),
    );
  if (fresh || lastChecked?.token !== token) {
    const plan = prepareOriginalCopy(portable, scope, copyId),
      decoded = parsePortableBackup(portable);
    lastChecked = { token, plan, bases: decoded.bases, nodes: decoded.nodes };
  }
  const checked = lastChecked;
  let values: SharedJsonNode[] | undefined,
    bases: PaymentOriginalBasis[] | undefined,
    nodes: PaymentOriginalNode[] | undefined;
  const plan: OriginalCopyPlan = {
    manifest: structuredClone(checked.plan.manifest),
    get nodes() {
      return (values ??= structuredClone(checked.plan.nodes));
    },
  };
  return {
    portable,
    plan,
    get bases() {
      return (bases ??= structuredClone(checked.bases));
    },
    get nodes() {
      return (nodes ??= structuredClone(checked.nodes));
    },
  };
}
