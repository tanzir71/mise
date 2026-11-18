# M30 · Original Inbox sources in the local queue

Manual captures, Android share-receiver captures and manual classification,
archive and reopen now retain executable Inbox commands in the same local
transaction as their source and audit history. M30 remains incomplete; cloud
controls remain behind their default-off flag.

Captures retain their original item, image and audit IDs, literal title/text/URL,
source creation time and image order. Shared text remains untrusted source data,
including control characters and lone surrogates accepted by the existing Inbox
domain. Capturing or sorting never creates an order, payment, invoice or stock
movement. Repeated current choices write nothing; stale reviews still fail.

Image validation and full SHA-256 hashing happen before the writer opens. The
worker uses the same adapter through `LocalStore`, without importing the owner
database class or React. A cloud binding armed while hashing is pending still
captures the resulting source transaction. Only image metadata and hashes enter
the command; original immutable Blobs stay in the local source and recovery row.
Hashes are not added to stored images or the portable backup schema. The existing
four-image, 5 MB per-image and 10 MB combined limits remain intact.

If Web Crypto is unavailable, image saving still works locally. Its complete
transaction remains retained for review and blocks later ordered delivery;
neither a hash nor a successful upload is invented. Text-only captures remain
executable without Web Crypto. A digest failure rejects before any source write.
Sources shared before onboarding remain unassigned, then retain their original
creation time and image identities when setup claims them. They enter the initial
reviewed snapshot rather than a later outbox command.

Queue or audit failure rolls back the source, image references, history and
sequence fence together. The manual form retains its editable text and selected
file for retry. A failed worker save returns its existing unsaved-source page and
Add by hand link. Lost accepted replies retry the original command IDs and image
metadata; receipts are saved per command. Image bytes still require the separate
authenticated private-image upload path before complete sync can be enabled.

Text-only coverage checks exposed a transaction-lifetime problem when the backup
wrapper dynamically imported its implementation from inside an active transaction.
The upload boundary now calls the already loaded consistent backup reader
directly. This preserves the same transaction and snapshot checks without an
asynchronous module-loading gap.

Eighteen adapter tests cover the original source graph, every classification,
archive/reopen, backwards clocks, concurrent and stale reviews, no-op actions,
onboarding, worker connections, full-size image hashing, missing Web Crypto,
queue/audit rollback and lost accepted replies. Actual serialized queue commands
are replayed through the existing server mutation builder against preceding
records. Image hashes are independently checked against complete original bytes.
Matching clocks isolate identity and domain behavior; these tests do not prove
canonical admission-time reconciliation or positive actual-owner HTTP access.
Five added native browser cases cover offline image/sorting/reload flows, native
queue constraints, selected-file retry, worker failure fallback and retained images
when Web Crypto is missing.

The initial complete browser run passed 330 cases and timed out while closing one
existing offline customer context. Its saved trace shows all sixteen expectations
completed successfully. The public-page fixture now restores connectivity after
the offline assertions and before context/trace teardown. No test assertion or
application deadline is relaxed. Three consecutive teardown probes pass before
the final full run; the redacted evidence retains both results.

The [redacted local verification](m30-inbox-outbox-local.json) records the final
check counts and source hashes. Lint and strict TypeScript pass, including the
Astro check's 100 files without errors, warnings or hints. All 1,691 unit tests
across 94 files, all 331 browser tests at `/mise/` and sixteen focused native
browser checks at `/` pass. The final browser run has no retries, skips, flaky
results or global errors. Both `/`
and `/mise/` production builds pass, and all 270 reference exports remain present.
No layout changes or new visual comparison are
claimed. No hosted migration, function, Auth configuration, real SMS or message is
created by this increment. GitHub workflows remain disabled, and Pages publication
remains stopped by the owner.

Remaining: catalogue adapters; unsupported settings, export, shop-link and legacy
direct supplier writes; canonical receipt/pull reconciliation; full upload/outbox
and image delivery controls; real OTP and signed-owner HTTP acceptance; other open
M30 resources and later milestones. A saved acceptance receipt alone does not
establish that the local copy is fully synced.
