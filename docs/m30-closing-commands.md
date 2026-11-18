# M30 · Reviewed day closing

The closing transaction reuses the complete local Today calculation. It includes
retained cancelled cash, actual refunds, net khata collections, waiting/completed
orders, low stock and reminders. A cloud save must match the complete canonical
review at its original device occurrence time. New financial or operational totals
require a new review; the server never silently changes a cash count.

`closing.record` retains the device closing ID, command/audit ID and optional
surplus-sale/companion-audit IDs. A positive difference becomes a real cash receipt
only after explicit choice. Shortfalls and explained surplus leave sales unchanged.
The frozen summary includes a receipt created in that same transaction. The
original verified member name is retained, including for assigned managers.

`closing.undo` retains the original closing and all original receipt fields,
clears its active slot and reverses only its linked walk-in receipt. Later sales
survive. It is allowed once on the original shop day, using the original closing
timezone even when current outlet settings differ. SQL checks the actual live
completion clock independently of preparation and occurrence times. A past-day
offline closing can retain its original review without extending its undo window.
See [PostgreSQL live clock and timezone behavior](https://www.postgresql.org/docs/17/functions-datetime.html).

The original confirmed active owner or assigned manager prepares a full scoped
source snapshot. Another outlet's activity is excluded. Private forced-RLS
sixty-second tickets bind the caller, canonical intent hash, related IDs and
source hash; only opaque proof hashes are stored, with a hundred-live-ticket cap.
The complete duplicate request is discarded after hashing. Canonical review,
summary and note JSON stay literal, including NUL and lone surrogate data.
PostgreSQL does not extract text from these JSON bodies.

Public RPC wrappers are invokers. Only service completion can write the exact
closing/sale/audit codec columns after live identity/assignment, proof, scope,
source and financial-link checks. New IDs use insert-only semantics; an ID race
cannot overwrite another outlet. Original rows and summaries remain immutable
during undo except for explicit void/update markers. Closing, optional receipt,
all audits and the immutable original-actor replay receipt commit together.
Audit failure rolls everything back. Only a fixed stale-source tag allows up to
three preparations with unchanged device IDs; changed reviews need review.

Closing keeps the ordinary 32,000-byte/five-second body limit, five-second RPCs
and 45-second client request limit. The full review, count, note and companion
IDs freeze before asynchronous Auth. Existing stock/invoice/order admission
headers and limits are unchanged. ESLint excludes ignored private scripts;
tracked/index/history/output credential guards remain enabled.

Native checks cover exact IDs, all money totals, currencies and occurrence days,
replay after undo/reclosing, competing closings, outlet isolation, eight live
revocations, immutable originals, foreign-ID races, opaque expiry and quotas,
literal maximum-length notes, audit rollback, payload tampering and an independent
live-day guard despite a forged preparation clock. An exact deployment-module
boot checks original-JWT preparation and service-only completion. The five-action
SQL-role fixture creates and undoes a surplus, records and undoes a shortfall,
then records an exact count; it retains eight audits and rolls back every
fictional Auth/business/ticket row.

All 23 migrations and `commands` v10 are deployed with JWT verification enabled.
The retrieved module exactly matches the validated 42-source bundle. The actual
five-action hosted fixture passes with eight audits and zero fictional rows left
after rollback. Fourteen actual HTTP/CORS probes reject missing/anonymous identity,
service-key impersonation, foreign origins, invented fields, fractional counts,
incomplete companion IDs and oversized ordinary bodies. Fetch probes and the
isolated curl size probe run separately. All 45 application tables force RLS;
anonymous grants, direct client writes and public security-definer functions
are absent. Both advisor reports have zero warnings or errors; the sixteen
default-deny private-table and 76 unused-index notices are informational.

Lint and strict TypeScript/Astro checks pass (92 Astro files clean). All 1,416
unit tests across 82 files pass, including 61 native closing checks, 23 client
transport checks and the exact closing deployment-module boot. See
[redacted deployment and verification evidence](m30-closing-hosted.json).

Production builds pass under `/` and `/mise/`, including generated-output
credential guards. All 298 browser checks pass with zero retries, skips, flaky
results or global errors (301.47 seconds, two workers), including local closing,
refund/khata correction, native offline restart and responsive axe coverage.

Phone OTP,
positive signed-owner HTTP, app/outbox integration, confirmed hand-off/Inbox and
other M30 resources, and M31 convergence remain open. No sync interface, real
message, paid provider, new layout, visual comparison or Pages publication is
enabled here. GitHub workflows remain disabled. Actual project/organization
details, credentials and private operational paths stay out of public evidence.
