# Original command coverage in a canonical snapshot

M30/M31 remain incomplete. This increment proves whether an original command's
accepted receipt is visible in the fixed snapshot of a completed download. It
does not apply domain rows, remove queued actions, accept a cursor or activate
cloud controls. The verification record is
[m31-receipt-coverage-local.json](m31-receipt-coverage-local.json).

Each newly inserted private command receipt records the current top-level
PostgreSQL transaction identity. Existing receipts keep a null identity; a
migration, replay or matching audit ID cannot manufacture their admission proof.
Catalogue receipt construction can finish within its original transaction.
After commit, changing either the receipt or its admission identity is rejected.
The identity uses `xid8`, and snapshot visibility is checked inside PostgreSQL,
without converting transaction IDs to JavaScript numbers. See the
[PostgreSQL transaction/snapshot functions](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-PG-SNAPSHOT).

The existing `sync-read` service accepts a coverage request for at most 128
distinct original command IDs. Its private RPC requires a completed window and
rechecks the current account, operator, outlet, role, epoch, scope version and
expiry before returning even a cached reply. A shared read helper also rejects
anonymous phone accounts before reading request bodies. Receipts from another
account or actor are concealed as absent. The private cache is forced-RLS and
has no client table grants. Each window permits at most 1,024 distinct batches.

Replies carry the same signed cursor as the completed download and only four
facts per command: original ID, type, normalized intent hash and visibility.
They exclude Auth UUIDs, receipt payloads, receipt admission identities, private source values
and connection details. Compressed wire hashes, bounded readers and strict
projection checks remain in place. The runtime transport pins the original JWT
and connection/account fingerprints, excludes cookies and redirects, rechecks
the account after the complete response, and limits the whole operation to
120 seconds. Only fixed errors leave that boundary.

`visible` means the accepted receipt belongs to the fixed snapshot. `later`
means it was accepted outside that snapshot. `unknown` retains an older receipt
without reliable admission proof. `absent` is an unconfirmed observation, not
proof that a command never existed. An exact cached absence stays unchanged
after a later commit. Only a visible fact with the original type and complete
normalized intent hash can cover an overlay; different hashes remain conflicts.

Schema 15 adds internal `syncCoverage`, separate from the unchanged schema-10,
21-table portable backup. The original sorted batch, source seal and fingerprints
are durable before networking. Native transactions recheck the original binding
and read state before saving a result. Offline reads verify its complete hash.
Corrupt evidence is retained, quota failure leaves the original request ready
for retry, and two tabs retain one immutable result. Original queue commands,
changes and receipts are not rewritten or marked accepted by this reader.

Tests cover actual committed local PostgreSQL cash and catalogue transactions,
late admission, exact replay, genuine pre-migration unknowns, Auth/assignment
revocation, native IndexedDB recovery and a complete client → HTTP handler →
SQL-role → compressed response → durable local proof. The real schema-14 browser
upgrade retains original source images, full verified cached bytes, selected
operator, accepted upload receipt, cash queue and download pages.

The separately rolled-back hosted SQL-role proof checks scope and authorization;
its own uncommitted receipt correctly remains outside its snapshot. It does not
represent genuine phone/JWT HTTP acceptance or two-browser convergence. Legitimate
joined-device admission, canonical application and pending-intent reconciliation
remain required. Phone OTP, genuine owner/image HTTP and 3G acceptance also remain
open. GitHub Actions and Pages publication stay held by the owner.

The first full run passed 394 of 395 checks and exposed a PWA first-activation
race in an existing upload-review test. Two of twelve diagnostic runs observed
an activated worker with an uncontrolled document. A deterministic regression
holds a real navigation across worker activation and fails in that same state
before the fix. Registration now asks the existing active worker to claim the
committed owner page. The worker validates the real client ID, origin, path and
top-level frame; public-shop pages are excluded. It neither reloads the cash
draft nor activates a waiting update. The native regression passes after the
fix and verifies a real offline cash save and reload. Both initial failures and
final verification remain recorded; no assertion or timeout is relaxed.

The function is deployed as the repository's existing self-contained Edge bundle.
An initial unbundled CLI attempt could not resolve extensionless shared imports;
the successful deployment uses the same verified sources without changing their
imports. `sync-read` is version 2 with JWT verification enabled. No other function
version, secret or Auth setting changes. Actual service/RPC requests without a
user JWT return 401. The live function also returns 204 for the allowed owner's
CORS preflight, including the required outlet header. This proves readiness,
not genuine owner authentication.

Final checks pass: **2,201 unit tests across 116 files**, **396 browser checks**
with two workers, **39 root-path browser checks**, **50 visual comparisons** with
no horizontal overflow, and **25 identical local/hosted SQL-role checks**. Both
build bases, lint and typecheck pass; all 270 exports remain present. The worker
fix also passes all twelve repeated diagnostics and 22 related parallel checks.
Hosted state has 34 migrations, 57 forced-RLS application tables, one private
bucket and zero Auth users. Phone, email and anonymous providers remain disabled,
with phone auto-confirm off and signups disabled. GitHub Actions and Pages remain
held; no CI artifact or new Pages deployment is claimed.
