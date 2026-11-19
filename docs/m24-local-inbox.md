# M24 — Keep shared sources until their outlet is chosen

A message or image can arrive while this device's selected operator is locked.
The receiving service worker now keeps the complete source without assigning it
to the saved shop or inventing an actor. The operator screen confirms that the
share is saved. After a real outlet selection or verified cloud recovery, Inbox
shows **Saved on this device** separately from the outlet's assigned sources.

Opening a saved share shows its original text and images, the currently selected
outlet and member, **Add to [outlet]** and **Keep on this device**. Keeping it makes
no shop entry. Adding it explicitly records the existing typed `inbox.capture`
action; it creates no order, payment or stock movement. The ordinary manual
sorting/forms remain a separate step. Editing shop details no longer assigns
waiting shares; first-time onboarding retains its original atomic claim behavior.

The source keeps its original ID, creation time, image identities, order and full
bytes. Claim time becomes the capture audit/update time. Complete original bytes
are read before the writer, then checked again under the native transaction's
locks with the explicitly reviewed destination. Another outlet/member selection,
competing claim, changed source or failed audit cannot partly assign it. Image
metadata goes into the command; full Blobs remain in the source and recovery row.
When Web Crypto is unavailable, a manual claim keeps its untyped source for review
and cannot manufacture a typed delivery or receipt.

## Local retention and sync

An unassigned share under an existing cloud fence already has an original local
queue record. That record is kept unchanged, with `retained` status and no command
or server receipt. A narrow check recognizes only initial, unassigned Inbox inserts
with exact fields, original timestamps and complete image representations.
Mixed writes, existing-row edits, assigned sources, unknown fields and purported
acknowledgements do not qualify.

Delivery can pass these device-only sources while preserving the usual stop at an
unsupported shop write. It checks the original operator and full retained source
before proceeding. Canonical pulls and freshly authorized scope recovery retain
the unassigned originals as a local overlay. They neither upload them nor count
them as server commands. Sync can finish normally while Inbox still offers the
person's review. A later explicit claim is delivered through the existing audited
command/image path and becomes visible to another authorized browser.

Local schema 21/35 stores and portable schema 10/21 tables are unchanged. Customer
text and links stay inert. No Auth identity, token, connection value or deployment
detail enters a domain command or backup. This increment changes no hosted
service or configuration. `shareTarget` and `cloudSync` remain default-off;
installed Android acceptance and genuine hosted phone acceptance stay open.
M24/M30/M31 remain unchecked. Workflows and Pages publication remain stopped.

## Verification

Eleven focused tests cover the separate receiving store, original source/typed
claim, changed destinations, competing claims, audit rollback, operator changes
during full-image hashing, explicit assignment after profile edits, unsafe group
rejection, canonical projection, unsupported-write ordering and missing Web Crypto.

Native browser scenarios submit real offline multipart shares through the installed
worker. They exercise sign-out, the phone verification interface, fresh outlet
recovery, cash delivery before the share is assigned, one explicit offline claim,
complete image convergence into a second browser, and actual IndexedDB quota
failure followed by reload and a single successful retry. SQL, HTTP, IndexedDB and
app controls run directly; Auth verification, Realtime and object Storage use
explicit synthetic adapters. These tests do not commission real SMS or establish
installed Android acceptance.

The [local verification record](m24-local-inbox-local.json) records passing lint,
typechecking with zero diagnostics, all 2,463 unit tests across 135 files, 22
root-path sync/recovery browser tests and all 442 Pages-path browser tests.
There are no failed, flaky or skipped browser cases. Both `/` and `/mise/`
production builds pass, and the original 5,000-record upload regression still
passes its under-60-second 3G gate. All seven derived Edge Function bundles are
byte-identical to the deployed baseline; no hosted deployment is needed.

The full local `qa/report.html` contains 237 comparisons with no horizontal
overflow. The three new views each pass serious/critical axe checks at 360, 390,
768, 1024 and 1440 px. All 270 supplied exports are present. Comparisons use M25
for source review, M20 for the Inbox list and the existing M27 hierarchy for the
operator notice. These extra states have no dedicated exported frame; their
pixel differences are informational. Key captures are committed:

- [Phone source review, 360 px](screenshots/m24-local-inbox-360.png)
- [Locked operator notice, 768 px](screenshots/m24-local-inbox-768.png)
- [Desktop saved-share list, 1440 px](screenshots/m24-local-inbox-1440.png)

The [privacy audit](security-audit.json) covers current source, the index, freshly
fetched reachable history and generated output with private in-memory comparisons.
Commit/push guards and GitHub secret scanning/push protection remain enabled.
No new CI artifact or Pages deployment is claimed while workflows remain stopped.
