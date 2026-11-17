# M30 · Audited stock commands

The command service now supports stock item creation/editing, archive/restore,
manual and quick movements, physical night counts and stock-movement undo. The
existing local stock domain supplies quantity, unit, name, supplier and undo
validation. Quantities still use exact integer thousandths internally. The local
app remains usable offline; cloud controls and the outbox remain unavailable.

Commands retain the device's item, movement, audit and count-batch IDs. Receipts
bind every result to that original plan. Original occurrence times remain on
physical movements and counts; authenticated preparation time supplies audit and
receipt metadata. Item update times preserve later original creation/occurrence
times. Device times more than five minutes ahead are rejected. Domain records and
their audit after-images share the same objects and timestamps.

Relative used/received/waste changes may apply to a newer revision after another
relative movement or ordinary edit. A later active physical count blocks that
rebase. Absolute counts, metadata edits and archive/restore require the reviewed
revision. A retained intent never silently becomes a different count. Undo checks
the original move, nonnegative resulting quantity, one reversal only and the live
24-hour deadline. A later active physical count must be reversed first; its undo
restores the prior count marker. Delayed offline undo can require review rather
than being retimed.

An atomic batch retains the existing limit of 1,000 distinct reviewed items. The
normal command boundary stays at 32,000 bytes and five seconds. A batch adds
`X-Mise-Stock-Batch` naming its outlet. Before obtaining a body reader, the server
checks the original authenticated caller's confirmed active owner or assigned
manager access. Only then may it read up to 8,000,000 bytes within thirty seconds.
The parsed body must be a stock batch for that same outlet. Batch RPCs allow
45 seconds each; the browser transport allows 120 seconds overall. Bodies and
credentials are never persisted by that transport. An unknown admission result
fails closed. Other credential endpoints retain their original CORS/body limits.

Migration `20261117214105_stock_commands.sql` adds private forced-RLS preparation
tickets and invoker RPC wrappers. The original JWT/public key prepares the scoped
source snapshot; only an opaque proof hash persists. Only service completion may
write the allowlisted stock/item/audit records. It repeats live Auth, membership,
outlet-assignment, proof-expiry and source-snapshot checks, then commits every row,
audit and receipt together under the outlet lock. A tagged snapshot race allows
at most three preparations of the same intent. Other conflicts stop for review.
Receipt replay returns the original acceptance without repeating the write.

Preparation returns selected items, an explicitly selected supplier and at most
two active physical counts per selected item, plus an undo target/reversal when
needed. Historical labels and notes are omitted unless needed for that target.
Direct client writes, private receipt/ticket reads and service preparation stay
denied. Privileged implementations remain private with empty search paths.

The shared command decoder also fixes an escaped-key error: SQL text keys are
already JSON-escaped and must not be stringified a second time. Raw JSON fields
retain their separate encoding. Stock names and closing-day keys now round-trip
without extra quotes, including Bengali, NUL and lone-surrogate values.

Verification exercises native PostgreSQL roles through the actual handler/store,
atomic audit failure, concurrent relative rebasing, physical-count barriers, live
revocation, exact receipt/ID binding and a full 1,000-item batch with maximum escaped
notes. An exact deployment-bundle test checks the original owner JWT, pre-body
admission, service-only finish and shared count behavior. A matching hosted SQL-role
fixture covers all seven command types in nine transactions and deliberately rolls
back every synthetic Auth/domain write. It does not establish phone OTP or a real
positive signed-owner HTTP session.

All **1,201 unit tests across 75 files** pass, including 49 native stock checks,
three escaped-key checks and 17 client transport checks. Lint and strict
TypeScript/Astro checks pass (89 files clean). Both production base paths build.
All **298 browser checks pass without retries** in 6 minutes 40 seconds, including
offline and automated AA checks. Three native restarts and three unchanged stock
1440px accessibility checks also pass in a separate repeated run. See
[the redacted hosted and verification evidence](m30-stock-hosted.json).
The unit pool defaults to two workers because native database engines and isolated
deployment builds compete for memory. The customer quota fixture has an explicit
thirty-second test budget for its 100 separate preparations; its limit/retry
assertions and the application's request deadlines remain unchanged. The browser
pool also defaults to two workers. The persistent-browser test polls the actual
activated/controlling worker state, releases its temporary DevTools session and
closes its pages before shutting Chromium down. Network emulation is reset only
after all offline assertions; a disconnected browser is checked before reuse of
the same saved profile. The profile uses a short, uniquely owned OS temporary
directory with verified cleanup: long Windows output/repeat paths produced Cache
Storage installation failures near the platform's path limit. This native restart
case retains CDP lifecycle diagnostics instead of Playwright's recorder, whose
merge of two manually relaunched contexts stalled shutdown and produced a truncated
trace ZIP. Other browser tests retain their traces. The original sixty-second
test deadline and every offline assertion remain.
M30 remains open for sign-in commissioning, positive owner/manager HTTP checks,
remaining order/supplier/other command families, staff/agent resources and the
reviewed app/outbox boundary. M31 still requires the server-time field-merge and
loser-log policy plus complete two-browser convergence; this foundation's absolute
writes retain explicit revision review until that integration is implemented.
Actual credentials and deployment references stay outside Git. The owner's
GitHub Actions and Pages publication hold remains in force.

The final source/index/history/artifact audit compares eight known private values
in memory and finds zero credentials, zero current deployment references and no
coverage gaps. Older nonsecret identifiers remain in published history. No
credential values or actual deployment references appear in the evidence file.
