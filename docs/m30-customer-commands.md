# M30 · Customer and khata commands

The expanded `/commands` service supports customer create/update/archive/restore
and khata settings. Profile saves retain the existing app transaction: customer,
current-currency credit terms, optional opening balance and their audits succeed
together. Cloud controls remain unavailable while sign-in, the outbox and remaining
command families are unfinished. M30 stays unticked.

`packages/core/customer-mutation.ts` supplies the same save to IndexedDB and the
server. Runtime ID factories bind the requested customer/command IDs without
duplicating validation. Phone normalization, tag normalization, consent changes,
default disabled credit and original account currency retain the local behavior.
Legacy future creation times remain intact and updates stay monotonic. Existing
khata notes survive edits.

`packages/core/shop-commands.ts` adds strict customer intents around the existing
catalogue protocol. Extra tenant/actor/SQL fields are rejected. Credit amounts remain
integer minor units; terms and opening dates are checked. The canonical intent hash
is independent of object property order. Receipts contain command type, scoped IDs and timestamps and
are checked against the original command before private backend fields are removed.
The runtime public-key transport freezes the serialized intent before Auth refresh,
rejects redirects, bounds the body at 32,000 bytes and retains no credentials or shop
data. It does not change the local working copy or enable sync.

Migration `20261117182909_customer_commands.sql` adds two forced-RLS private tables:
opaque short-lived preparations and original-actor receipts. Only a live confirmed
owner or assigned manager can prepare a command through the original caller JWT.
Managers also need access to that customer at the selected outlet. The returned
context contains the current contact and selected khata. Migration
`20261117192844_customer_status_scope.sql` limits ordinary snapshots to that outlet
and account, and omits other-outlet balance information. Global archive/restore uses
an already-associated audit outlet and requires an owner or a manager assigned to
every outlet sharing the contact. Only that authorized status context receives a
settlement flag; the finalizer checks scope and all balances again. A change at an
unrelated outlet cannot stale an ordinary profile edit.

Only the service role can finish the exact opaque proof. Raw client writes and
private-table reads remain denied. The finalizer rechecks live Auth, membership and
assignment; locks the business before the outlet; checks the source snapshot; and
allowlists the shared codec's customer/account/entry/audit columns. The new business
lock is also required by future ledger writers that can race shared-contact archival.
Stale snapshots use `PT409`. Only the fixed stale-snapshot tag requests a retry,
with a maximum of three preparations. Up to 100 active preparations per caller
expire after sixty seconds. Accepted retries retain their original receipt after
later edits. Catalogue and customer commands share the global audit-ID constraint.

The customer, account, opening entry, audits and receipt commit atomically. A new
opening balance can only belong to a new empty khata and must retain its own audit.
The source shop schema and JSON backup format are unchanged. This receipt protocol
is not the M31 ordered change feed or convergence proof.

The hosted foreign-key advisor identified the receipt-to-event lookup. Migration
`20261117190239_customer_command_fk_index.sql` adds its covering index. All sixteen
migration versions are deployed, with `commands` v4 active and JWT verification kept
on. Forty public/private application tables force RLS. There are no anonymous raw
table grants or public security-definer functions, and no advisor WARN/ERROR or
unindexed-FK findings. Eleven private no-policy notices are intentional default-deny
tables; seventy-nine unused-index notices reflect the small empty-project workload.

Native HTTP → store → PostgreSQL tests cover owner/manager saves, exact replay,
duplicate/archived phones, old currencies, cross-outlet balances, stale snapshots,
all live identity revocations, opaque-proof expiry, strict commit columns and audit
rollback. The exact single-file deployment module also executes the shared save in
a boot test. The browser/client transport checks freezing, cancellation, redaction
and receipt binding.

Final local verification passes **1,086 tests across 70 files**, including 59 native
customer-command checks, 13 client-transport checks and the exact-bundle boot. Lint
and strict TypeScript/Astro checks pass (86 files clean). Both production base paths
build, and **298 browser checks pass with zero retries in 4.3 minutes**. The later
scope refinement changes SQL only; the verified app output remains unchanged.

The hosted PostgreSQL role proof creates synthetic Auth/shop records inside a
rolled-back subtransaction. A shared-code fixture saves one customer, one account,
one opening entry, three audits and one receipt. Other identities, direct private
reads and an ordinary caller trying to finish are denied. Original literal Unicode,
phone normalization, original attribution and receipt replay pass. A synthetic
second outlet/account also proves manager row isolation, redacted
ordinary context, rejection of unassigned global status, acceptance after every
assignment is granted, and rejection when the second assignment is revoked before
finish. All Auth/domain, receipt and preparation rows return to zero afterward.
No SMS or other message is sent. This is not a positive signed-owner HTTP or
phone-OTP test.

Nine live negative HTTP/CORS checks pass. The reused Node probe connection stalled
on its oversized body; independent native curl returned 413 in 797 ms and Chromium
cross-origin fetch returned 413 in 403 ms. The completed report preserves that probe
limitation. See [the redacted evidence](m30-customer-hosted.json).

Real owner/manager phone OTP and signed-owner HTTP writes remain open, along with
the UI/outbox boundary, money/payment/order/stock commands, staff/agent resources,
upload performance and the rest of M30. GitHub workflows and Pages publication remain
stopped by the owner.
