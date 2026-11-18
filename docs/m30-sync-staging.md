# M30 · Durable local download staging

A device saves the original read request before its first HTTP call. Its source
binds the account, actor, role, outlet, connection fingerprint, prior cursor and
local upload identity. Actual project URLs, API keys, Auth UUIDs and sessions do
not enter this journal. The server remains responsible for current authorization.
An empty second device can stage a download without inventing a local upload.

IndexedDB schema 12 adds three internal stores in the same database as the shop:
`syncReads`, `syncPages` and `syncRecords`. The explicit portable backup remains
schema 10 with its original 21 tables. Upgrading retains every existing shop row,
image Blob, upload receipt and outbox entry. The worker uses the shared schema.
The outgoing capture fence still includes only its original two internal stores;
staging does not unnecessarily extend every counter transaction's lock set.

Each page and its position commit together. Exact replay is a no-op, while changed
source identities or page contents require recovery. Fragment checks cross page
boundaries, preserve 64-bit change numbers and reject gaps, repeated fragments,
backwards records and incomplete final rows. Pages survive lost replies, closing
the database, offline reload, storage failure and concurrent tabs.

After the final page is durable, verification reconstructs complete records,
checks their full original SHA-256 hashes and validates their explicit projections
and scope. This preserves literal NUL, lone UTF-16 surrogates and UTF-8 fragments.
Large rows span pages; no row is silently skipped. Verified records are insert-only,
with exact comparison on replay. A storage failure can leave a verified prefix;
the original pages and prefix remain available for retry.

Only a fully verified window receives an integrity seal covering its source,
window, ordered page hashes, record hashes and received cursor. Verification
rechecks saved pages and records, including when an earlier seal exists. A seal
is local integrity evidence, never server authority or proof of convergence.
The received cursor is a candidate for later atomic application; this increment
does not advance an accepted cursor, replace shop records, create local events or
change original queued intents and receipts.

Local edits remain available during downloads. The local binding comparison omits
only the mutable queue sequence, retaining its original upload/receipt and target
identities. Financial writes still enter their original native transaction and
remain provable against the original upload snapshot. A changed account/binding
cannot append an old response under the new connection.

Verification covers the SQL → HTTP handler → browser transport → journal path,
full record hashes, a 5,000-record functional download, corruption, quota failures,
partial verification, tombstones, empty devices, upgrades and concurrent readers.
Native browser tests use an intercepted, local-only fixture outside shipped assets.
They exercise offline reload with a cash receipt and downloaded backup, two tabs,
progress rollback, an empty device and a schema 11 upgrade retaining an original
image, cash intent and accepted upload. This is not genuine hosted owner/OTP or
the required upload under 3G throttle. See [redacted evidence](m30-sync-staging-local.json).

Explicit active operator/outlet selection, immutable remote coverage, trusted
atomic canonical application, pending-intent reconciliation, image-byte delivery,
complete cloud controls and the remaining M30/M31 acceptance gates remain open.
There is no user-facing sync activation. Hosted configuration is unchanged;
GitHub workflows and Pages publication remain stopped by the owner.
