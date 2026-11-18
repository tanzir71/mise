# M30 · Canonical cursor groundwork

The existing upload/outbox preserves original local intent and receipt progress.
It does not yet reconcile canonical server rows. The next download path needs a
cursor which cannot skip transactions that commit out of allocation order.

`packages/core/sync-snapshot.ts` implements PostgreSQL snapshot visibility for
top-level transaction IDs. It keeps `xid8` values as decimal strings and `BigInt`,
validates snapshot bounds and the sorted in-flight transaction list, and rejects
backwards snapshots. Parsed state is immutable. A cursor is progress metadata;
it provides no authentication or outlet authorization.

For example, snapshot `10:15:10,12` records transactions 10 and 12 as still in
flight. If transaction 14 has already committed, that does not mean transaction
10 can be discarded. Comparing with `12:18:12,16` includes the newly committed 10
while retaining 12 for a later pull. A largest row ID or audit timestamp cannot
provide this guarantee. Audit times may also preserve original device clocks.

The unit oracle compares visibility directly with PostgreSQL for sixty boundary
cases, including values beyond JavaScript's exact integer range. Other cases
cover first pull, cursor replay, late commit, malformed bounds, duplicate or
unordered in-flight identities, precision loss and backwards progress. A live
read-only check used two independent CLI processes: one transaction remained
open while the other sampled its snapshot. Database timestamps confirmed the
overlap, and PostgreSQL confirmed exclusion before commit and inclusion in a
later snapshot. These probes changed no shop, Auth or credential records.

Use `pg_current_xact_id()` for the eventual capture trigger's top-level identity;
subtransaction IDs are unsuitable for `pg_visible_in_snapshot()`. See the
[PostgreSQL snapshot reference](https://www.postgresql.org/docs/17/functions-info.html).

This increment adds the cursor primitive, not a download endpoint or sync UI.
The change feed still needs scope-safe payload projections, a fixed snapshot
boundary across pages and atomic application after the complete window is staged.
Page row IDs may order a window, but they cannot replace its snapshot cursor.
Canonical application must also extend local coverage accounting without echoing
server writes or overwriting pending original intents. Active operator selection
must be explicit before a multi-member snapshot can replace a one-device shop.

M30, M31 and cloud activation remain incomplete. Existing GitHub workflows and
Pages publication remain stopped by the owner. The
[redacted verification](m30-sync-snapshot-local.json) records this increment.
