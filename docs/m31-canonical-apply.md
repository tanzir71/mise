# Applying downloads while retaining offline work

The internal sync engine can now advance a joined device's canonical snapshot
while preserving its original offline cash, credit and stock intents. Two native
browser databases editing the same outlet offline converge through the actual
SQL-backed HTTP handlers, including original images. Full cloud controls remain
disabled and M30/M31 stay incomplete. The verification record is
[m31-canonical-apply-local.json](m31-canonical-apply-local.json).

The initial join admission and fence remain immutable. A separate current base
and application journal record the accepted cursor, complete working projection,
verified command coverage and original queue fingerprint. Local schema 17 adds
`syncApplications` as the thirty-first internal store. Portable backups remain
schema 10 with their existing 21-table allowlist. A real schema-16 joined shop
with pending cash upgrades without invented application history or changed
images, queue records or admission.

Before applying a download, the engine proves that every working row follows
from the last materialization and subsequent original local transactions. It
checks complete staged records, original image bytes, fixed-snapshot receipt
coverage and fresh account/operator/outlet metadata. A matching audit alone is
never proof that a command was included. Verified visible commands need no new
local receipt; absent or later cash/stock intents are evaluated against the new
canonical values using the same pure domain logic as the hosted writer. The
hosted wrappers still require their original admission tickets.

Original outbox IDs, physical times, before/after records, normalized intents and
receipts are never rewritten to describe a rebased projection. Receipt/status
progress is excluded from the immutable queue fingerprint; the native writer
still compares the complete current queue before committing. Credit uses the
current canonical balance, limit and ledger sequence. Additive stock preserves
intervening movements; an intervening physical count requires review. Unknown
coverage, conflicting intent hashes, unexplained writes and unsupported pending
command families preserve the local copy and prior accepted cursor.

A finite write plan authorizes only the exact expected row transitions inside
one native IndexedDB transaction. It checks the real database transaction,
binding, complete before/after hashes and original Blob bytes. Unexpected hooks
or companion writes abort the whole operation. Changed existing keys are deleted
before replacements are inserted, inside the same locked transaction. This
handles unique ledger/revision slots when an incoming movement takes the pending
movement's old sequence. A native browser regression exposed the ordering bug;
both the native test and a deliberately ordered unit case now cover it. Capture
is never disabled globally and application creates no outgoing echo.

The same writer commits domain rows, current base, application proof and accepted
cursor, then verifies the complete result and unchanged original queue. Quota
failure rolls back everything while retaining staged downloads. Exact retries
after a lost local reply preserve later offline cash. Fresh operator reselection
uses the installed base but cannot unlock from cached proof when the server
context fails. The original join retry continues to refer to its initial
admission after the current base advances.

Four native browser cases use actual HTTP requests, command/read/image handlers,
all committed SQL migrations, real RLS roles and separate IndexedDB contexts:

- An implicit owner and assigned manager save cash and stock offline, reload,
  deliver their original intents, pull changes and converge without duplicate
  sales, stock movements, images or outbox echoes.
- A committed command with a truncated reply is covered without fabricating a
  receipt; exact delivery retry records its real receipt without duplication.
  A truncated page resumes its original fixed window while preserving later cash.
- Native quota failure and subsequent live manager revocation retain the working
  shop, original queue and prior accepted cursor.
- An implicit owner can join another branch; an unassigned manager cannot create
  access, an owner, a fence or a queue on an empty device.

The local service uses explicitly synthetic account verification and an in-memory
object adapter. It proves SQL/HTTP/browser integration, not genuine hosted phone
JWTs, SMS delivery or hosted Storage acceptance. Role-dependent member projections
remain intentionally different; operational data converges without leaking member
contact details. No real Supabase credential or deployment value enters these
fixtures, public evidence or generated assets.

Remaining work includes adopting a version-1 original owner upload into this
canonical application boundary, other unconfirmed command families, scope/epoch
bootstrap, live-account-pinned command delivery, reconnect/realtime orchestration
and the header sync status. Genuine phone OTP, positive hosted owner/image HTTP
and the 5,000-record 3G timing gate remain open. This increment changes no hosted
schema, Auth provider or service deployment. The extracted shared money/stock
logic keeps the existing server admission checks.

GitHub Actions remain disabled at the owner's request. Verification runs locally;
there is no new CI artifact or Pages publication, and the live site remains at
the held revision.
