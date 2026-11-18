# M30 · Catalogue identities and local queue

Catalogue creation, editing, availability changes, deletion and sample removal now
save their typed commands with the original local records and audit in one
transaction. Each action retains its outlet, command/item/category identities and
physical occurrence time. M30 remains incomplete and `cloudSetup` stays off.

The adapter projects only editable item fields. The server uses the same catalogue
normalization and NFKC category matching as the local domain. A category with a
different saved identity requires review; the server cannot silently substitute an
ID that later offline commands already reference. Removing samples preserves its
own audit kind and rejects ordinary items. Invalid input, stale state, failed audit
or failed queue insertion rolls back the complete local action.

Pasting up to 1,000 items keeps one atomic local transaction and one queue entry
containing ordered item commands. Each remote item, optional category, receipt and
audit commits atomically. A saved per-command receipt resumes a partially delivered
group before any later entry; the remote group is not one 1,000-item transaction.
Lost responses retry the original IDs. Mixed or unsupported writes retain the
complete entry and stop ordered delivery.

The twenty-sixth migration, `20261118100020_catalogue_device_intents.sql`, binds
the full normalized input, category identity, outlet, occurrence time and canonical
intent hash in the private preparation plan. Service completion cannot replace
those values. Original creation times survive admission; canonical update, audit
and receipt metadata uses verified server admission. Device clocks more than five
minutes ahead require review. A legacy item without its required category also
requires review before an availability change can be accepted.

SQL reconstructs the canonical intent from independently checked ASCII facts and
literal JSON string tokens. Extracting even an unrelated ID from an entire JSON
object can reject a sibling NUL or lone surrogate. Comparing the exact canonical
text and hash preserves those source values without turning them into SQL text.
The new prepare/finish/apply catalogue-intent wrappers have explicit grants and
empty search paths. The older unplanned catalogue RPCs have no client or service
execution grants. Direct table writes remain denied.

Sixteen new adapter tests include the full 1,000-item paste, normalization/reuse,
original IDs, queue/audit rollback, same-ID retry and ordered partial delivery.
Eleven added SQL/HTTP tests include proof substitution, category conflicts, sample
guards, old endpoint denial and actual serialized local commands passing through
the HTTP handler into PostgreSQL. Five new native browser cases cover offline
lifecycle/reload, the full-size paste and failed-write retry without losing input.

The [redacted verification](m30-catalogue-outbox-local.json) records 1,718 passing
unit tests across 95 files, 336 passing browser cases at `/mise/` and 33 focused
native browser cases at `/`. Both browser runs have no retries, skips, flaky
results or global errors. Lint, strict TypeScript and the Astro check pass; Astro
reports 101 files with zero errors, warnings or hints. Production builds pass at
both `/` and `/mise/`, and all 270 reference exports are present. No layout change
or new visual comparison is claimed.

The migration and exact 54-source-file command bundle are deployed. The hosted
database has 26 migrations and 47 application tables enforcing RLS, with zero
anonymous table access, direct authenticated table writes, public security-definer
functions or public buckets. The six-function deployment includes `commands` v13,
active with JWT verification enabled. Security advisors report one informational
notice and no warnings or errors.

The same six-command SQL role fixture passes locally and hosted, retaining planned
category identity, creation time, literal deleted source and sample audit history.
Private reads, forged identity metadata, ordinary completion, normalized-field
substitution and old endpoint use are denied. The fixture rolls back its synthetic
Auth/domain rows and leaves zero fixture users, businesses or tickets. This is SQL
role verification; a real signed-owner HTTP acceptance is still unproven. Actual
HTTP preflight returns 204; missing and invalid JWTs return 401. No real OTP,
message, provider activation or Auth configuration change is performed.

Credential checks cover working files, staged blobs, reachable history and static
output against nine private values. The report contains only redacted counts and
hashes. No credential or current deployment reference is present. Earlier
nonsecret identifiers remain in published history. Commit/push guards, GitHub
secret scanning and push protection stay enabled; Actions and Pages publication
remain stopped by the owner.

Remaining M30 work includes unsupported settings/export/shop-link and legacy
direct supplier writes, legacy payment-time review, canonical receipt/pull
reconciliation, complete upload/outbox/image controls, real OTP and signed-owner
HTTP acceptance, the 5,000-record 3G gate and remaining staff/agent resources. A
saved receipt alone does not establish canonical local convergence. Later roadmap
milestones remain required.
