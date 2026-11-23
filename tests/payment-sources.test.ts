import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { paymentSourcesFixture } from './payment-sources-fixture';
import {
  changePaymentSource,
  parseObservedPayment,
  parsePaymentSourceIntent,
} from '../packages/core/payment-sources';
import { deviceId } from './device-pairing-fixture';
import { newInboxId } from '../packages/core/inbox';
import { paymentSourcesManagedProof } from './payment-sources-managed';
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
it('preserves a genuine manual observation and urgent source task without posting any money, even for literal instructions/NUL/surrogates', async () => {
  const before = await f.facts(),
    intent = f.capture(),
    receipt = await f.call(intent);
  expect(receipt).toMatchObject({
    state: 'applied',
    before: null,
    after: {
      id: intent.paymentId,
      status: 'unmatched',
      origin: 'manual',
      sourceJson: intent.sourceJson,
      amount: 10000,
    },
  });
  expect(await f.call(intent, 'inspect')).toEqual(receipt);
  const page = await f.source(intent.paymentId);
  expect(page.source).toEqual(receipt.after);
  const tasks = await f.read();
  expect(tasks.counts).toMatchObject({ total: 1, urgent: 1, failure: 1 });
  expect(tasks.tasks[0]).toMatchObject({
    id: intent.taskId,
    source: 'payment',
    mode: 'source',
    urgent: true,
    target: { kind: 'payment', paymentId: intent.paymentId },
    actions: [],
  });
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
    payments: 1,
    tasks: 1,
    actions: 1,
  });
});
it('links an actual recorded receipt, closes its task and undoes only that match while retaining money byte for byte', async () => {
  const sale = await f.sale(),
    intent = f.capture(),
    captured = (await f.call(intent)).after!,
    before = await f.facts(),
    candidate = await f.match(intent.paymentId, 'sale', sale.id);
  expect(candidate.eligible).toBe(true);
  const link = changePaymentSource(f.scope(), captured, {
      type: 'link',
      target: candidate.target!,
      confirmed: true,
    }),
    receipt = await f.call(link);
  expect(receipt.after?.status).toBe('matched');
  expect((await f.read()).counts.total).toBe(0);
  expect((await f.read(1, 11, 'resolved')).tasks[0]).toMatchObject({
    source: 'payment',
    urgent: false,
  });
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
  });
  const undo = changePaymentSource(f.scope(), receipt.after!, { type: 'undo' });
  expect((await f.call(undo)).after).toMatchObject({
    status: 'unmatched',
    match: null,
  });
  expect((await f.read()).counts.urgent).toBe(1);
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
  });
});
it('a later financial reversal reopens the actual source task without rewriting its original match receipt', async () => {
  const sale = await f.sale(),
    original = f.capture(),
    source = (await f.call(original)).after!,
    target = (await f.match(original.paymentId, 'sale', sale.id)).target!,
    action = changePaymentSource(f.scope(), source, {
      type: 'link',
      target,
      confirmed: true,
    }),
    receipt = await f.call(action);
  await f.db.query(
    "update public.sales set voided_at=$1,void_reason='undo',updated_at=$1 where id=$2",
    [Date.now(), sale.id],
  );
  expect((await f.source(original.paymentId)).source).toMatchObject({
    status: 'review',
    match: { valid: false, current: null },
  });
  expect((await f.read()).tasks[0]).toMatchObject({
    id: original.taskId,
    urgent: true,
    status: 'open',
  });
  expect(await f.call(action, 'inspect')).toEqual(receipt);
});
it('denies wrong roles/outlets, wrong amounts and altered actual target snapshots without changing the source', async () => {
  const sale = await f.sale(),
    intent = f.capture(),
    source = (await f.call(intent)).after!;
  await expect(f.source(intent.paymentId, 3)).rejects.toMatchObject({
    code: '42501',
  });
  await expect(f.source(intent.paymentId, 2, 12)).rejects.toMatchObject({
    code: '42501',
  });
  const other = await f.sale('101');
  expect((await f.match(intent.paymentId, 'sale', other.id)).eligible).toBe(
    false,
  );
  const target = (await f.match(intent.paymentId, 'sale', sale.id)).target!,
    link = changePaymentSource(f.scope(), source, {
      type: 'link',
      target: { ...target, fingerprint: '0'.repeat(64) },
      confirmed: true,
    });
  await expect(f.callRaw(link)).rejects.toMatchObject({ code: 'PT409' });
  expect((await f.source(intent.paymentId)).source).toEqual(source);
  expect(() =>
    parsePaymentSourceIntent({ ...link, confirmed: false }),
  ).toThrow();
  expect(() =>
    parseObservedPayment({ ...source, status: 'matched' }),
  ).toThrow();
});
it('original close fences a delayed capture after membership removal and cannot rebind another original', async () => {
  const intent = f.capture();
  expect((await f.call(intent, 'inspect')).state).toBe('pending');
  await f.db.query('update public.members set active=false where id=$1', [
    deviceId(101),
  ]);
  const closed = await f.call(intent, 'close');
  expect(closed.state).toBe('closed');
  expect(await f.call(intent)).toEqual(closed);
  await expect(
    f.callRaw({ ...intent, amount: 11000 }, 'inspect'),
  ).rejects.toMatchObject({ code: 'PT409' });
  expect(await f.facts()).toMatchObject({ payments: 0, tasks: 0 });
});
it('one actual financial receipt cannot resolve two observed sources', async () => {
  const sale = await f.sale(),
    first = f.capture(),
    a = (await f.call(first)).after!,
    second = f.capture(),
    b = (await f.call(second)).after!,
    target = (await f.match(first.paymentId, 'sale', sale.id)).target!;
  await f.call(
    changePaymentSource(f.scope(), a, {
      type: 'link',
      target,
      confirmed: true,
    }),
  );
  expect((await f.match(second.paymentId, 'sale', sale.id)).eligible).toBe(
    false,
  );
  await expect(
    f.callRaw(
      changePaymentSource(f.scope(), b, {
        type: 'link',
        target,
        confirmed: true,
      }),
    ),
  ).rejects.toMatchObject({ code: 'PT409' });
  expect((await f.source(second.paymentId)).source.status).toBe('unmatched');
});
it('matches an actual paid order while its sale cannot bypass the order target, and reopens after real payment undo', async () => {
  const order = await f.paidOrder(),
    intent = f.capture(),
    source = (await f.call(intent)).after!,
    before = await f.facts(),
    target = await f.match(intent.paymentId, 'order', order.id);
  expect(target.eligible).toBe(true);
  expect(
    (await f.match(intent.paymentId, 'sale', order.payment.saleId!)).target,
  ).toBeNull();
  const receipt = await f.call(
    changePaymentSource(f.scope(), source, {
      type: 'link',
      target: target.target!,
      confirmed: true,
    }),
  );
  expect(receipt.after?.match?.target.financialId).toBe(order.payment.saleId);
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
  });
  await f.db.query(
    'update public.orders set payment=$1,revision=revision+1,updated_at=$2 where id=$3',
    [
      JSON.stringify({ method: 'cash', status: 'pending' }),
      Date.now(),
      order.id,
    ],
  );
  expect((await f.source(intent.paymentId)).source.status).toBe('review');
  expect((await f.read()).counts.urgent).toBe(1);
});
it('matches an actual khata payment and observes its reversal without collecting any money twice', async () => {
  const entry = await f.paidCredit(),
    intent = f.capture(),
    source = (await f.call(intent)).after!,
    before = await f.facts(),
    target = (await f.match(intent.paymentId, 'credit', entry.id)).target!;
  expect(target.kind).toBe('credit');
  await f.call(
    changePaymentSource(f.scope(), source, {
      type: 'link',
      target,
      confirmed: true,
    }),
  );
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
  });
  await f.reverseCredit(entry);
  expect((await f.source(intent.paymentId)).source).toMatchObject({
    status: 'review',
    match: { valid: false, current: null },
  });
  expect((await f.read()).counts.urgent).toBe(1);
});
it('dismissal and capture withdrawal are explicit reversible metadata choices with an actual undo audit', async () => {
  const intent = f.capture(),
    captured = (await f.call(intent)).after!,
    before = await f.facts(),
    dismiss = changePaymentSource(f.scope(), captured, {
      type: 'dismiss',
      reason: 'Not a payment. বাংলা\u0000 ' + String.fromCharCode(0xd800),
    }),
    receipt = await f.call(dismiss);
  expect(receipt.after).toMatchObject({ status: 'dismissed', match: null });
  expect((await f.read()).counts.total).toBe(0);
  const undo = changePaymentSource(f.scope(), receipt.after!, { type: 'undo' });
  expect((await f.call(undo)).after?.status).toBe('unmatched');
  expect(
    (
      await f.db.query<{ undo: string }>(
        'select undo_of as undo from public.events where id=$1',
        [undo.eventId],
      )
    ).rows[0].undo,
  ).toBe(dismiss.eventId);
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
  });
  const second = f.capture(),
    other = (await f.call(second)).after!,
    withdraw = changePaymentSource(f.scope(), other, { type: 'undo' });
  expect((await f.call(withdraw)).after).toMatchObject({
    status: 'dismissed',
    reasonJson: JSON.stringify('Observation withdrawn'),
  });
  expect((await f.call(second, 'inspect')).after?.status).toBe('unmatched');
});
it('payment-source tasks cannot be resolved through a forged generic Fixed action', async () => {
  const intent = f.capture();
  await f.call(intent);
  const task = (await f.read()).tasks[0],
    before = await f.facts();
  await expect(
    f.asRole(
      1,
      'authenticated',
      'select public.act_owner_task($1,$2,$3) data',
      [
        intent.scope.outletId,
        'submit',
        JSON.stringify({
          v: 1,
          id: newInboxId(),
          eventId: newInboxId(),
          scope: f.scope(),
          at: Date.now(),
          type: 'act',
          task,
          action: 'fixed',
          replyJson: '""',
          undoOf: null,
        }),
      ],
    ),
  ).rejects.toMatchObject({ code: 'PT409' });
  expect(await f.facts()).toEqual(before);
});
it('assigned managers can record sources while forged role claims and service/direct table access remain denied', async () => {
  const manager = f.capture({}, 2);
  expect((await f.call(manager, 'submit', 2)).state).toBe('applied');
  for (const role of ['anon', 'service_role'] as const)
    await expect(
      f.asRole(
        role === 'anon' ? null : 1,
        role,
        'select public.read_payment_source($1,$2) data',
        [deviceId(11), manager.paymentId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  for (const table of [
    'payment_sources',
    'payment_source_states',
    'payment_source_actions',
  ])
    await expect(
      f.asRole(
        1,
        'authenticated',
        'select count(*) data from private.' + table,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  await expect(
    f.callRaw(
      { ...f.capture({}, 2), scope: { ...f.scope(2), role: 'owner' } },
      'submit',
      2,
    ),
  ).rejects.toMatchObject({ code: '42501' });
  expect(
    (
      await f.db.query<{ count: number }>(
        "select count(*)::integer count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('payment_sources','payment_source_states','payment_source_actions') and c.relrowsecurity and c.relforcerowsecurity",
      )
    ).rows[0].count,
  ).toBe(3);
});
it('a changed source fingerprint cannot overwrite a newer human review, including a delayed last-choice undo', async () => {
  const intent = f.capture(),
    source = (await f.call(intent)).after!,
    first = changePaymentSource(f.scope(), source, {
      type: 'dismiss',
      reason: 'First review',
    }),
    last = (await f.call(first)).after!,
    next = changePaymentSource(f.scope(), last, {
      type: 'dismiss',
      reason: 'Later review',
    });
  await f.call(next);
  await expect(
    f.callRaw(changePaymentSource(f.scope(), last, { type: 'undo' })),
  ).rejects.toMatchObject({ code: 'PT409' });
  await expect(
    f.callRaw(
      changePaymentSource(f.scope(), source, {
        type: 'dismiss',
        reason: 'Old review',
      }),
    ),
  ).rejects.toMatchObject({ code: 'PT409' });
  expect((await f.source(intent.paymentId)).source.reasonJson).toBe(
    JSON.stringify('Later review'),
  );
});
it('two phone accounts may share a personal action ID while undo still finds the actual latest source choice', async () => {
  const sale = await f.sale(),
    capture = f.capture(),
    source = (await f.call(capture)).after!,
    target = (await f.match(capture.paymentId, 'sale', sale.id, 2)).target!,
    link = {
      ...changePaymentSource(f.scope(2), source, {
        type: 'link',
        target,
        confirmed: true,
      }),
      id: capture.id,
    };
  const linked = await f.call(link, 'submit', 2),
    undone = await f.call(
      changePaymentSource(f.scope(), linked.after!, { type: 'undo' }),
    );
  expect(undone.after).toMatchObject({
    status: 'unmatched',
    match: null,
    reasonJson: null,
  });
  expect(await f.call(capture, 'inspect')).toMatchObject({
    after: { revision: 0, status: 'unmatched' },
  });
  expect(await f.call(link, 'inspect', 2)).toMatchObject({
    after: { revision: 1, status: 'matched' },
  });
});
it('a malformed capture or target cannot reserve a personal closure or write any source', async () => {
  const original = f.capture();
  for (const patch of [
    { amount: 0 },
    { amount: 1.5 },
    { amount: '10000' },
    { currency: 'bdt' },
    { fromPhone: '01712345482' },
    { sourceJson: '"   "' },
    { methodNameJson: '""' },
    { origin: 'notification' },
    { scope: { ...original.scope, unexpected: true } },
  ])
    await expect(
      f.asRole(
        1,
        'authenticated',
        'select public.act_payment_source($1,$2,$3) data',
        [
          original.scope.outletId,
          'close',
          JSON.stringify({ ...original, ...patch }),
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
  expect(await f.facts()).toMatchObject({ payments: 0, tasks: 0, actions: 0 });
  const sale = await f.sale(),
    captured = (await f.call(original)).after!,
    target = (await f.match(original.paymentId, 'sale', sale.id)).target!;
  const link = changePaymentSource(f.scope(), captured, {
      type: 'link',
      target,
      confirmed: true,
    }),
    before = await f.facts();
  for (const patch of [
    { amount: null },
    { amount: 10000.5 },
    { currency: 'bdt' },
    { methodNameJson: '" "' },
    { id: 123 },
    { fingerprint: 'f' },
    { outletId: deviceId(12) },
    { extra: true },
  ])
    await expect(
      f.asRole(
        1,
        'authenticated',
        'select public.act_payment_source($1,$2,$3) data',
        [
          original.scope.outletId,
          'close',
          JSON.stringify({ ...link, target: { ...target, ...patch } }),
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
  expect(await f.facts()).toEqual(before);
});
it('undoing a dismissal after financial reversal restores a review task and its original association, without restoring money', async () => {
  const sale = await f.sale(),
    intent = f.capture(),
    source = (await f.call(intent)).after!,
    target = (await f.match(intent.paymentId, 'sale', sale.id)).target!,
    linked = (
      await f.call(
        changePaymentSource(f.scope(), source, {
          type: 'link',
          target,
          confirmed: true,
        }),
      )
    ).after!,
    dismissed = (
      await f.call(
        changePaymentSource(f.scope(), linked, {
          type: 'dismiss',
          reason: 'Checked by hand',
        }),
      )
    ).after!;
  await f.db.query(
    "update public.sales set voided_at=$1,void_reason='undo',updated_at=$1 where id=$2",
    [Date.now(), sale.id],
  );
  const current = (await f.source(intent.paymentId)).source,
    before = await f.facts();
  expect(current.status).toBe('dismissed');
  expect(current.fingerprint).toBe(dismissed.fingerprint);
  const undone = await f.call(
    changePaymentSource(f.scope(), current, { type: 'undo' }),
  );
  expect(undone.after).toMatchObject({
    status: 'review',
    match: { valid: false, current: null, target },
  });
  expect((await f.read()).counts.urgent).toBe(1);
  expect(await f.facts()).toMatchObject({
    sales: before.sales,
    entries: before.entries,
  });
});
it('rejects equal amounts in different currencies or payment methods, including direct RPC bypass attempts', async () => {
  const sale = await f.sale(),
    wrongCurrency = f.capture({ currency: 'USD' }),
    wrongMethod = f.capture({ method: 'card', methodName: 'Card' });
  for (const intent of [wrongCurrency, wrongMethod]) {
    const source = (await f.call(intent)).after!,
      candidate = await f.match(intent.paymentId, 'sale', sale.id);
    expect(candidate.eligible).toBe(false);
    const raw = {
      v: 1,
      id: newInboxId(),
      eventId: newInboxId(),
      at: Date.now(),
      type: 'link',
      scope: f.scope(),
      paymentId: intent.paymentId,
      fingerprint: source.fingerprint,
      target: candidate.target,
      confirmed: true,
    };
    await expect(
      f.asRole(
        1,
        'authenticated',
        'select public.act_payment_source($1,$2,$3) data',
        [intent.scope.outletId, 'submit', JSON.stringify(raw)],
      ),
    ).rejects.toMatchObject({ code: 'PT409' });
  }
  expect((await f.read()).counts.urgent).toBe(2);
});
it('bounds unknown closures without blocking exact retries or genuine observations', async () => {
  const originals = Array.from({ length: 1000 }, () => f.capture());
  const states = await f.asRole<string[]>(
    1,
    'authenticated',
    "select array_agg(public.act_payment_source($1,'close',v)->>'state') data from unnest($2::text[]) v",
    [deviceId(11), originals.map((intent) => JSON.stringify(intent))],
  );
  expect(states).toHaveLength(1000);
  expect(states.every((state) => state === 'closed')).toBe(true);
  await expect(f.call(f.capture(), 'close')).rejects.toMatchObject({
    code: 'PT429',
  });
  expect((await f.call(originals[0])).state).toBe('closed');
  expect(await f.facts()).toMatchObject({
    payments: 0,
    tasks: 0,
    actions: 1000,
  });
  expect((await f.call(f.capture())).state).toBe('applied');
}, 60000);
it('runs the exact installation role proof and rolls back all synthetic source and Auth records', async () => {
  const result = await f.db.exec(await paymentSourcesManagedProof());
  const proof = result
    .flatMap((row) => row.rows)
    .find((row) => Object.hasOwn(row, 'proof'))?.proof;
  expect(proof).toMatchObject({
    actualSources: 2,
    actualFinancialReceipts: 1,
    unknownClosures: 1,
    financialWritesBySource: 0,
    providerRequests: 0,
    rolledBack: true,
  });
  expect(Number((proof as { checks: number }).checks)).toBeGreaterThan(45);
  expect(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::int n from auth.users where id in('00000000-0000-4000-8000-000000009975','00000000-0000-4000-8000-000000009976')",
      )
    ).rows[0].n,
  ).toBe(0);
});
