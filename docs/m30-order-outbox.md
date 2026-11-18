# M30 · Original order transactions in the local queue

Order actions now retain executable commands in the same local transaction as the
order, linked money and audits. Previously these writes stayed as unclassified
recovery rows. The local copy remains immediately usable offline. M30 remains
incomplete and cloud controls stay behind their default-off flag.

The adapter covers creation/editing; compound save-and-pay; status changes and undo
for all four business flows; notes and manually confirmed contact history; payment
and its correction; cancellation and restore; partial refunds and correction; and
outlet warning settings. These are the existing eleven server command kinds.

Each financial action reserves its possible sale, entry, refund and companion-audit
IDs once, then uses the same plan in the actual local domain mutation and command.
Unused reservations stay distinct from existing source sale/refund IDs. Order line,
note and contact IDs retain their actual saved values. New line plans preserve
unchanged embedded lines and allocate each new line once. Strict wire objects
contain editable fields; saved-model metadata, derived line totals and substitution
acceptance timestamps do not enter the request.

A create/edit plus settlement saves one compound command, both intermediate save
and payment audits, and the complete linked money transaction. It uses one physical
occurrence time. Payment failure cannot leave an unpaid intermediate order, consume
its number or add a partial queue row. Local revisions, totals and commercial
validation remain the existing domain rules.

Receipt-based undo retains the source-sale identity check before entering the
complete order payment/cancellation undo. A receipt from a corrected earlier
payment cannot undo a newer one. New reversal entries and undo audits keep their
own IDs; original receipts and refunds retain their creation identities.

Portable records allow the payment occurrence field to be absent. The existing
local domain can still undo such a nonzero receipt using its original sale. That
local action stays usable and its recovery rows remain retained for explicit
review, because the server contract requires the original payment occurrence time.
No timestamp is inferred and no malformed command is sent. Normal current payments
retain the exact source time in their payment-undo command.

Verification replays actual serialized queued commands through the existing server
mutation builder against the complete preceding record graph. Equal clocks and
matching source graphs prove IDs and domain values; they do not prove convergence
of canonical server numbers, ledger sequences or timestamps. Coverage checks still
reconstruct the complete local copy from the initial snapshot and every change.
Failure cases cover complete compound/payment/cancellation/refund writes, notes and
settings; stale reviews add no partial records. Lost compound acceptance retries
the same original command and all companion IDs.

Native browser checks exercise offline cash and credit compounds, notes/status and
payment undo, partial refund correction, reload recovery and real queue constraint
failure. Their boundary and Auth fixtures are synthetic; they do not send SMS,
create a real hosted Auth user or claim signed-owner HTTP proof.

Lint, strict TypeScript and the Astro check pass (98 checked files, zero errors,
warnings or hints). All 1,644 unit tests across 92 files and all 321 browser tests
pass, with no retries, skips, flaky results or global browser errors. Both `/` and
`/mise/` production builds pass, with twelve focused root-path browser checks. All
270 reference exports remain present. The [redacted verification](m30-order-outbox-local.json)
records exact counts and source/build/report hashes.

The source/index/history/build-output audit compares nine private values in memory.
It finds no credentials, current deployment references or coverage gaps. The 22
historical findings remain the previously identified nonsecret identifiers; no
history rewrite is claimed. No visual layout was changed, so the earlier Auth
visual comparisons remain the layout evidence; no new visual run or CI artifact
is claimed.

Remaining: catalogue, manual hand-off and original Inbox adapters; unsupported
setup/template/export/shop-link changes; canonical receipt/pull reconciliation;
full upload/outbox controls; real OTP and signed-owner HTTP acceptance; and the
other open M30 resources and roadmap milestones. Accepted receipts remain separate
from a claim that the working copy is fully synced. No hosted service or GitHub
workflow is changed; Pages publication remains stopped by the owner.
