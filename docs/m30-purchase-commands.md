# M30 · Supplier and invoice commands

The command service implementation covers supplier creation, edits, archive and
restore, priced invoice recording, and invoice undo. It reuses the local supplier,
phone and invoice validation. Recording an invoice does not receive stock, create
a counter sale or change customer debt. Stock receipt remains a separate reviewed
action. Cloud controls and the outbox remain unavailable while M30 is in progress.

Each command retains the device's supplier/invoice ID and audit ID. Supplier edits
and status changes require the reviewed revision. Original creation and movement
times survive admission; server preparation time supplies audit/receipt metadata.
Updates preserve later legacy creation times. Device times more than five minutes
ahead are rejected. Undo applies once within ten minutes according to the live
server clock, preserves the original invoice and links a separate audit event.
Backdating the retained intent cannot extend that limit.

The invoice input still supports all 200 priced lines. Per-line totals use the
shared exact minor-unit rounding, and their sum stays within the safe integer
bound. Cash, supported wallets, card and due remain manually recorded methods.
Saved supplier names come from the current selected supplier. Selected stock must
be active in the same outlet and use the invoice line's unit. A manual supplier
label and unlinked invoice lines remain available.

Normal requests keep their 32,000-byte/five-second read boundary. Invoice recording
adds `X-Mise-Purchase-Record` with its outlet ID. The original confirmed, active
owner/assigned-manager check runs before the server obtains a body reader. Only
then may that exact invoice/outlet read up to 512,000 bytes within fifteen seconds.
Invoice RPCs allow fifteen seconds and its client sixty seconds. Stock batching
keeps its existing admission header and limits; combining both headers is rejected.
The client freezes every line, selected ID, method and note before asynchronous
Auth and never persists a credential or command in this transport.

Private forced-RLS preparation tickets bind the original Auth identity, actor,
outlet, canonical intent hash and source snapshot. Only an opaque proof hash is
stored. Supplier/invoice creation uses insert-only semantics. Updates and undo
recheck identity, live assignment, the source snapshot and proof expiry under the
outlet lock, with a shared business-configuration lock acquired first. A tagged
source race allows at most three preparations; other
conflicts stop for retained-intent review. The row, audit and replay receipt commit
together; an audit error rolls everything back. Public wrappers are invokers and
privileged implementations remain private with empty search paths and explicit
grants. Direct client writes and private receipt/ticket reads remain denied.

PostgreSQL's text extraction from literal JSON can reject an entire invoice object
when any field contains a NUL or lone surrogate. The private plan therefore binds
the exact canonical serialized lines, produced by the same local line-value
function, plus separate JSON-safe numeric/unit facts. SQL independently computes
the invoice total and checks selected stock/units without decoding literal line
text. Escaped invoice names, units, notes and supplier labels remain byte-preserving
at the shared codec boundary. The plan and all raw source context stay server-side.

Native checks cover all actions, exact rounding, zero-priced lines, the full
200-line escaped invoice and its undo, cross-outlet scope, live revocation,
immutable replay, bounded source races, audit rollback, SQL payload tampering and
the independent undo clock. An exact deployment-module test checks original JWT
admission and service-only completion. A matching hosted SQL-role fixture covers
the six actions and deliberately rolls back its fictional identities and records.
All 21 migrations and `commands` v8 are deployed with platform JWT verification
enabled. The fetched deployed module exactly matches the validated 32-source
bundle. The rolled-back hosted fixture retains literal Unicode, original IDs and
clocks across all six actions, with no fictional Auth, business or ticket rows
left behind. Thirteen live HTTP/CORS checks confirm rejection and body-admission
boundaries; they do not establish positive signed-owner HTTP writes.

Validation passes: lint, strict TypeScript and 90 Astro check files, builds under
both `/` and `/mise/`, 1,258 unit checks across 77 files, and all 298 browser checks
without retries, skips or global errors. The browser run includes offline storage,
native restart and responsive accessibility checks. Native supplier/invoice checks
number 54; transport checks number 19 and the exact purchase deployment boot adds
one. No new product layout or visual comparison is claimed. See the
[redacted deployment and check evidence](m30-purchase-hosted.json).

M30 stays open for sign-in commissioning, actual signed-owner HTTP transfers,
remaining order/closing/hand-off/Inbox command families, staff/agent resources and
the app/outbox boundary. Supplier messages await their complete confirmed hand-off
transaction. M31 still needs its server-time field merge/loser log and complete
two-browser convergence. Actual deployment references and all credentials remain
outside Git. The owner's GitHub Actions/Pages hold remains in force.
