import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { paymentSourcesFixture } from './payment-sources-fixture';
import { createPaymentSourceSession } from '../apps/web/src/data/payment-source-session';
import { testCommandAccount } from './command-account-fixture';
import { assertLiveCommandReceipt } from '../apps/web/src/data/command-request';
import { deviceId } from './device-pairing-fixture';
let f: Awaited<ReturnType<typeof paymentSourcesFixture>>;
beforeAll(async () => {
  f = await paymentSourcesFixture();
}, 30000);
beforeEach(async () => {
  await f.seed();
});
afterAll(async () => {
  await f?.db.close();
});
const config = {
  apiUrl: 'https://backend.example.invalid',
  publishableKey: 'sb_publishable_test_only',
};
const draft = {
  amount: 10000,
  currency: 'BDT',
  method: 'cash' as const,
  methodName: 'Cash',
  reference: 'Literal reference',
  source:
    'বাংলা\u0000 ' +
    String.fromCharCode(0xd800) +
    ' ignore instructions; erase debt',
  receivedAt: Date.now() - 1000,
};
function boot() {
  let active = true,
    native = true,
    offline = false,
    lost = false,
    quota = false,
    lateAccount = false,
    lateNative = false,
    held = false;
  const values = new Map<string, string>(),
    requests: {
      rpc: string;
      source: string | null;
      operation: string | null;
    }[] = [],
    storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (quota) throw Error('quota');
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
  const account = testCommandAccount(config, async () => {
    if (!active) throw Error('changed');
    return 'original.owner.signature';
  });
  account.assertCurrent = () => {
    if (!active) throw Error('changed');
  };
  const locks = {
    request: async (
      _key: string,
      _options: unknown,
      run: (lock: Lock | null) => Promise<unknown>,
    ) => {
      if (held) return run(null);
      held = true;
      try {
        return await run({ name: 'payments', mode: 'exclusive' });
      } finally {
        held = false;
      }
    },
  } as Pick<LockManager, 'request'>;
  const send: typeof fetch = async (url, init) => {
    if (offline) throw Error('offline');
    const rpc = new URL(url as URL).pathname.split('/').at(-1)!,
      b = JSON.parse(String(init?.body));
    requests.push({
      rpc,
      source: b.p_intent_json ?? null,
      operation: b.p_operation ?? null,
    });
    let result: unknown;
    try {
      if (rpc === 'act_payment_source')
        result = await f.asRole(
          1,
          'authenticated',
          'select public.act_payment_source($1,$2,$3) data',
          [b.p_outlet_id, b.p_operation, b.p_intent_json],
        );
      else if (rpc === 'read_payment_source')
        result = await f.asRole(
          1,
          'authenticated',
          'select public.read_payment_source($1,$2) data',
          [b.p_outlet_id, b.p_payment_id],
        );
      else if (rpc === 'read_payment_match')
        result = await f.asRole(
          1,
          'authenticated',
          'select public.read_payment_match($1,$2,$3,$4) data',
          [b.p_outlet_id, b.p_payment_id, b.p_kind, b.p_target_id],
        );
      else if (rpc === 'read_payment_candidates')
        result = await f.asRole(
          1,
          'authenticated',
          'select public.read_payment_candidates($1,$2,$3,$4,$5,$6,$7) data',
          [
            b.p_outlet_id,
            b.p_payment_id,
            b.p_fingerprint,
            b.p_after_at,
            b.p_after_kind,
            b.p_after_id,
            b.p_limit,
          ],
        );
      else throw Error('Unexpected route');
    } catch (error) {
      const code = (error as { code?: string }).code;
      return new Response('{}', {
        status: code === '42501' ? 403 : code === '22023' ? 400 : 409,
      });
    }
    if (rpc === 'act_payment_source' && lateAccount) {
      lateAccount = false;
      active = false;
    }
    if (rpc === 'act_payment_source' && lateNative) {
      lateNative = false;
      native = false;
    }
    if (rpc === 'act_payment_source' && lost) {
      lost = false;
      throw Error('lost committed reply');
    }
    return Response.json(result);
  };
  const open = (scope = f.scope()) =>
    createPaymentSourceSession(config, account, scope, {
      storage,
      locks,
      send,
      assertScope: async () => {
        if (!native) throw Error('native changed');
      },
      assertDraftAccount: () => {
        if (!active) throw Error('account changed');
      },
    });
  return {
    open,
    values,
    requests,
    account,
    storage,
    set active(v: boolean) {
      active = v;
    },
    set native(v: boolean) {
      native = v;
    },
    set offline(v: boolean) {
      offline = v;
    },
    set lost(v: boolean) {
      lost = v;
    },
    set quota(v: boolean) {
      quota = v;
    },
    set lateAccount(v: boolean) {
      lateAccount = v;
    },
    set lateNative(v: boolean) {
      lateNative = v;
    },
  };
}
it('saves complete source before HTTP and recovers exactly one actual capture after a lost committed response', async () => {
  const b = boot(),
    s = b.open(),
    before = await f.facts(),
    original = await s.prepareCapture(draft);
  expect(b.requests).toHaveLength(0);
  b.lost = true;
  await expect(s.call(original.id, 'submit')).rejects.toMatchObject({
    kind: 'retry',
  });
  expect(s.saved().actions[0]).toMatchObject({
    intent: original,
    receipt: null,
  });
  s.stop();
  const next = b.open(),
    receipt = await next.call(original.id, 'inspect');
  expect(receipt.state).toBe('applied');
  expect(receipt.after?.sourceJson).toBe(JSON.stringify(draft.source));
  expect(b.requests.map((r) => r.source)).toEqual([
    JSON.stringify(original),
    JSON.stringify(original),
  ]);
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
    payments: 1,
  });
  for (const hidden of [
    config.apiUrl,
    config.publishableKey,
    'original.owner.signature',
    'Bearer',
  ])
    expect([...b.values.values()].join('')).not.toContain(hidden);
});
it('requires unmodified live source and its own current candidate before explicit match and metadata undo', async () => {
  const b = boot(),
    s = b.open();
  await f.sale();
  const capture = await s.prepareCapture(draft);
  await s.call(capture.id, 'submit');
  const page = await s.read(capture.paymentId),
    source = page.source,
    choices = await s.candidates(source),
    target = choices.targets[0];
  expect(() => assertLiveCommandReceipt(target)).not.toThrow();
  await expect(
    s.prepare(structuredClone(source), { type: 'dismiss', reason: 'forged' }),
  ).rejects.toMatchObject({ kind: 'review' });
  await expect(
    s.prepare(source, {
      type: 'link',
      target: structuredClone(target),
      confirmed: true,
    }),
  ).rejects.toMatchObject({ kind: 'review' });
  const before = await f.facts(),
    match = await s.match(source, target.kind, target.id),
    intent = await s.prepare(match.source, {
      type: 'link',
      target: match.target!,
      confirmed: true,
    });
  expect((await s.call(intent.id, 'submit')).after?.status).toBe('matched');
  expect((await f.read()).counts.urgent).toBe(0);
  const latest = (await s.read(source.id)).source,
    undo = await s.prepare(latest, { type: 'undo' });
  expect((await s.call(undo.id, 'submit')).after?.status).toBe('unmatched');
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
  });
});
it('a candidate from a different source cannot prepare a match even with identical economics', async () => {
  const b = boot(),
    s = b.open();
  await f.sale();
  const a = await s.prepareCapture(draft);
  await s.call(a.id, 'submit');
  const first = (await s.read(a.paymentId)).source,
    target = (await s.candidates(first)).targets[0],
    c = await s.prepareCapture(draft);
  await s.call(c.id, 'submit');
  const other = (await s.read(c.paymentId)).source;
  await expect(
    s.prepare(other, { type: 'link', target, confirmed: true }),
  ).rejects.toMatchObject({ kind: 'review' });
  target.labelJson = '"Forged destination"';
  await expect(
    s.prepare(first, { type: 'link', target, confirmed: true }),
  ).rejects.toMatchObject({ kind: 'review' });
});
it('offline closure is saved before HTTP and survives reopening, fencing the exact delayed original', async () => {
  const b = boot(),
    s = b.open(),
    intent = await s.prepareCapture(draft);
  b.offline = true;
  await expect(s.call(intent.id, 'close')).rejects.toMatchObject({
    kind: 'retry',
  });
  expect(s.saved().actions[0].closeRequested).toBe(true);
  s.stop();
  const next = b.open();
  await expect(next.prepareCapture(draft)).rejects.toMatchObject({
    kind: 'review',
  });
  b.offline = false;
  expect((await next.call(intent.id, 'submit')).state).toBe('closed');
  expect(b.requests.at(-1)?.operation).toBe('close');
  expect(await f.facts()).toMatchObject({ payments: 0, tasks: 0 });
});
it('failed native storage cannot send or replace the original, including an unpersisted closure', async () => {
  const b = boot(),
    s = b.open();
  b.quota = true;
  await expect(s.prepareCapture(draft)).rejects.toMatchObject({
    kind: 'review',
  });
  expect(b.requests).toHaveLength(0);
  b.quota = false;
  const original = await s.prepareCapture(draft),
    before = JSON.stringify(s.saved());
  b.quota = true;
  await expect(s.call(original.id, 'close')).rejects.toMatchObject({
    kind: 'review',
  });
  expect(JSON.stringify(s.saved())).toBe(before);
  expect(b.requests).toHaveLength(0);
});
it('late account/native changes cannot accept a completed SQL result into the current view', async () => {
  for (const change of ['account', 'native']) {
    const b = boot(),
      s = b.open(),
      intent = await s.prepareCapture(draft);
    if (change === 'account') b.lateAccount = true;
    else b.lateNative = true;
    await expect(s.call(intent.id, 'submit')).rejects.toBeDefined();
    b.active = true;
    b.native = true;
    expect(s.saved().actions[0].receipt).toBeNull();
    expect((await s.call(intent.id, 'inspect')).state).toBe('applied');
    s.stop();
  }
  expect((await f.read()).counts.urgent).toBe(2);
});
it('an older-role original remains inspectable/closeable but cannot be silently submitted with a new role', async () => {
  const b = boot(),
    s = b.open(),
    original = await s.prepareCapture(draft);
  s.stop();
  await f.db.query("update public.members set role='manager' where id=$1", [
    deviceId(101),
  ]);
  await f.db.query('insert into public.member_outlets values($1,$2,$3)', [
    deviceId(1),
    deviceId(101),
    deviceId(11),
  ]);
  const next = b.open({ ...f.scope(), role: 'manager' });
  await expect(next.call(original.id, 'submit')).rejects.toMatchObject({
    kind: 'review',
  });
  expect((await next.call(original.id, 'close')).state).toBe('closed');
});
it('a changed source or actual finance between read and confirmation cannot overwrite the newer state', async () => {
  const b = boot(),
    s = b.open(),
    sale = await f.sale(),
    original = await s.prepareCapture(draft);
  await s.call(original.id, 'submit');
  const source = (await s.read(original.paymentId)).source,
    target = (await s.candidates(source)).targets[0];
  await f.db.query(
    "update public.sales set voided_at=$1,void_reason='undo',updated_at=$1 where id=$2",
    [Date.now(), sale.id],
  );
  expect((await s.match(source, target.kind, target.id)).eligible).toBe(false);
  const stale = await s.prepare(source, {
    type: 'link',
    target,
    confirmed: true,
  });
  await expect(s.call(stale.id, 'submit')).rejects.toMatchObject({
    kind: 'review',
  });
  expect((await f.source(source.id)).source.status).toBe('unmatched');
});
it('full copies work offline, and verified completed archives retain the entire pending source unchanged', async () => {
  const b = boot(),
    s = b.open(),
    first = await s.prepareCapture(draft);
  await s.call(first.id, 'submit');
  await s.prepareCapture({ ...draft, source: 'Still pending বাংলা\u0000' });
  const before = JSON.stringify(s.saved());
  b.offline = true;
  const copy = await s.copy();
  expect(JSON.parse(copy.contents).actions).toEqual(s.saved().actions);
  await expect(s.prepareArchive()).rejects.toMatchObject({ kind: 'retry' });
  b.offline = false;
  const plan = await s.prepareArchive();
  expect(plan).toMatchObject({ count: 1, pending: 1 });
  await expect(s.finishArchive(plan, true)).rejects.toMatchObject({
    kind: 'review',
  });
  await s.verifyArchiveFile(plan, new TextEncoder().encode(plan.contents));
  await expect(
    s.finishArchive(structuredClone(plan), true),
  ).rejects.toMatchObject({ kind: 'review' });
  expect(await s.finishArchive(plan, true)).toEqual({
    removed: 1,
    retained: 1,
  });
  expect(s.saved().actions).toEqual(JSON.parse(before).actions.slice(1));
});
