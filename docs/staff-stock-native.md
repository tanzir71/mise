# Saved staff stock requests

The paired-screen stock controller saves complete original quantity requests in its own native journal before networking. A current backend comparison and a separate human confirmation are still required to change a quantity. This supplies the storage and controller behind the [quantity backend](staff-stock-quantity.md); the shared-screen stock interface is next. M34 remains unchecked, both new stock services remain undeployed/default-off, and workflows and publication stay held.

## Original requests and current comparisons

Only an actual stock page returned to this controller can supply a selected item. Structural copies, edited pages and another member's data cannot authorize capture. The controller snapshots the selected source before awaiting storage and retains every original label, alias, unit, quantity, note, physical time, ID, screen revision and PIN scope. Complete source hashes are checked on native reads. Literal text remains data.

The version-four screen database adds a separate `stock` store and preserves existing enrollment, kitchen and attendance records. Each device/member journal retains its complete original requests and actual outcomes. History is append-only: it cannot silently drop originals, undo a close choice or rewrite a terminal receipt. The existing 50 MiB budget applies to each original, including 1,000-line batches and million-character imported fields. There is no smaller aggregate limit that evicts history. At 200 originals or a browser storage failure, keep the saved work and use the manual owner/manager path; an explicit archive interface remains future work.

Quantity pages and prepared reviews do not restore authority from disk. The controller keeps tokens and live HTTP proof only in memory. A saved or caller-edited quote cannot confirm a change, and reload requires another explicit current comparison. Current native enrollment, the blank shared-browser profile, the original member, actual current permissions and real expiry still guard each request. The backend retains the final current comparison and count/undo rules.

Known stock-read denial is saved for the current PIN session. A late successful read cannot erase a newer denial from another tab. Only another genuine authorized read or current comparison can restore work through an atomic source/status comparison. Own-original inspection and closure remain separate from current stock work, including under a later PIN for the same member.

## Recovery and transport

An unconfirmed original stays saved after a lost reply. Inspection recovers the actual backend outcome without submitting a second quantity change. Offline close records the choice before HTTP and later delivers the original closure. A late prepared request cannot revive a confirmed closure. If the backend had already applied the movement before closure arrived, preserve the actual applied receipt and the local close choice; never relabel physical work as unperformed.

Native writes compare the entire enrollment and journal, recheck the route generation inside the IndexedDB transaction and require live response proof for outcomes and restored reads. Concurrent tabs cannot append competing pending requests. Sign-out or an owner-profile change prevents a response from attaching to another PIN; the same member can later inspect the original. Quota, malformed data and changed native state preserve the saved originals.

The two fixed stock routes use the enrolled device secret in a header and the member session in the body. They use no owner Auth, cookies, credential query strings or redirects. The full stock request/response budget remains 64 MiB and the complete network/body deadline is 60 seconds, including senders that ignore abort. Errors expose only generic guidance and a bounded retry delay.

## Installation configuration

This adds no account, phone number, provider, credential or maintainer input. Every installation owns its existing backend connection, pairing, member PINs, private service key, exact allowed origins and disabled stock choices. Keep both services off until the matching app and supplied-reference interface are ready. Continue the existing owner/assigned-manager stock flow or tell the manager the physical change by hand while that interface is unfinished.

## Verification

The [verification record](staff-stock-native-verification.json) binds 52 source files to one complete run of 5,228 passing unit tests across 272 files, including 24 new cases. All 95 focused checks also pass. Lint, strict types, all 203 Astro files, both hosting-path builds and generated-artifact checks pass. The selected browser regressions pass all 124 cases at both `/` and `/mise/`, including the actual version-three database upgrade preserving enrollment, kitchen and attendance records and the existing 360–1440 px accessibility checks. No new UI or visual capture is claimed by this controller increment.

Local integration tests use actual device pairing, PIN issuance, HTTP handlers, IndexedDB transactions and PostgreSQL quantity functions. They retain and confirm all 1,000 physical-count lines, preserve million-character NUL labels and surrogate units through native reopen and canonical audits, and recover exact original outcomes after lost replies. They also cover own undo, later PINs without current work permission, offline closure, expired comparisons, edited/serialized authority, two tabs, quota failure and late replies after denial, closure or sign-out.

Windows PowerShell interrupted the first build runner on a Vite warning; the remaining gates completed under PowerShell 7 with actual exit-code checks. A separately interrupted Pages browser run was replaced by a complete passing rerun. All 52 frozen source hashes and all 592 generated-file hashes remained unchanged for that rerun. The passing unit, type and root-browser checks were retained.

The applied quantity contract remains unchanged and its separate managed verification is linked in the record. This increment adds no managed migration, deployed service, configuration input or provider request. The supplied-reference stock interface, manual copy/handoff controls, explicit saved-request archive controls, genuine end-user commissioning and full M34 acceptance remain open. Workflows, CI artifact uploads and publication remain held.
