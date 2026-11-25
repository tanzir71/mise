# Payment text in the actual Inbox review

M41 now has a native payment review inside the existing shared-source sheet. The `paymentText` flag defaults off. The original Inbox source, manual customer-payment form and ordinary backup remain available. This is the product-interface part of the same unfinished milestone; its complete backend/source-command, upload and canonical adapter are still required.

Each installation configures its own source labels, timezone, numeric date order, payment methods and bank reference labels. This interface needs no maintainer account, provider credential, receiving account or verification number. Reading and matching happen on the device and do not authenticate a transfer.

## Check the original

The existing Inbox view keeps the literal source text, title, URL and original images. Payment review adds full-source copy with a selectable fallback when the clipboard is unavailable. The manual customer-payment form is one tap away. A source which already recorded money shows an explicit warning before that separate manual form can create another financial receipt.

Unknown formats open editable checked details, prefilled with a conservative amount hint when one was found. Recognized messages also require a human to check the amount, actual payment method and received time. A complete phone can be entered and normalized; masked phones are never expanded. A bank/source label belongs to the installation and does not verify a bank transfer.

Source settings can be changed before the first observation. Applying changed settings deliberately replaces an unsaved proposal. Received time uses that source timezone rather than the browser clock and preserves milliseconds. Unchanged fields retain their exact known original instant, including either side of a daylight-saving fold. Changed ambiguous or missing wall times require correction. Missing message time is explicitly identified as the captured-source time, requiring review. Existing saved proposals retain their original parser result, clock and source type when reopened or edited.

## Link or record money

Saving checked details creates an observation, not money. A unique eligible current candidate is linked automatically after that human check. Other matches show the closest three and the full eligible count; the matching window is editable. Every association is rechecked by the native transaction against the actual selected source, operator and target.

An existing financial receipt remains a metadata link. Removing it leaves sales and debt unchanged. An unpaid-order link also records no money, but it can proceed directly to a fresh review of a payment for that same order, using the existing financial command's supported association. Other new money can be reviewed for an actual unpaid equal-amount order, customer account with enough debt, or an explicitly new counter receipt.

The financial preview shows the actual target, checked amount/method and received time. The final recording requires a separate **This money was received and is not already recorded** confirmation. Editing the target or note clears that consent. The real order, khata or counter command writes its domain receipts, shared original evidence, Payment and audits atomically. Received time never backdates the recording.

## Original recovery and undo

Reloading opens the saved source and its current receipts. It never resubmits a financial comparison. A failed financial request inspects its original action identity; an actual committed result is shown instead of recording it again. An aborted native audit transaction leaves no money and requires a deliberate confirmed retry.

Original inspection distinguishes received time, actual recording time, target/receipt identity, recording note and complete saved history. It also shows the original parser proposal separately from the first checked details. Long histories can be opened progressively without deleting earlier records. General displayed receipt times name the current outlet timezone; the original proposal displays its own saved source clock.

Undo reviews the original financial recording and requires separate confirmation. The normal ten-minute and dependency rules remain. A genuine independent original undo can be acknowledged without reversing money twice. An expired undo stays inspectable and points to the actual order, account or counter history for a manual correction.

## Native boundaries and design context

A read-only frame keys the sheet to the actual setup, operator selection, connection and complete current source snapshot. Source, actor, outlet or binding changes discard stale UI plans; every command still rereads its own native proof. Comparisons are never persisted as write authority. Archiving a source requires reopening it before changing this review.

Native schema 29, ordinary schema-13 backups and the twenty-two ordinary tables remain unchanged. Unsupported connected-shop payment writes stay fenced; that shop retains the original source and the existing manual payment path. No new observer-protocol cast, machine data in human notes, hosted service or provider setup substitutes for the full M41 adapter.

The existing share-source view follows supplied M25 `104:950`. M41 specifies no dedicated payment-editor export. The review uses the actual shared modal, token typography and 44 px controls. Visual comparisons use the supplied M25 source and M29/Desktop 18 utility-sheet contexts, explicitly retaining informational content/layout differences. The report includes focused consent-region captures as well as whole-sheet context.

The reusable configuration is [qa/configs/m41-payment-review.json](../qa/configs/m41-payment-review.json). Run `pnpm qa:visual qa/configs/m41-payment-review.json` against a production preview to reproduce the source, checked details, consent and original receipt comparisons. Its synthetic shop and source are created through the actual forms; no private installation inputs are needed.

The [original target inspection follow-up](payment-inspection.md) now resolves checked order numbers, original customer names and counter labels from validated immutable evidence. It retains those labels after later edits and opens actual order/customer routes, including the original account currency. Full backend/canonical integration remains required before the preview flag graduates.

Workflows, CI uploads, publication, service/migration deployment, provider commissioning and tags remain held. The preview is default-off and M41 remains unchecked.

## Verification

The [verification record](payment-review-verification.json) records the final source fingerprint and exact completed checks. New unit cases exercise installation-clock round trips, DST rejection and native source/target scope. Real-browser cases cover the default-off/manual paths, safe literal source and copy fallback, unique/top-three linking, actual financial commands, original undo/acknowledgement/expiry, native rollback/retry, offline reload, source changes and five-width accessibility. The original unit corpora and deadlines remain intact.

All 5,466 unit tests in 288 files passed with the original corpora and deadlines. After that full run, a form-only correction retained a known original instant when its unchanged local fields occur twice during daylight saving. Core and unit sources remained identical. Final strict types and two complete browser cases verify both original UTC instants, rejection of an edited ambiguous time, and later checked edits without reinterpreting the saved proposal.

At each hosting path (`/` and `/mise/`), all 186 distinct selected browser cases across 23 files passed once, with no retries, skips or flakes. These include all twenty new actual-review cases and all six existing native payment/large-backup cases. Final lint, strict types with zero errors/warnings/hints, both production builds and all 270 supplied exports passed. Accessibility assertions cover the editable form, financial confirmation, recorded receipt and expanded original history at all five widths.

Each final visual report has 21 supplied-reference comparisons at 360, 390, 768, 1024 and 1440 px, with no overflow. The [root report](../.private/m41-ui-root-qa-final/report.html) and [Pages report](../.private/m41-ui-pages-qa-final/report.html) remain ignored local artifacts while uploads are held. Three actual captures are the [checked payment at 390 px](../.private/m41-ui-root-qa-final/screens/m41-payment-checked-phone-sheet-390.png), [required financial consent at 390 px](../.private/m41-ui-root-qa-final/screens/m41-payment-confirmation-phone-consent-390.png), and [original receipt at 1440 px](../.private/m41-ui-root-qa-final/screens/m41-payment-original-desktop-sheet-1440.png). The tracked reusable configuration reproduces the same actions and reference contexts.

Initial development runs found exact wrapping-label selector mismatches and a disabled button incorrectly labelled Saving. Those were corrected before complete passing runs. The verification record retains the initial whole-file results, the final recorded-receipt/history accessibility expansion and the subsequent known-instant form correction. It makes no claim of a new CI run, hosted publication or completed M41 backend adapter.
