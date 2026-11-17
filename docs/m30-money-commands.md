# M30 · Counter receipts and khata payments

The authenticated `/commands` service now accepts counter cash/wallet/card sales,
credit sales, counter-sale undo, khata payments, standalone entry undo and manual
communication records. It sends no messages and moves no funds. Sign-in, cloud
controls and the outbox remain unavailable; M30 stays in progress.

`money-commands.ts` defines strict intents and response receipts. Every created
sale, entry and audit ID comes from the caller and survives a preparation retry.
The server uses the same calculator, catalogue-price snapshots, wallet choices,
credit limit, payment balance and undo rules as the local app. An excess-credit
confirmation must match both the current balance and limit. A changed reviewed
intent needs a new command ID, including after a rejected confirmation.

Financial occurrence times remain the supplied device time. Server admission
time comes from the authenticated preparation and is used consistently for the
stored row's update, its audit snapshot and its receipt. The completion clock
independently enforces proof expiry and the existing ten-minute undo window.
Future device times beyond five minutes are rejected for review. Backdating an
offline undo cannot bypass the server deadline. M31 must retain rejected intents
and offer review rather than silently discard or retime them.

Migration `20261117202047_money_commands.sql` adds one private forced-RLS ticket
table and extends the existing actor-bound command receipts. Preparation uses
the original JWT, derives scope from the outlet and actual account/receipt, and
requires a live confirmed owner or assigned manager. Staff, agents and a server
principal cannot become that operator. Only the service role can finish an
opaque short-lived proof. It receives no replacement caller Authorization header.

The source context contains the selected outlet/account and requested catalogue
items. Other-outlet ledgers are excluded; old ledger notes are omitted except for
the exact undo target. Literal source JSON retains NUL and lone surrogate code
units. The snapshot is checked again under business-then-outlet locks, along with
live Auth, membership and assignment. Only the fixed stale-source tag permits
automatic re-preparation, capped at three attempts.

The finalizer allowlists the shared codec's sale/entry/audit columns, checks IDs,
scope, attribution, currency, sequence, reversal and money linkage, and commits
the rows, audits and receipt together. New ledger rows are append-only; cash undo
changes only the existing receipt's void fields. Audit collision or invalid money
rolls back every preceding write. Order/refund-linked money requires its complete
original order transaction, which this counter endpoint does not implement.

Migration `20261117203202_money_audit_clock.sql` aligns stored metadata with the
server-produced audit snapshots without rewriting literal JSON. All eighteen
migrations are hosted and `commands` v5 is active with JWT verification enabled.
The 29 public and 12 private application tables force RLS. Anonymous raw-table
grants and public security-definer functions both count zero. Security/performance
advisors report no WARN/ERROR or unindexed-FK findings; twelve private default-deny
and 78 unused-index notices are informational.

The native HTTP/store/PostgreSQL checks cover financial families, replay, rejected
intent reuse, exact credit confirmation, stale rebases, role/outlet isolation,
live revocation, original times and IDs, Unicode, audit consistency and rollback.
The deployment module boots the actual bundled validation; the browser transport
freezes financial fields before asynchronous Auth refresh.

The hosted SQL-role fixture runs seven commands and exact receipt replays, checks
ordinary completion/private reads/foreign identities are denied, and verifies two
voided sales, the final original balance and literal payment text. Its whole
subtransaction rolls back; Auth, business and preparation rows return to zero.
Six hosted negative HTTP/CORS checks also pass. This is not a positive signed-owner
HTTP or phone-OTP test. No SMS or other message is sent.

Final local verification passes **1,132 tests across 72 files**, including 44
native financial checks, the exact deployment-module boot and 14 client transport
checks. Lint and TypeScript/Astro checks pass; both production base paths build.
The final complete browser pass has **298 checks, zero retries, in 4.0 minutes**.
Earlier overlapping suites hit two deadlines; their independent full rerun passed
without extending the deadlines. The initial browser pass found a test that only
waited for the customer worker before taking both pages offline. It now also waits
for owner-worker control; product behavior is unchanged.

See [the redacted verification evidence](m30-money-hosted.json). Credentials and
actual deployment references remain in ignored local files/server secrets. GitHub
workflows and Pages publication remain stopped by the owner.

Before M31 is enabled, new-customer/account creation also needs stable related IDs
or explicit reconciliation with the offline working copy. This money protocol
retains its own supplied IDs but does not claim full offline convergence. Remaining
M30 work includes phone OTP, signed-owner HTTP writes/uploads, upload performance,
staff/agent resources, order/stock commands and the reviewed app/outbox boundary.

The later [customer identity increment](m30-customer-identity.md) resolves the
related-ID prerequisite above with strict device-generated plans. The full outbox,
ordered delivery and retained conflict review remain open. Its hosted version and
verification follow the historical money-command evidence recorded here.
