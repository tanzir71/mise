# M30 · Device-generated customer identities

Customer commands now retain the device's customer, khata account, opening-entry
and companion-audit IDs. Previously the server allocated the related IDs after
preparation, which could leave an already queued offline payment pointing to a
different account. This change prepares that identity boundary; it does not enable
the outbox or claim offline convergence. M30 remains in progress.

`customerSaveIntent` constructs the existing local save and its typed command
together, before I/O. `creditTermsIntent` does the same for new or existing khata
settings, including an explicitly selected old-currency account. The commands reserve
four distinct related IDs once. Only records actually required by the shared local
mutation are created. Profile-only edits retain their existing account and do not
invent a khata audit or opening balance. The current IndexedDB app still uses the
same underlying mutation; these intent factories await the reviewed outbox boundary.

The strict parser requires the ID plan and freezes it before asynchronous Auth.
Canonical intent hashing includes it. Receipts bind the resulting account, opening
entry and companion audits back to that plan and omit private fields. The shared
server mutation allocates no domain/audit IDs. Fresh preparation tickets can change
on a retry; the customer's related IDs cannot.

Migration `20261117205719_customer_record_ids.sql` stores the ID plan with the private
preparation. The new `prepare_customer_intent` RPC retains the original live
owner/manager identity, outlet scope, locks, quota and sixty-second proof expiry.
It closes the old unplanned preparation RPC and its private implementation to client
roles. Pending plans cannot be replaced, even by a caller reusing a claimed hash.
If another device created a different current-currency account, the server returns
a conflict for retained-intent review. It never silently adopts another account ID.

Service-only completion checks planned account, opening and audit IDs again before
the atomic save. It retains the existing field allowlist, live role checks,
source-snapshot comparison and full rollback on audit failure. Stored row updates,
audit snapshots and receipt metadata consistently use the authenticated preparation
clock. No raw client table writes or new exposed schemas are introduced. Privileged
implementations remain private with empty search paths and explicit execution grants;
see [Supabase's function privilege guidance](https://supabase.com/docs/guides/database/functions#function-privileges).

Native HTTP/store/PostgreSQL checks prove that a payment constructed offline before
customer admission reaches that exact locally allocated account afterward. Other
checks cover stable IDs across rebases, old-currency settings, two conflicting offline
account creations, forged companion IDs, receipt binding, closed legacy/service
preparation, private reads, live revocation and audit/receipt consistency. The hosted
role fixture uses fictional records in a rolled-back subtransaction and checks
original attribution, literal Unicode, exact replay and multi-outlet manager scope.
It is not a real phone-OTP or positive signed-owner HTTP test.

All nineteen migrations are hosted and `commands` v6 is active with JWT verification
enabled. The hosted proof confirms device IDs and server timestamps agree, exact
receipt replay, and denied cross-outlet/private access. Every synthetic Auth,
customer, account, entry, audit, receipt and preparation row returns to zero.
Eight negative HTTP/CORS checks pass, including rejection of unplanned requests
and direct access to the closed legacy RPC. All 41 application tables force RLS;
there are no anonymous/raw-write grants or public security-definer functions.
Security/performance advisors report no warnings or errors. See
[the redacted evidence](m30-customer-identity-hosted.json).

Credentials and actual deployment references stay out of Git and built artifacts.
GitHub workflows and Pages publication remain stopped by the owner. Remaining M30
work includes phone OTP, signed-owner HTTP uploads/writes, order/stock commands,
staff/agent resources and the app/outbox boundary. M31 still needs ordered delivery,
retained conflict review and a complete convergence proof.

Final verification passes **1,146 unit tests across 72 files**, including 72 native
customer checks, 44 money checks and 15 client transport checks. Lint and strict
TypeScript/Astro checks pass (88 files clean). Both production base paths build.
The full browser run passed 297 checks; its persistent-browser restart check hit
its sixty-second deadline after the first offline-ready assertion. That unchanged
check passed alone in 6.4 seconds. All 298 distinct browser checks are verified,
with that full-run timing limitation retained in the evidence.

The source/index/history/artifact audit compares eight known private values in
memory and reports zero credentials, zero current deployment references and no
coverage gaps. Older nonsecret deployment identifiers remain in history.
