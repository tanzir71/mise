# Native saved payments

The follow-up [native financial recording increment](payment-finance.md) adds explicit order/khata/counter recording and original financial undo, with schema-12 backups. The verification below records the earlier persistence delivery. Product review and the full backend/canonical adapter remain required in the same M41 milestone.

The initial persistence increment added a first-class local `Payment` record, a Dexie schema-29 store, schema-11 ordinary backups and native source/review operations. It provided the persistence and association layer of the same M41 milestone. At that checkpoint, the product review interface, guarded financial posting and complete backend command/canonical adapter remained required before enabling the feature. The existing Inbox manual-money flow and M37 backend observation service keep their separate contracts.

## Original source and checked values

`openSavedPaymentSource` reads an actual assigned Inbox item under the currently selected operator and outlet. It retains the complete original title, text, URL and capture time, plus the unmodified parser proposal and its original context. Original images remain in Inbox and its ordinary backup; M41 parses the text, not the image or a fetched URL. Unsupported controls and literal source instructions stay data.

The source sender label, date order and timezone are installation inputs. The timezone defaults to the outlet timezone and can be explicitly overridden for a source whose printed clock uses another zone. None of those labels authenticates a sender or proves a transfer. The currency and market still come from the selected outlet/business, and the capture time comes from the actual saved item. No backend connection or credential state is copied into the record.

Saving requires explicitly checked positive integer money, currency, received time, method, reference and optional complete E.164 phone. Cash, Card, the market's wallet labels and the generic Bank transfer label are supported. That bank label records a method; it creates no receiving account or provider integration. A checked correction never overwrites the original parser result.

One source has one stable Payment and original capture audit. Deterministic, distinct record/audit identities and the native source index allow recovery after a lost reply or reload. A repeated capture returns the original receipt only for the same checked details. An active provider/method/currency/reference key rejects duplicate observed references, including case changes. All writes and audits share one native transaction; an audit or quota failure leaves neither half behind.

## Association is separate from money

Current proposals use actual scoped orders, sales, khata entries/accounts/customers and refunds. The checked method and amount/currency/time are applied to the existing parser planner. Another active Payment reserves its selected target. A unique recognized source can associate automatically after its time is known or explicitly checked; a choice among ambiguous candidates requires an actual runtime comparison.

Comparisons are bound to the real database, selected operator, connection, original source and complete Payment snapshot. Serialization does not preserve their authority. A writer rereads the current source, Payment and candidate in its transaction. A source edit, revision change, changed target or competing association requires a new comparison. Stored candidate snapshots preserve their complete literal values and are checked for scope, identity, method and money consistency.

Association does not settle an order, create a counter sale, collect debt or undo a financial receipt. The native receipt reports whether its original association still describes the actual current target. A later payment, edit, refund or reversal can make that association stale without erasing its original history or restoring money. The remaining M41 financial adapters must explicitly distinguish posting new money from linking an already-recorded receipt.

Edits require the current revision and an unmatched active Payment. Unmatching appends a metadata undo referencing the original match. Setting an observation aside retains its source and audit; reopening creates another revision. Stable action identities recover original edits, matches, metadata undo and state changes without applying an old request to a later decision. Recovery returns the current record alongside the original capture and complete audit chain.

## Backups and the unfinished sync boundary

Ordinary JSON backup/restore includes Payments, original Inbox content/images and all payment audits. Validation rejects missing/foreign sources, incomplete or discontinuous audit chains, mismatched latest state, malformed candidate snapshots and duplicate active reference/target keys. These records remain observations after restore and never become backend authorization. Schemas 7–10 upgrade with an empty Payment table; they cannot claim that the new table already existed in their older schema.

Adding an empty table changes no logical records, so it preserves existing schema-10 review fingerprints. A nonempty Payment table always participates in the logical snapshot. The existing version-one cloud manifest still enumerates its original 21 supported tables. Its compressed wire snapshot remains schema 10 when the new native table is empty, so existing receivers and original prepared uploads keep their format. Nonempty Payments are rejected before upload chunks are prepared; they are never omitted from an upload or given a fabricated SQL mapping.

Until the M41 adapter is implemented, native payment writes reject a live cloud binding, and canonical application retains any native Payment data instead of replacing it with an older supported snapshot. This is a temporary development fence, not completed M41 sync. Backend schemas, source commands, financial/allocation receipts and canonical recovery still belong to this milestone. No service or migration is deployed by this increment.

Unit checks exercise actual local recording, immutable originals, concurrent capture/matching, quota rollback, bank alerts, configurable source timezone, stale candidates, existing sale/khata receipts and their later reversals, original-action retry, metadata undo, ordinary restore and strict legacy upgrades. Test-only Chromium entries exercise real IndexedDB/offline operations and the installed app's restore interface. They are not production capture routes. Full milestone and UI acceptance are still open.

All hosting, backend/source/provider accounts, credentials, phone numbers and later device enrollment belong to each installation. Privileged provider credentials stay server-side. No maintainer account or verification number is needed for these local operations. Workflows, CI uploads, publication, service/migration deployment and tags remain held.

## Verification of the persistence increment

The complete unit run passes all **5,416 tests in 283 files**, including 36 native Payment cases and two independent legacy-upload compatibility cases. The focused native/backup set passes 210 cases. Original 5,004-record history, 1,000-line and million-character fixtures and wall-clock deadlines remain unchanged. On the busy Windows host, the final run used private process-local Node priority with the repository's two-worker limit; browser runs used one worker.

Both root and `/mise/` browser coverage verify **164 distinct cases per path**, without skipped cases or automatic retries. The reports retain the initial attempts and their complete-file rechecks:

- Root: 163 initially passed; one old upgrade assertion still expected schema 28/42 stores. The corrected schema-29/43-store expectation and schema-11/13/14 fixtures exclude the newly introduced Payment store/indexes and assert an empty new store. All 18 cases in those three whole files then passed, retaining every original image/hash, queue, receipt and operator check. Application source and the root build did not change for that recheck.
- Pages: 163 initially passed; the existing cross-tab credential-removal case hit its original 30-second deadline during host contention. Its failure snapshot already showed the locked operator screen. All 11 cases in the unchanged operator file then passed; the timed-out case completed in about three seconds. Checksums of 572 application and operator-fixture source files remained unchanged. No deadline was extended.

Both production builds, final lint and strict types pass; Astro reports zero errors, warnings and hints across 214 files. All 270 supplied exports are present. The existing export and upload-review contexts have 18 supplied-reference comparisons per hosting path at 360, 390, 768, 1024 and 1440 px, with no page overflow. Pixel differences remain informational. The actual restore count panels pass axe checks at 390/1440 px and are byte-identical across the two hosting paths; these utility panels do not constitute M41's remaining capture/review interface.

Local comparison reports: [root](../.private/m41-native-root-qa/report.html) and [Pages](../.private/m41-native-pages-qa/report.html). Three inspection captures are the [phone restore counts](../.private/m41-native-root-qa/screens/native-payment-restore-390.png), [desktop restore counts](../.private/m41-native-root-qa/screens/native-payment-restore-1440.png) and [retained upload review](../.private/m41-native-root-qa/screens/m30-upload-review-armed-phone-screen-390.png). These ignored local artifacts have not been uploaded to CI or published. The reference contexts can be reproduced with `pnpm qa:visual qa/configs/m17.json qa/configs/m30-upload-review.json` against an owned production preview.

The [verification record](payment-capture-verification.json) retains exact source hashes, scope, original/recheck results and remaining M41 requirements. Workflows, publication, service/migration deployment, provider commissioning and tags remain held. Installation-specific setup remains end-user configured.
