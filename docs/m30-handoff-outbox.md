# M30 · Manual messages in the local queue

Preparation, Open/Copy/failure, explicit Sent and undo now retain executable domain
intents in the same local transaction as their original history. Sent's complete
credit/order/supplier side effect joins that command. These actions previously
stayed as unclassified recovery rows. M30 remains incomplete and cloud controls
remain behind their default-off flag.

The existing three command kinds cover preparation, progress changes and supplier
message correction. Preparation retains the exact normalized draft, template,
source, destination, part metadata, attempt ID and original action time. Reopening
an unchanged or resumed attempt adds no write. Replaying an already saved request
ID returns the latest local progress without adding a second queued action.

Sent first constructs the validated existing completion, then derives the actual
companion record/audit IDs and writes the complete group inside the typed intent
boundary. Credit confirmation creates its zero-amount communication, not money;
order confirmation retains its reviewed revision and contact record; supplier
confirmation never receives stock. Opening or copying does not confirm Sent.
Failure to save the queue, a companion or the final audit rolls back the whole
transaction and its sequence fence.

Undo Sent preserves the original business history. Supplier resends reuse the
original message and creation audit when their exact content still matches. The
strict wire plan reserves a fresh unused companion audit ID for that path; no new
companion audit is created, and the server receipt may report it as absent. A
separate supplier correction retains its actual new undo audit and original
message identity.

The old direct supplier-record method has no standalone server write contract.
It continues to retain its entire change locally and stop later ordered delivery.
The current default-on audited UI uses the complete hand-off path. This legacy
case remains an explicit gap before full upload/sync activation.

The existing 12,000-character domain limit, valid Unicode/control-character rules,
100-part bound, monotonic action times, complete generation/history validation and
source review guards stay intact. HTML textarea edits use their normal LF line
endings; raw domain/wire drafts retain valid original CRLF text. Customer text
remains literal data and is never treated as an instruction.

Tests replay actual serialized queued commands through the existing server
mutation builder against the preceding record graph. Equal clocks and matching
source graphs isolate record identity and domain values; they do not prove
canonical generation, ledger-sequence or admission-time reconciliation. Other
checks cover every source kind, repeated confirmations, supplier reuse, stale
order review, concurrent choices, lost accepted replies and complete rollback.
Snapshot-plus-queue coverage still reconstructs the local working copy exactly.

Native browser cases use the existing offline reminder, order and supplier screens.
They verify typed companion IDs, literal edits, correction/reload, native queue
constraint rollback and manual Copy/selection when preparation cannot be saved.
No real message, SMS or hosted Auth user is created by these fixtures.

Lint and strict TypeScript pass, including the Astro check's 99 files with no
errors, warnings or hints. All 1,673 unit tests across 93 files and all 326 browser
tests pass, with no retries, skips, flaky results or global browser errors. Both
`/` and `/mise/` production builds pass, and seventeen focused browser checks pass
at `/`. All 270 reference exports remain present. The
[redacted verification](m30-handoff-outbox-local.json) records counts and hashes.

The source/index/history/build-output audit compares nine private values in memory
and finds no credentials, current deployment references or coverage gaps. The 22
historical findings remain the previously identified nonsecret identifiers; no
history rewrite is claimed. No visual layout is changed; the existing Auth visual
comparisons remain the layout evidence, with no new visual run or CI artifact
claimed.

Remaining: original Inbox/worker and catalogue adapters; unsupported settings,
export, shop-link and legacy direct supplier writes; canonical receipt/pull
reconciliation; full upload/outbox controls; real OTP and signed-owner HTTP
acceptance; other open M30 resources and later milestones. Accepted receipts do
not establish that the local copy is fully synced. No hosted service, migration,
function, Auth configuration or GitHub workflow changes in this increment. Pages
publication remains stopped by the owner.
