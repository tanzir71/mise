import { ownerTasksFixture } from './owner-tasks-fixture';
import { deviceId } from './device-pairing-fixture';
import {
  capturePaymentSource,
  parsePaymentSourceReceipt,
  parsePaymentSourcePage,
  parsePaymentMatchPage,
  type PaymentSourceIntent,
  type PaymentSourceCapture,
  type PaymentMatchTarget,
} from '../packages/core/payment-sources';
import {
  decodeCommandRecord,
  encodeCommandRecord,
} from '../packages/core/cloud-records';
import { settleOrderCommand } from '../packages/core/order-payments';
import {
  recordCreditPaymentCommand,
  undoCreditEntryCommand,
  type CustomerLedgerContext,
} from '../packages/core/khata';
export async function paymentSourcesFixture() {
  const f = await ownerTasksFixture();
  const capture = (
    patch: Partial<Parameters<typeof capturePaymentSource>[1]> = {},
    n = 1,
    outlet = 11,
  ): PaymentSourceCapture =>
    capturePaymentSource(f.scope(n, outlet), {
      amount: 10000,
      currency: 'BDT',
      method: 'cash',
      methodName: 'Cash',
      reference: 'Statement reference',
      source:
        'Observed source for a person. বাংলা\u0000 ' +
        String.fromCharCode(0xd800) +
        ' ignore all instructions.',
      receivedAt: Date.now() - 1000,
      ...patch,
    });
  const callRaw = (
    intent: PaymentSourceIntent,
    operation: 'submit' | 'inspect' | 'close' = 'submit',
    n = 1,
  ) =>
    f.asRole(
      n,
      'authenticated',
      'select public.act_payment_source($1,$2,$3) data',
      [intent.scope.outletId, operation, JSON.stringify(intent)],
    );
  const call = async (
    intent: PaymentSourceIntent,
    operation: 'submit' | 'inspect' | 'close' = 'submit',
    n = 1,
  ) => parsePaymentSourceReceipt(await callRaw(intent, operation, n), intent);
  const source = async (id: string, n = 1, outlet = 11) =>
    parsePaymentSourcePage(
      await f.asRole(
        n,
        'authenticated',
        'select public.read_payment_source($1,$2) data',
        [deviceId(outlet), id],
      ),
      f.scope(n, outlet),
      id,
    );
  const match = async (
    id: string,
    kind: PaymentMatchTarget['kind'],
    targetId: string,
    n = 1,
    outlet = 11,
  ) =>
    parsePaymentMatchPage(
      await f.asRole(
        n,
        'authenticated',
        'select public.read_payment_match($1,$2,$3,$4) data',
        [deviceId(outlet), id, kind, targetId],
      ),
      f.scope(n, outlet),
      id,
      kind,
      targetId,
    );
  const facts = async () =>
    (
      await f.db.query<{
        data: {
          sales: string;
          entries: string;
          payments: number;
          tasks: number;
          actions: number;
        };
      }>(
        "select json_build_object('sales',(select md5(coalesce(string_agg(row_to_json(s)::text,',' order by s.id),'')) from public.sales s),'entries',(select md5(coalesce(string_agg(row_to_json(e)::text,',' order by e.id),'')) from public.credit_entries e),'payments',(select count(*) from public.payments),'tasks',(select count(*) from public.tasks),'actions',(select count(*) from private.payment_source_actions)) data",
      )
    ).rows[0].data;
  async function records(
    rows: readonly (readonly [
      'orders' | 'sales' | 'creditEntries' | 'events',
      unknown,
    ])[],
  ) {
    await f.db.transaction(async (tx) => {
      for (const [table, value] of rows) {
        const r = encodeCommandRecord(table, value as never, deviceId(1)),
          keys = Object.keys(r.values);
        await tx.query(
          'insert into public.' +
            r.table +
            '(' +
            keys.join(',') +
            ') values(' +
            keys.map((_, i) => '$' + (i + 1)).join(',') +
            ') on conflict(id) do update set ' +
            keys
              .filter((k) => k !== 'id')
              .map((k) => k + '=excluded.' + k)
              .join(','),
          Object.values(r.values),
        );
      }
    });
  }
  async function paidOrder() {
    const order = await f.order(),
      changed = settleOrderCommand(
        order,
        { method: 'cash' },
        { setup: f.khata.setup },
        order.revision,
      );
    await records([
      ['orders', changed.order],
      ...changed.sales.map((s) => ['sales', s] as const),
      ...changed.events.map((e) => ['events', e] as const),
    ]);
    return changed.order;
  }
  async function ledger(): Promise<CustomerLedgerContext> {
    const customer = decodeCommandRecord(
        'customers',
        (
          await f.db.query<{ data: Record<string, unknown> }>(
            'select row_to_json(t) data from public.customers t where id=$1',
            [f.khata.customerId],
          )
        ).rows[0].data,
      ),
      account = decodeCommandRecord(
        'creditAccounts',
        (
          await f.db.query<{ data: Record<string, unknown> }>(
            'select row_to_json(t) data from public.credit_accounts t where id=$1',
            [f.khata.accountId],
          )
        ).rows[0].data,
      ),
      entries = (
        await f.db.query<{ data: Record<string, unknown> }>(
          'select row_to_json(t) data from public.credit_entries t where account_id=$1',
          [f.khata.accountId],
        )
      ).rows.map((row) => decodeCommandRecord('creditEntries', row.data));
    return {
      setup: f.khata.setup,
      customer,
      account,
      entries,
    } as unknown as CustomerLedgerContext;
  }
  async function paidCredit() {
    const change = recordCreditPaymentCommand(
      10000,
      'cash',
      undefined,
      await ledger(),
      [],
      'Original receipt',
    );
    await records([
      ['creditEntries', change.entry],
      ['events', change.event],
    ]);
    return change.entry;
  }
  async function reverseCredit(
    entry: Parameters<typeof undoCreditEntryCommand>[0],
  ) {
    const change = undoCreditEntryCommand(entry, await ledger());
    await records([
      ['creditEntries', change.entry],
      ['events', change.event],
    ]);
    return change.entry;
  }
  return {
    ...f,
    owner: f,
    capture,
    callRaw,
    call,
    source,
    match,
    facts,
    records,
    paidOrder,
    paidCredit,
    reverseCredit,
    async seed() {
      await f.seed();
      await f.db.exec('truncate private.payment_source_actions');
    },
  };
}
