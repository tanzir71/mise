# Joining an existing outlet on an empty device

An owner or assigned manager can now install a complete, validated canonical
snapshot on a device without a local shop through the internal sync engine.
The snapshot includes original image bytes and historical financial references.
The join does not create an owner-upload receipt. M30/M31 remain incomplete and
the full cloud interface remains disabled. Verification is recorded in
[m31-canonical-join-local.json](m31-canonical-join-local.json).

The manager regression uses the actual committed SQL feed, compressed HTTP
handler, runtime client, sealed IndexedDB staging and existing backup validator.
Before the change, an owner without an explicit outlet assignment was omitted,
leaving an owner-authored audit without its required member. The regression now
retains an owner-authored cash sale and activates the actual manager.

The feed adds `member_refs` for real historical references from the selected
outlet's events and records. These projections contain only identity, business,
original timestamps, name and role. They contain no phone, Auth identity, active
status or invented assignment. Reconstruction uses an inactive historical member
when there is no authorized full profile; that reference cannot become an
operator. Existing member RLS and full-profile visibility remain unchanged.
Other outlets' unreferenced people remain hidden.

Reference capture shares the original transaction. A forced-RLS private queue
coalesces repeated member/outlet dependencies across a large batch, then drains
them before commit. Deferred triggers preserve
legal child-before-member writes. Name/role changes update the projection;
removing the last reference emits a tombstone. Capture avoids repeated identical
profiles. Privileged history truncation removes obsolete projections and changes
the feed epoch. Migration backfill changes the epoch too, requiring a complete
bootstrap rather than letting an old cursor claim dependency completeness.
Literal NUL and lone-surrogate strings remain serialized JSON text throughout.

Canonical reconstruction keeps the latest full bigint ordinal for each record
and retains tombstones. It resolves real member/customer associations, verifies
all original image hashes, checks scoped references and financial invariants,
and runs the existing complete portable-backup validator. A staged incremental
catalogue update can reuse unchanged verified image bytes from its prior base.
This is a pure reconstruction step; it does not apply an update over pending
local work.

The empty-device join rechecks fresh server account, actor, role, outlet, epoch
and scope metadata before opening its native writer. That writer checks the
original operator revision and sealed staging, holds every domain/outbox store,
and commits the shop, canonical base, accepted cursor, active operator and
distinct version-2 join fence together. It does not disable capture or create
outbox echoes. The fence is installed after the exact canonical writes while
the same writer still holds the store locks. Portable backups remain schema 10
with 21 tables; local schema 16 adds internal `syncCanonical` as its thirtieth
store. Earlier uploads and their version-1 receipts retain their original format.
The legacy fence fields `uploadId` and `ownerId` hold the binding identity and
selected actor for both variants; a version-2 fence is explicitly marked `join`
and its upload receipt is null.

A retry after a lost response verifies the original admission and base without
reapplying rows or overwriting later offline cash. Quota failures roll back the
whole join, preserving the staged pages, images and pending selection. A changed
account, operator lock or altered scope refuses activation. Unassigned shares
arriving on an empty device remain unassigned beside the joined shop. A device
with an existing local shop or queue requires reconciliation and is preserved.
Joined offline writes use the existing typed outbox; a locked joined operator
cannot start network delivery.

Native browser checks cover owner and manager joins, original images, quota
rollback, offline cash/reload, exact retry and refusal to unlock a revoked
operator. Separate browser contexts use separate IndexedDB databases. Their
authorization fixtures are explicitly synthetic. They prove local installation
and retention, not genuine hosted phone authentication or convergence.

The exact rollback-only SQL-role proof checks historical capture, literal data,
private helper denials, unchanged direct member RLS, outsider isolation and live
revocation before a cached page. Its own uncommitted records are correctly absent
from the fixed feed snapshot. Positive committed-feed delivery is proved by the
separate local SQL-to-HTTP regression; the rollback proof does not claim it.

Remaining work includes canonical application over original pending overlays,
intent-based rebasing, reconnect/realtime orchestration, and two browsers
converging after offline edits without lost records or money. Genuine phone OTP,
hosted owner/image HTTP and the 5,000-record 3G timing gate also remain open.
No provider is activated and no deployment value is embedded in source or builds.
GitHub Actions remain disabled, so this increment has no CI artifact or new Pages
deployment. The published site remains at the owner's held revision.
