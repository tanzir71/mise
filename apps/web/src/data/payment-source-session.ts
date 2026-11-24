import type { CloudConnection, KeyStorage } from '@mise/core/cloud-connection';
import {
  parseDeskPushContext,
  type DeskPushContext,
} from '@mise/core/desk-push';
import {
  capturePaymentSource,
  changePaymentSource,
  parseObservedPayment,
  parsePaymentSourcePage,
  parsePaymentMatchPage,
  parsePaymentCandidatePage,
  parsePaymentCandidateCursor,
  parsePaymentSourceReceipt,
  type ObservedPayment,
  type PaymentMatchTarget,
  type PaymentCandidateCursor,
  type PaymentSourcePage,
  type PaymentMatchPage,
  type PaymentCandidatePage,
} from '@mise/core/payment-sources';
import {
  createPaymentSourceRequest,
  bindCommandReceipt,
  assertLiveCommandReceipt,
  CommandRequestError,
  type CommandAccount,
  type PaymentSourceRpc,
} from './command-request';
import {
  paymentSourceJournalKey,
  parsePaymentSourceJournal,
  paymentSourceJournalMaximum,
  paymentSourceJournalBytes,
  type PaymentSourceJournal as Journal,
} from './payment-source-journal';
import { createPaymentSourceArchives } from './payment-source-archive';
export type { SavedPaymentSource } from './payment-source-journal';
const bad = () => new CommandRequestError('review');
export function createPaymentSourceSession(
  config: CloudConnection,
  account: CommandAccount,
  context: DeskPushContext,
  deps: {
    storage: KeyStorage;
    assertScope: () => Promise<void>;
    assertDraftAccount: () => void;
    locks?: Pick<LockManager, 'request'>;
    send?: typeof fetch;
  },
) {
  const scope = parseDeskPushContext(context),
    key = paymentSourceJournalKey(account, scope),
    requests = new Map<
      PaymentSourceRpc,
      ReturnType<typeof createPaymentSourceRequest>
    >(),
    controller = new AbortController(),
    listeners = new Set<() => void>(),
    targets = new WeakMap<
      PaymentMatchTarget,
      { paymentId: string; fingerprint: string }
    >();
  let active = true;
  function current() {
    if (!active) throw new CommandRequestError('auth');
    deps.assertDraftAccount();
  }
  async function local() {
    current();
    await deps.assertScope();
    current();
  }
  function saved(): Journal {
    current();
    return parsePaymentSourceJournal(deps.storage.getItem(key), scope);
  }
  async function persist(before: Journal, next: Journal, proof?: object) {
    await local();
    if (proof) assertLiveCommandReceipt(proof);
    const raw = JSON.stringify(next);
    if (
      paymentSourceJournalBytes(raw) > paymentSourceJournalMaximum ||
      JSON.stringify(saved()) !== JSON.stringify(before)
    )
      throw bad();
    try {
      current();
      deps.storage.setItem(key, raw);
      if (deps.storage.getItem(key) !== raw) throw bad();
    } catch {
      throw bad();
    }
    await local();
    if (proof) assertLiveCommandReceipt(proof);
    for (const listener of listeners) listener();
  }
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    const locks = deps.locks ?? globalThis.navigator?.locks;
    if (!locks) throw bad();
    return locks.request(
      key,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) throw new CommandRequestError('retry');
        await local();
        return run();
      },
    );
  };
  async function request<T extends object>(
    rpc: PaymentSourceRpc,
    body: Record<string, unknown>,
    parse: (v: unknown) => T,
    signal?: AbortSignal,
  ) {
    await local();
    let send = requests.get(rpc);
    if (!send) {
      send = createPaymentSourceRequest(
        config,
        account,
        rpc,
        deps.send ?? fetch,
      );
      requests.set(rpc, send);
    }
    const response = await send(
      JSON.stringify(body),
      { 'Content-Type': 'application/json' },
      20000,
      signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    );
    response.guard();
    let result: T;
    try {
      result = parse(response.value);
    } catch {
      throw bad();
    }
    await local();
    response.guard();
    const image = JSON.stringify(result);
    return bindCommandReceipt(result, () => {
      current();
      response.guard();
      if (JSON.stringify(result) !== image) throw bad();
    });
  }
  function childProof<T extends object>(page: object, value: T) {
    const image = JSON.stringify(value);
    return bindCommandReceipt(value, () => {
      current();
      assertLiveCommandReceipt(page);
      if (JSON.stringify(value) !== image) throw bad();
    });
  }
  function bindSource<T extends PaymentSourcePage>(page: T) {
    childProof(page, page.source);
    return page;
  }
  function bindTarget(
    page: PaymentMatchPage | PaymentCandidatePage,
    target: PaymentMatchTarget,
  ) {
    childProof(page, target);
    targets.set(target, {
      paymentId: page.source.id,
      fingerprint: page.source.fingerprint,
    });
  }
  async function read(paymentId: string, signal?: AbortSignal) {
    return bindSource(
      await request(
        'read_payment_source',
        { p_outlet_id: scope.outletId, p_payment_id: paymentId },
        (v) => parsePaymentSourcePage(v, scope, paymentId),
        signal,
      ),
    );
  }
  async function candidates(
    source: ObservedPayment,
    after: PaymentCandidateCursor | null = null,
    signal?: AbortSignal,
  ) {
    assertLiveCommandReceipt(source);
    parseObservedPayment(source, scope);
    if (after) parsePaymentCandidateCursor(after);
    const page = bindSource(
      await request(
        'read_payment_candidates',
        {
          p_outlet_id: scope.outletId,
          p_payment_id: source.id,
          p_fingerprint: source.fingerprint,
          p_after_at: after?.at ?? null,
          p_after_kind: after?.kind ?? null,
          p_after_id: after?.id ?? null,
          p_limit: 20,
        },
        (v) =>
          parsePaymentCandidatePage(
            v,
            scope,
            source.id,
            source.fingerprint,
            after,
          ),
        signal,
      ),
    );
    for (const target of page.targets) bindTarget(page, target);
    return page;
  }
  async function match(
    source: ObservedPayment,
    kind: PaymentMatchTarget['kind'],
    targetId: string,
    signal?: AbortSignal,
  ) {
    assertLiveCommandReceipt(source);
    parseObservedPayment(source, scope);
    const page = bindSource(
      await request(
        'read_payment_match',
        {
          p_outlet_id: scope.outletId,
          p_payment_id: source.id,
          p_kind: kind,
          p_target_id: targetId,
        },
        (v) => parsePaymentMatchPage(v, scope, source.id, kind, targetId),
        signal,
      ),
    );
    if (page.source.fingerprint !== source.fingerprint) throw bad();
    if (page.target) bindTarget(page, page.target);
    return page;
  }
  async function append(
    make: () =>
      | ReturnType<typeof changePaymentSource>
      | ReturnType<typeof capturePaymentSource>,
    source: ObservedPayment | null = null,
  ) {
    const before = saved();
    if (
      before.actions.length >= 200 ||
      before.actions.some(
        (row) => !row.receipt || row.receipt.state === 'pending',
      )
    )
      throw bad();
    const intent = make();
    await persist(
      before,
      {
        v: 1,
        actions: [
          ...before.actions,
          {
            intent,
            source: source ? structuredClone(source) : null,
            closeRequested: false,
            receipt: null,
          },
        ],
      },
      source ?? undefined,
    );
    return intent;
  }
  async function prepareCapture(
    draft: Parameters<typeof capturePaymentSource>[1],
  ) {
    return exclusive(() => append(() => capturePaymentSource(scope, draft)));
  }
  async function prepare(
    source: ObservedPayment,
    change: Parameters<typeof changePaymentSource>[2],
  ) {
    return exclusive(async () => {
      assertLiveCommandReceipt(source);
      parseObservedPayment(source, scope);
      if (change.type === 'link') {
        assertLiveCommandReceipt(change.target);
        const origin = targets.get(change.target);
        if (
          !origin ||
          origin.paymentId !== source.id ||
          origin.fingerprint !== source.fingerprint
        )
          throw bad();
      }
      return append(() => changePaymentSource(scope, source, change), source);
    });
  }
  async function call(
    id: string,
    operation: 'submit' | 'inspect' | 'close',
    signal?: AbortSignal,
  ) {
    return exclusive(async () => {
      if (!['submit', 'inspect', 'close'].includes(operation)) throw bad();
      let before = saved(),
        row = before.actions.at(-1);
      if (!row || row.intent.id !== id) throw bad();
      if (operation === 'close' && !row.closeRequested) {
        const next = structuredClone(before);
        next.actions.at(-1)!.closeRequested = true;
        await persist(before, next);
        before = next;
        row = next.actions.at(-1)!;
      }
      const intent = row.intent,
        effect =
          row.closeRequested && operation === 'submit' ? 'close' : operation;
      if (effect === 'submit' && intent.scope.role !== scope.role) throw bad();
      const receipt = await request(
        'act_payment_source',
        {
          p_outlet_id: scope.outletId,
          p_operation: effect,
          p_intent_json: JSON.stringify(intent),
        },
        (v) => parsePaymentSourceReceipt(v, intent),
        signal,
      );
      if (
        row.receipt &&
        row.receipt.state !== 'pending' &&
        JSON.stringify(row.receipt) !== JSON.stringify(receipt)
      )
        throw bad();
      const next = structuredClone(before);
      next.actions.at(-1)!.receipt = receipt;
      await persist(before, next, receipt);
      return receipt;
    });
  }
  const archives = createPaymentSourceArchives({
    key,
    current,
    local,
    saved,
    exclusive,
    persist,
    inspect: (intent, signal) =>
      request(
        'act_payment_source',
        {
          p_outlet_id: scope.outletId,
          p_operation: 'inspect',
          p_intent_json: JSON.stringify(intent),
        },
        (v) => parsePaymentSourceReceipt(v, intent),
        signal,
      ),
  });
  return {
    key,
    saved,
    read,
    candidates,
    match,
    prepareCapture,
    prepare,
    call,
    ...archives,
    assertCurrent: local,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      active = false;
      controller.abort();
      listeners.clear();
    },
  };
}
export type PaymentSourceSession = ReturnType<
  typeof createPaymentSourceSession
>;
