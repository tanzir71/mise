# M31 — Joining an existing outlet on a new device

With the opt-in `cloudSync` flag, local setup now offers **Join an existing
outlet**. Save the device connection, verify the phone once, fetch the currently
allowed outlets and explicitly choose where to work. Server role and outlet
permissions determine the choices; user-editable Auth metadata grants no access.
No choice creates a local business until its complete snapshot and original
images have been downloaded and verified.

The selected account/outlet fingerprints, scope versions and fixed read identity
commit before the first snapshot request. Schema 20 adds the internal
`joinSessions` store, bringing the local database to 34 stores. The existing
21-table portable backup remains version 10. No project URL, API key, Auth UUID
or session token is added to shop data, a backup or a public build variable.

A new device signs in before it knows a business. It keeps that same scoped Auth
session through joining, the header runtime and Sync setup. The existing owner
sign-in namespace remains supported. Both namespaces are checked against the
actual connection and installation; the operation target separately pins the
original business and verified account. Joining does not copy tokens, request a
second OTP or sign out the discovery session during the handoff to the app.

Interrupted downloads keep their original read, pages and image bytes. Reloading
shows an explicit Resume join action. Stop cancels the current transfer without
deleting evidence. Check outlets again requires fresh discovery and another
explicit choice; it retains the earlier download. Back to local setup removes
only this join's pending operator before admission. An already downloaded shop
is preserved and must finish its original connection. A JSON backup remains
available during recovery.

The existing atomic canonical join installs the domain records, original images,
base, actual operator and distinct version-2 join fence. It creates no owner
upload or upload receipt. Native transactions check the live original account,
connection and saved selection, including checks after hooks and before final
status. A locked operator requires fresh original-phone verification before
explicit resume. After admission, recovery retains the original pending revision
and never reapplies the downloaded shop over later local work. Final activation
also starts the existing durable sync runtime. Two tabs can share one original
read; only the original atomic admission can activate the device.

The native browser cases exercise the actual forms, installed phone client,
IndexedDB, SQL migrations, scoped HTTP handlers and sync runtime. They verify
manager-only and owner outlet choices, one OTP, no extra logout or owner upload,
original-read recovery after a truncated SQL response, offline cash convergence,
credential-free downloaded backups and cancellation without deleting staging.
Five-width checks cover outlet choices and recovery at 360, 390, 768, 1024 and
1440 pixels. The Supabase Auth gateway, object storage and Realtime gateway in
these local cases are explicit synthetic fixtures; genuine hosted OTP, Storage
and Realtime acceptance remains open.

The visual configuration compares the new connection, code and verified states
with the supplied M33 Getting started and Desktop 14 Business data exports.
Phase 3 names no dedicated join frame, so those comparisons document the existing
tokens, calm cards and controls rather than claiming an exact frame match.
Native captures also show the actual outlet and interrupted-download states.
The [redacted verification record](m31-join-runtime-local.json) reports 2,372 unit
tests across 128 files, 428 browser cases, 25 root-path cases and three final
Pages-path join cases, all passing. Lint and typecheck pass with 120 Astro files
and no diagnostics; both build paths pass and all 270 exports are present.
Full visual QA produced 212 comparisons with zero horizontal overflow, followed
by 15 final join comparisons and 10 native outlet/recovery comparisons. The
five-width native checks report no serious or critical axe violations.

The fresh privacy audit compared ten private values against source, the index,
fetched reachable history and final built output. It found no credentials,
current deployment references or coverage gaps. The 22 older nonsecret identifier
findings remain documented; published history was preserved. Commit/push/build
guards and GitHub secret scanning/push protection remain enabled.

The local report is `qa/report.html`; three key native captures are
`qa/screens/m31-join-outlets-360.png`,
`qa/screens/m31-join-recovery-768.png` and
`qa/screens/m31-join-recovery-1440.png`.
The final targeted comparisons and native comparison reports are also retained
locally under `.private/qa-join-final/` and `.private/qa-join-runtime/`.

M30/M31 remain unchecked. Remaining conflict families, changed-scope recovery of
an existing working shop, staff/agent resources and genuine hosted commissioning
remain required. No hosted configuration or credential changes are part of this
increment. All GitHub workflows remain disabled as requested; there is no new CI
artifact or Pages deployment. The held landing remains at
[Bangladesh](https://tanzir71.github.io/mise/bd/) and
[International](https://tanzir71.github.io/mise/intl/).
