# M30 · Original shop-link publications and undo

Generating and undoing a shop link now retain typed commands in the same local
transaction as the outlet and audit. Commands keep the original operator, audit
ID, physical time, reviewed snapshot and exact public URL, including its chosen
code and edition. A retry never creates a different public link. Full cloud
activation remains gated and M30 stays incomplete.

The publication contains only the approved public shop fields. The review retains
the original source token and previous URL; connection details, Auth sessions and
server credentials never enter it. The shared publication domain validates the
same frozen public snapshot on both device and server. Local generation still
requires a fresh review of the current shop/catalogue before saving.

Once saved locally, a publication is a frozen snapshot. Later catalogue, contact
or profile edits do not change the link it already produced. This follows the
handover's server-time last-write-wins rule for set fields. Hosted generation
stores the exact approved URL and records the actual server URL it replaced in
canonical before/after history, preserving the losing value. It does not reprice
items, change catalogue records or reinterpret the old snapshot using newer data.

Owners and assigned managers may publish for their outlet, under their own live
member identity. Another actor cannot replay the receipt or undo that generation.
Staff, agents, foreign tenants and unassigned managers are denied. User-editable
Auth metadata grants no access. Completion and replay recheck live membership,
outlet assignment, confirmed phone and ban/deletion state.

Undo uses the originating generation's physical occurrence time from its durable
receipt. History already admitted through the original upload uses the event's
original time instead. An offline undo made within ten minutes remains valid
after delayed delivery. It still requires the same actor, an unchanged latest URL
and a generation not already undone. Exact undo replay returns the old receipt
without another mutation. SQL enforces these conditions independently of the
shared domain checks.

Undo restores the canonical value that generation replaced on the server. If a
different device changed the URL before admission, that value may differ from the
older value originally visible on this device. Both changes remain audited; the
later M31 canonical pull/apply must reconcile the local copy. Accepted receipts
alone do not establish convergence, and no sync interface is enabled here.

The CLI-created migration `20261118135304_shop_link_commands.sql` adds a private
forced-RLS preparation table with no direct client/service grants. Canonical
intent text/hash binds the complete URL, review, source identity and physical
time. Completion accepts only the bound result; SQL constructs the allowlisted
outlet update, audit, undo link and receipt atomically. Other outlet/profile
fields, members, Auth login phones and financial records remain intact. Metadata
timestamps cannot move backwards.

Private preparations expire after sixty seconds, with at most one hundred pending
per caller. Only the fixed snapshot-conflict tag permits three bounded fresh
preparations. Concurrent server edits then update canonical before-history while
the approved URL stays unchanged. Privileged helpers stay private with empty
search paths; public wrappers are security invokers with explicit grants.

A legal reviewed publication can exceed the ordinary 32 KB command limit. Both
clients use the dedicated outlet header and bounded 256 KB limit. The handler
verifies live outlet access before reading a larger body, rejects simultaneous
admission headers and binds the admitted outlet and publication kind afterward.
Preparation and completion repeat authorization. Oversized legacy publications
remain usable locally with their complete recovery writes retained for review.
An old source URL that cannot be represented in PostgreSQL text fails explicitly
without changing the current URL or deleting its original history.

Audit/queue failures roll back the entire local action and ordering fence. The
form retains entered values for retry. Compound generation/undo groups preserve
their command order and durable receipt prefix after lost responses. The database
loads this small adapter statically: a first call inside an existing transaction
cannot lose that transaction while waiting for a cold module import. Unknown
writes beside a typed link action retain the whole entry and stop delivery.

The [redacted verification](m30-link-local.json) records checks, source/bundle
hashes, the exact local/hosted SQL-role fixture and credential audit. The fixture
exercises six owner/manager publication/undo commands, original-time undo,
historical replay, canonical losing-value history, denied scopes/private grants
and complete normalized plan/result binding. All synthetic Auth/domain/ticket
rows roll back. Real phone OTP and signed-owner HTTP acceptance remain unproven.

Verification passes 1,892 unit tests across 102 files, all 366 browser tests without
retries, skips or flaky cases, and 14 focused browser checks at the root base path.
Lint, typecheck and builds at both `/` and `/mise/` pass. All 270 reference exports
are present. Forty-five visual comparisons complete without horizontal overflow;
changed pages pass axe at all five target widths.

The hosted project has 29 source migrations and six active Edge Functions;
`commands` version 16 verifies JWTs. All 50 application tables enable and force
RLS. Anonymous table access, direct authenticated table writes, direct link-ticket
grants and public security-definer functions are absent. The image bucket is
private. Security advisors report no warnings or errors. The six-command role
fixture leaves no synthetic users, businesses or tickets. HTTP preflight accepts
the new scope-admission header with no-store responses; missing and invalid JWTs
return 401. Auth/provider settings and Vault secrets were not changed.

Visual QA captures the established shop-link screen at 360, 390, 768, 1024 and
1440 px against the supplied **Settings › Storefront** export. The reference also
contains later hosted features; pixel differences remain informational. Native
accessibility checks use production styles. Full-page captures suppress normally
offscreen skip navigation and place the fixed phone navigation at the document
bottom. Run:

```sh
pnpm qa:visual qa/configs/m30-auth.json qa/configs/m30-upload-review.json qa/configs/m30-settings.json qa/configs/m30-profile.json qa/configs/m30-link.json
```

The [local report](../qa/report.html) includes the
[360 px publication](../qa/screens/m30-link-screen-360.png),
[390 px publication](../qa/screens/m30-link-screen-390.png) and
[desktop publication](../qa/screens/m30-link-screen-1440.png).

Legacy direct supplier saves, canonical receipt/pull reconciliation, full upload,
outbox and image controls, real OTP/signed-owner HTTP, the 5,000-record 3G gate and
later milestones remain open. Actions and Pages publication remain stopped by the
owner; no new CI artifact or Pages deployment is claimed.
