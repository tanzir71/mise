# M30 · Preserve the original upload review

Refreshing a count review no longer deletes any earlier snapshot. Once the local
shop is bound to an upload, the review follows that exact upload ID and manifest
hash, including before the first acknowledgement, after a lost response and after
reload. A newer unbound review cannot replace or hide it. The original source and
later local queue remain available for recovery. M30 and cloud activation remain
incomplete.

The separate upload journal now uses schema 2. Its selected-review pointer is
scoped to the original business, outlet and local owner and saves atomically with
a new snapshot. Selection survives a backwards device clock. Existing schema-1
journals retain their original Blob snapshots and use the earlier selection rule
until a new explicit review is prepared. No snapshot is automatically pruned.
The shop database remains schema 11; portable backups remain schema 10 with the
same 21 shop tables.

Preparing a review first checks for an active binding and checks again after
compression and journal storage. If another tab armed the earlier snapshot in
the meantime, both sources are retained and the active binding wins. Reading a
bound review validates its original scope, manifest hash, complete compressed
payload and matching accepted receipt. Missing, damaged or mismatched evidence
shows recovery with a read-only retry; it cannot silently create a replacement.
An orphan acknowledgement without its local binding also requires recovery.

The screen follows changes from other Dexie connections and tabs and distinguishes
an unstarted count review, an upload in progress and a saved upload receipt. Its
subscription is stopped on unmount, and obsolete asynchronous reads cannot replace
a newer result. Only Dexie reads run inside the live query; hashing and decoding
run outside it, following the
[Dexie live-query rules](https://dexie.org/docs/liveQuery()). The original-review
action stays disabled while the binding is active. Export/backup and the local
shop remain available.

Acknowledgements now preserve the union of verified chunks when two upload clients
or a stale response overlap. An accepted receipt cannot be removed or replaced.
Server-confirmed cancellation permits a fresh review and upload boundary while
preserving the cancelled snapshot and its recovery queue. This does not implement
canonical remote record application, cursor pull or conflict resolution.

Twenty-one added unit cases cover first-acknowledgement recovery, concurrent
preparation/arming, lost begin and finish responses, backwards clocks, original
Blob retention, missing/damaged/scoped evidence, receipt mismatches, selected-row
failure rollback, schema-1 upgrades, stale/parallel chunk acknowledgements and
observer cleanup. Nine native browser cases cover offline reload and later counter
edits, cross-tab arming/acceptance, a newer competing review, read-only recovery,
restoration of the exact original, confirmed cancellation and overflow/axe checks
at all five required widths. Restoring valid evidence clears stale retry errors.

The first complete browser run overlapped visual QA against a temporary preview.
When its owning QA process finished, the preview stopped; 85 cases passed and
260 failed with connection-refused errors. The saved diagnostics identify no
application assertion failure in that run. Verification now sequences preview
owners; the final complete rerun is recorded below. Assertions and application
deadlines are unchanged.

The native cancellation check also waits for the new snapshot's actual commit;
the previous review's already-visible status did not prove that preparation had
finished. Its expected three retained snapshots and original deadline are intact.

The [redacted verification](m30-upload-review-local.json) records 1,739 passing unit
tests across 96 files, all 345 browser cases at `/mise/` and 24 focused browser
cases at `/`. Both browser runs have no retries, skips, flaky results or global
errors. Lint, strict TypeScript and the Astro check pass; Astro reports 101 files
with zero errors, warnings or hints. Production builds pass at both base paths,
and all 270 reference exports are present.

The report also records visual/privacy results and source hashes. Visual QA compares connection,
verification and review screens plus armed, accepted and recovery states at 360,
390, 768, 1024 and 1440 px. M30 has no dedicated Auth/upload-review frame; the
existing supplied M27 More and Desktop 14 Business data exports remain the shell
references. Pixel differences are informational, with no exact-frame-match claim.

Reproduce the comparisons after building with the desired base path:

```sh
pnpm qa:visual qa/configs/m30-auth.json qa/configs/m30-upload-review.json
```

The local [visual report](../qa/report.html) contains thirty comparisons. Three
key captures are the [armed phone](../qa/screens/m30-upload-review-armed-phone-screen-390.png),
[accepted desktop](../qa/screens/m30-upload-review-accepted-desktop-screen-1440.png)
and [recovery phone](../qa/screens/m30-upload-review-recovery-phone-screen-360.png).
Generated captures stay local while CI publication is held.
Native verification code is intercepted by the
test/QA harness; it is not shipped as an application route or command interface.
The hosted schema, functions, Auth configuration and provider are unchanged. No
real SMS, message or owner-authenticated cloud write is performed. Connection
settings and credentials remain outside shop records, snapshots, queue entries,
portable backups, tracked source and static build variables.

GitHub Actions and Pages publication remain stopped by the owner; this report is
local evidence, with no new CI artifact or deployment claimed. Real OTP and
signed-owner HTTP acceptance, the 5,000-record 3G gate, unsupported local writes,
canonical reconciliation, full upload/outbox/image controls, remaining M30
resources and subsequent milestones remain open.
