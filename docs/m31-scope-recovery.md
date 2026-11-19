# M31 — Review an existing outlet after its cloud scope changes

An existing synced shop can keep its working copy while the original signed-in
account reviews a changed server epoch, outlet scope version or current role.
The flagged Sync controls offer **Review outlet access**; the operator picker
offers the same route when the original operator is locked. Recovery requires
an existing verified canonical base. Initial owner upload and new-device join
retain their separate admission paths.

The screen reuses the original phone sign-in namespace and runtime connection
settings. It downloads a new full snapshot and complete original images, then
shows saved and resulting record counts before application. Stop, resume,
cancel, a fresh review and a complete JSON backup remain available. Reviewing
alone cannot replace working shop rows. New local work makes an old review
stale and requires another review.

## Original work and fresh authorization

The business, outlet, actor, account and connection must stay the same. Current
owner/manager role, epoch and outlet version come from fresh server metadata;
cached owner records and old local hashes grant no authority. Identity and
connection are checked around HTTP and throughout the finite native write plan.
A switch during a domain write aborts the entire transaction.

Every original queued command gets new coverage proof in the new fixed snapshot.
Earlier receipts and earlier covered-command facts must be newly visible; absent,
unknown, conflicting or later-only evidence requires review. Pending absent
commands are projected with their original IDs and bytes, then delivered through
the same idempotent command endpoint. Recovery does not invent acknowledgements,
rewrite intent hashes or replay previously visible money a second time.

The old complete portable shop copy is sealed in a retained admission, including
original full image data. Domain changes, the new canonical base and application,
the new operator, recovery evidence and the binding update commit atomically.
The binding is written last. Quota or authority failure preserves the old shop,
queue, fence, operator and image bytes. Original owner-upload receipts and
new-device join admissions remain unchanged and distinct.

Local schema **21** adds `scopeRecoveries`, bringing internal storage to 35 stores.
Portable backup schema **10** and its explicit 21-table allowlist are unchanged.
Binding version 3 points to the original admission and the latest retained scope
bridge; subsequent scope changes keep every earlier original copy. Normal sync
inherits the bridge. Downloading either backup does not enqueue a new action.

Domain admission and sync activation are separate durable steps. A lost
activation response leaves an admitted shop that can resume after reload without
applying it again. Continue offline pauses delivery and preserves operator locks.
A stale live-query result cannot redirect completed activation back into review.

## Boundaries still open

This implements recovery for the original existing canonical shop. Moving to a
different account/project, unknown or unsupported retained business writes, and
initial owner recovery before canonical admission are separate work. Locked
operators remain unable to attribute new shop actions or share captures until
verified again. No role is restored from cached metadata.

The feature remains behind `cloudSync`, default off. M30 and M31 stay unchecked;
genuine hosted phone OTP, positive signed-owner HTTP acceptance and the other
roadmap gates still require their own evidence. This increment changes no hosted
database, function, credential, provider or bucket. GitHub workflows and Pages
publication remain stopped by the owner.

## Verification

Key captures from the fresh app/HTTP/SQL visual review:
[360 px](screenshots/m31-scope-recovery-360.png),
[768 px](screenshots/m31-scope-recovery-768.png) and
[1440 px](screenshots/m31-scope-recovery-1440.png).
The five required widths have no horizontal overflow or serious/critical axe
violations. Pixel differences against the named existing references are
informational because the phase specifies no dedicated recovery frame.

The [verification record](m31-scope-recovery-local.json) records 2,443 passing
unit tests across 133 files, 437 passing Pages-path browser cases and 17 passing
root-path sync/recovery cases. The full browser run has no failures, skips or
flaky results. Lint and typechecking pass, with no diagnostics across 129 Astro
files. Both base-path builds pass and all 270 supplied exports are present.

The native browser scenarios compare all 20 portable tables outside scoped
member data across two offline browsers; accepted and pending cash occur once,
and complete original images, commands, receipts and admissions survive. They
also exercise download loss and reload, cancellation, changed-role recovery,
lost activation, backup download, account-switch refusal and the locked operator
picker's recovery entry. Local database tests cover all 34 original stores
through schema upgrade, stale reviews, quota rollback, native authorization loss,
repeated bridges and fresh visibility requirements for previously covered money.

Local Auth, Realtime and object Storage adapters are explicit synthetic fixtures;
the scoped SQL, HTTP, native IndexedDB writes and actual app controls are
exercised directly. These checks do not commission a hosted phone provider or
claim real OTP acceptance. Derived bundles for all seven Edge Functions are
byte-identical to the deployed baseline, so this delivery needs no hosted change.

The full visual report is generated locally at `qa/report.html`; pixel
differences are informational. The owner has stopped workflows and Pages
publication, so this increment has no CI artifact or new deployment. The
[published app](https://tanzir71.github.io/mise/app/) remains on its held version;
the local build can be reviewed with the existing `cloudSync` flag.
