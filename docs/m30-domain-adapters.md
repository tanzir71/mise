# M30 · Local domain command adapters

Customer, stock, supplier, invoice and closing actions now save executable domain
intents in the same local transaction as their records and audits. Previously these
actions were retained as unclassified recovery rows and stopped ordered delivery.
The local copy still changes immediately, including offline. Cloud setup stays
behind its default-off flag, and M30 remains incomplete.

Customer saves and khata settings use the existing shared intent factories. The
customer, account, opening entry and companion audits keep their original IDs.
Profile-only edits reuse the existing account. An older customer without an account
can create one through the normal settings command. Archive/restore still respects
the customer's unpaid balance.

The shared factories project only editable profile/credit fields from validated
mutations. Existing callers may pass a saved customer or account object; storage
metadata and unrelated fields never enter the strict wire command.

Stock intents retain normalized item details, reviewed revisions and original
movement/audit IDs. Relative changes keep the exact delta; physical counts keep the
absolute quantity, including zero. A night count retains its shared batch ID and
all per-item IDs. Metadata-only edits do not invent a movement. Undo refers to the
original movement and its actual new audit.

Supplier edits/status changes retain their reviewed revisions. Invoices retain all
200 priced lines, original invoice/audit IDs and due/cash/wallet choice. Recording
or undoing an invoice does not receive stock or change customer/counter money.

Closing retains the complete reviewed Today fingerprint, cash count and optional
surplus receipt. Repeated Save queues the same closing once. Same-day undo retains
the original closing/receipt IDs while attaching its separate new undo audits; the
creation event IDs retained on those records are not reused as undo commands.

Verification uses real local database writes with an armed upload boundary. Actual
serialized queue commands replay through the existing server mutation builders
against the preceding record graph. Equal clocks isolate record identity and domain
values from canonical server-time reconciliation, which is still required. Separate
failure cases prove that a queue-write error rolls back records, audits and the
sequence fence for each of the five families. Stale reviews leave no partial writes.
The browser checks use real offline forms and native IndexedDB; a shared invoice
retains its literal source separately from the explicit purchase intent.

Lint and typechecking pass, including all 97 Astro files. All 1,615 unit tests across
91 files and all 317 browser tests pass, with no retries, skips, failures or global
browser errors. Both `/` and `/mise/` production builds pass; eight focused browser
checks also pass at `/`. All 270 reference exports remain present.

The [redacted verification](m30-domain-adapters-local.json) records exact counts,
build/report hashes and the checked source hashes. Its source/index/history/output
scan compares nine private values in memory and finds no credentials, current
deployment references or coverage gaps. The 22 historical findings remain the
previously identified nonsecret identifiers. No history rewrite is claimed.

No visual layout was changed; the existing Auth visual report remains the layout
evidence. No new visual run or CI artifact is claimed.

Remaining work includes catalogue, order, hand-off and Inbox adapters; unsupported
setup/template/export/shop-link writes; canonical receipt and pull reconciliation;
full upload/outbox controls; real phone OTP and signed-owner HTTP acceptance; and
the other open M30 resources. Accepted server receipts do not claim that the local
copy has converged. All GitHub workflows remain disabled and Pages publication
stays held by the owner. No hosted migration, Edge Function or Auth configuration
was changed for these local adapters.
