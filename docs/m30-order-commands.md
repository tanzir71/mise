# M30 · Complete order commands

The command implementation covers order creation/editing, an optional compound
save-and-pay transaction, business-specific status changes and undo, notes,
explicitly confirmed contact history, settlement and payment undo, cancellation
and restore, partial refunds and refund undo, and outlet warning settings. It
reuses the complete local order/pricing/khata domain. Recording a wallet or card
payment remains a manual record; no payment provider or message is contacted.

Device order/line/note/contact/sale/entry/refund/audit IDs survive every preparation
and retry. New embedded lines cannot reuse previous line IDs. A compound save and
settlement commits its intermediate creation/edit audit, final order, all linked
money, companion audits and one immutable original-actor receipt together. New
records use insert-only semantics, including a record inserted by another outlet
after preparation. Existing financial rows preserve their original identity and
fields when explicit void markers change. Credit-payment reversals now retain
explicit order and sale links in both local and remote commands.

The outlet allocates the canonical sequence/display number under its existing
lock. A competing creation changes the source snapshot and permits a bounded
re-preparation with the same device record IDs. Existing order numbers, flow,
currency, creation identity and time remain stable. M31 still needs accepted-row
reconciliation of provisional local numbers, conflict merging and convergence.

All 200 lines, 500-character line notes and the complete 12,000-character pasted
source are supported, including NUL and lone surrogate data. Ordinary commands
retain their 32,000-byte/five-second body boundary. Saves use
`X-Mise-Order-Write`: the original confirmed active owner/assigned manager must
first prove outlet access before obtaining a body reader. That exact save/outlet
may read up to 2,000,000 bytes in twenty seconds. Saves allow fifteen seconds per
RPC and 120 seconds in the client; other command limits stay unchanged. Stock,
invoice and order admission headers are mutually exclusive. Client intent,
lines, companion IDs and credit confirmation freeze before asynchronous Auth.

PostgreSQL JSON extraction can reject an ID or timestamp when another field
contains NUL/surrogates. Source sale IDs and original payment times therefore
travel explicitly in the intent and are checked against the decoded original
order by the shared server code. SQL reads scoped scalar columns, returns raw
literal JSON and independently checks the live ten-minute payment/refund undo
deadline. Backdating an intent or a forged preparation clock cannot extend it.
See [PostgreSQL JSON processing limits](https://www.postgresql.org/docs/17/datatype-json.html).

Private forced-RLS tickets bind the original Auth/member, immutable intent hash,
related-ID plan and scoped source hash. The full canonical request is hashed and
discarded from temporary ticket storage; ticket rows do not duplicate pasted
order bodies. Only opaque proof hashes are stored, with sixty-second expiry and
a 100-live-ticket limit per caller. Public wrappers are invokers. Only service
completion can write the eight exact codec allowlists, after rechecking live
identity/assignment, proof, source, revision, financial links, original records,
credit balance/limit and refund/undo boundaries under business-then-outlet locks.
Audit failures roll the entire transaction back. Only a fixed snapshot-race tag
permits up to three preparations; changed order revisions require intent review.

Native verification includes all four business flows, compound cash/wallet/card/
credit creation, unpriced/free orders, exact rounding, complete escaped payloads,
local and remote credit reversal links, collected-credit cancellation/refunds,
later-note preservation, opaque proofs and quotas, replay after later changes,
live revocation, cross-outlet races, audit rollback and service-payload tampering.
An exact deployment-module boot checks original-JWT admission and service-only
completion. A thirteen-action SQL-role fixture checks retained Unicode/IDs,
historical replay, credit reversal, wallet/refund restoration and access denial,
then rolls back every fictional Auth/business/ticket row.

All 22 migrations and `commands` v9 are deployed with JWT verification enabled.
The retrieved deployment module exactly matches the validated 37-source bundle.
The actual hosted role fixture passes thirteen actions and 23 atomic audits,
retains literal Unicode and original IDs, denies unrelated access and rolls back
every fictional Auth/business/ticket row. All 44 application tables force RLS;
anonymous table access, direct client writes and public security-definer functions
are absent. Both hosted advisor reports have zero warnings or errors; their
fifteen private-table and 77 unused-index notices are informational.

Fourteen actual HTTP/CORS checks pass: missing/anonymous identity, service-key
impersonation, foreign origin, malformed/ambiguous admission, extra caller fields,
invalid prices, raw anonymous RPC, all three preflight headers and the ordinary
32 KB limit. The thirteen fetch probes and isolated curl size probe are separate
processes. Combined fetch/curl runs timed out at the local curl transport; the
isolated size probe returned 413 without changing an application deadline.

Local lint, strict TypeScript and Astro checks pass (91 Astro files clean).
All 1,352 unit tests across 80 files pass, including seventy native order checks,
21 client transport checks and the exact order-module boot. Production builds
pass under `/` and `/mise/`, including their generated-output credential guards.
All 298 browser checks pass with zero retries, skips, flaky results or global
errors (384.92 seconds, two workers), including offline order/khata transactions,
refund correction, native PWA restart and responsive axe checks. See
[redacted deployment and verification evidence](m30-order-hosted.json).

Actual phone OTP, positive signed-owner HTTP writes/uploads, app/outbox integration,
remaining confirmed hand-off/Inbox and staff/agent resources, and M31 convergence
remain open. Product cloud controls stay unavailable. No new layout, visual
comparison or live Pages publication is claimed; workflows remain disabled.
Actual deployment references, credentials and private operational paths stay out
of the repository and public evidence.

The subsequent [local order queue](m30-order-outbox.md) connects these command kinds
to their original local transactions, including compound save-and-pay and complete
financial undo. Its notes record the newer regression pass. The full upload/sync
interface and canonical reconciliation remain unfinished.
