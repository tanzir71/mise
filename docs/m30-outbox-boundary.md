# M30 · Initial upload and the local change queue

An immutable reviewed snapshot can now upload while later local edits remain in
the working copy and a durable queue. This is the storage and delivery boundary
required before the full upload interface can be enabled. M30 remains in progress.

Local IndexedDB schema 11 adds `cloudState` and `outbox` alongside the existing shop
tables. The portable backup stays at schema 10, with exactly 21 explicit tables.
Sync state, recovery rows, receipts, connection fingerprints and credentials never
enter that backup. Upgrades preserve shop records and original image bytes.

`beginLocalUpload` checks the exact reviewed snapshot while holding the shop's write
transaction, then arms a persistent sequence fence. The connection target is a
digest of the project, publishable key, base/shop scope and verified Auth user ID.
The digest is an identity binding, not a credential or an authorization decision.
Actual project/key values and JWTs remain outside the sync stores.

The DBCore capture layer extends every shop write's native transaction with both
internal stores. This also covers the share-receiving worker, narrow transactions,
bulk modification and range deletion. A transaction retains its first original
and final value for every changed row, including immutable image Blobs. Parallel
writes serialize their recovery checkpoints. Failure to write the queue or fence
aborts the original transaction, preserving the money/audit/queue boundary even if
the caller catches the error. Failure during a local financial command's writes
also aborts that write transaction. A later remote rejection keeps the local copy
and original queued intent for review.

The middleware runs below user hooks and above observability. It uses Dexie promise
continuations to keep the transaction zone. Original and resulting rows are read
without the existing-values cache: an insertion can otherwise leave its earlier
cached absence visible. Committed internal writes notify normal live-query readers.
See the [Dexie middleware reference](https://dexie.org/docs/Dexie/Dexie.use()).

Before promotion and receipt acceptance, the client reconstructs the working copy
from the original snapshot and the complete, gap-free recovery sequence. Exact
before-values, final record graph and image bytes must agree with the current
backup. Missing rows, changed identities or an incompatible target stop acceptance.
The local copy and snapshot remain available for recovery.

Counter sales, credit sales, sale undo, khata payment, entry undo and manual khata
communications now attach explicit domain intents to their actual writes. Device
record, related financial and audit IDs retain their original values. The queue
sends only parsed domain intents to the authenticated command endpoint. Recovery
row changes are never sent to a raw-write API. The runtime transport uses a
publishable key and the original verified caller JWT; it pins the endpoint, blocks
redirects, uses no-store responses and preserves the reviewed large-body admission
headers. Errors do not expose backend details.

Delivery preserves order and saves each accepted intent receipt before proceeding.
A new queue ID is insert-only; later checkpoints update only that transaction's
entry. Delivery refuses an incomplete sequence instead of skipping missing work.
A lost response retries the same original ID, allowing the server's existing
idempotent receipt to confirm the action. Retained/unclassified work blocks later
delivery; a transaction mixing known and unsupported writes remains retained as a
whole. Financial server deadlines still apply to old offline undo requests. Local
values and accepted receipts remain available for the canonical reconciliation
required by M31; an accepted receipt does not claim the local copy is fully synced.

An initial upload resumes through staging edits, lost part responses and a lost
finish response. A server-accepted snapshot keeps its original receipt and all later
local changes. Cancellation stops capture only after the server confirms the
unaccepted staging upload was cancelled. Offline or failed cancellation keeps
capture active. Accepted uploads cannot be cancelled through this path. Cancelled
history remains saved, and another attempt requires a fresh reviewed upload ID.
Restore cannot silently overwrite an active boundary or unsent work.

Local verification passes lint/typechecking, 1,601 unit tests across 90 files and
314 browser tests without retries, skips, failures or global errors. Both `/` and
`/mise/` builds pass, with five focused boundary/Auth checks also passing at `/`.
The source/index/history/artifact audit compares nine private deployment values;
it finds no credentials or current deployment references. The 22 historical
nonsecret identifier findings remain preserved in published history.

[Redacted verification](m30-outbox-local.json) records the local unit, native browser,
build and credential checks. Browser fixtures arm a synthetic local boundary to
exercise real Chromium saves, backups and the receiving worker; no real hosted
Auth user, SMS or owner JWT is created. No visual layout changed. The previous
M30 Auth visual report remains the layout evidence; no new visual run or CI artifact
is claimed.

Remaining: all nonfinancial command adapters, canonical receipt/pull reconciliation,
full upload/outbox controls, real production OTP and positive signed-owner HTTP
proof, plus the other open M30 resources and acceptance gates. The default-off
`cloudSetup` interface still offers sign-in and a local count review only. All
GitHub workflows remain disabled by the owner; Pages stays at
`9ea1991f370fcdc0bb6bf6e2468baa9163d7b0bc`.
