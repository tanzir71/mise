# Reviewed images on this device

The `ocr` preview now connects saved images to actual invoice, order and Inbox review. Enable it explicitly with `app/?flags=ocr` in an installation. It remains off by default while milestone delivery is held. No OCR provider, backend connection, account, credential or verification number is required for the local flow. Each installation owns any optional hosting or cloud setup.

## Use the saved original

Choose **Snap invoice** in Stock or **Read an image** in Inbox. Select a JPEG, PNG or WebP, or use the device camera where supported. The app saves the complete original in the selected outlet's Inbox before starting recognition. Assigned Inbox images also have explicit read actions. Unassigned shares must be claimed through their existing review first.

The first read downloads the verified English/Bangla engine from this installation. Subsequent reads work offline after the reader has been cached. Images never go to an OCR provider. Stop a read and enter details by hand with one action. A failed, empty or cancelled read leaves the original available. Changing the selected operator, outlet or backend binding discards the open review and cancels its worker; recording checks the actual native selection and source again.

Open or save the full original image. Reader details retain complete literal text and each line's confidence, with **Copy full text** and **Save full read**. Unknown confidence and values below 80 display **Handwriting unclear, check**. OCR text is a proposal, never an instruction to execute. Unsaved reader text and edits are transient; the original image remains in Inbox and ordinary JSON backups.

## Supplier invoice

Check the supplier, every line, its selected stock item and its price. Tap any invoice row to change the name, quantity, unit, unit price or stock choice, remove a row or add one. A stock suggestion requires one exact name/alias and compatible unit; ambiguous choices stay manual. A new stock item explicitly starts at zero before receiving this invoice. Repeated rows retain separate purchase prices while their stock receipt is combined.

Tap the total to edit the printed amount, or explicitly say that no total is printed. An unmatched total blocks recording. Source lines not placed in the invoice remain available under the review tools; a matching total alone does not establish that every charge was included. Select the actual payment method, then confirm that the invoice was checked and the physical quantities were counted. New invoices default to due.

**Add to stock and purchases** records all new stock items, received movements, the purchase and audit events in one native transaction. The original source is unchanged. A stale stock revision, changed source, scope switch or failed native queue write rolls the entire operation back. Refresh current stock and check it again when needed.

The saved receipt survives reload. Reopening or retrying the same source cannot duplicate its stock or purchase; changed retry details are refused. **Check saved receipt** recovers an uncertain reply. **Undo invoice and stock receipt** uses the normal purchase and stock undo rules in one local transaction, including their time limits and protection of later physical counts. It can finish an eligible partial manual undo, and repeating a completed undo makes no new records. Newly created empty stock names remain available at zero.

## List or prescription

Check or rewrite the complete image text, then review its editable lines in the existing calculator. Enter every price or leave it pending, mark unavailable items yourself and propose replacements yourself. Mise makes no medicine recommendation or inferred substitution.

The final form keeps the original image and requires an individual confirmation of every final name, strength/note, quantity and price. Editing a line invalidates that line's check. Duplicate lines each have their own checkbox. This requirement also applies to lists, so switching the image review type cannot skip it. The native writer verifies the exact final values and refuses a catalogue price that changed after confirmation.

**Create unpaid order** saves one order with its image reference and complete checked source text. It never creates a counter sale, payment or credit entry. Record later payment or khata through the existing explicit order actions. One original image can have one financial conversion; reopening it shows the actual receipt.

## Screenshot

Edit the text and title, then choose **Save checked text to Inbox**. This produces a separate text item referencing the original image, without changing the original or recording money, stock or an order. Repeating the exact save returns the same item. Oversized source text is rejected with the existing 12,000-character limit, including the image reference; nothing is silently clipped. A separate text item does not consume the image's later invoice/order action.

## Optional sync and design

If an installation has already configured sync, the invoice is one atomic local outbox group composed of existing stock and purchase commands. Remote delivery commits those commands separately and retains progress for each. A partial or lost reply resumes the original identities; this does not claim a distributed transaction. No backend schema or service is added by image capture.

M26 (`106:484`) supplies the invoice layout and C07 (`111:519`) the pricing layout. The original image is dynamic. Back, bell, confidence dots, package, edit, camera, check, backspace and send use the exact local Figma SVGs at their intrinsic dimensions. The explicit total editor, count confirmation, full source disclosure, receipt recovery and final per-line safety form extend those frames using existing primitives. The desktop invoice side-panel frame (`48:834`) belongs to the later extension; this increment does not fabricate a browser or WhatsApp surface.

The visual harness uses actual local onboarding, source files, the actual engine and human-entered review controls at 360, 390, 768, 1024 and 1440 px. It checks AA and exact visible icon geometry. The separate synthetic prescription file is a UI fixture, not part of the frozen 15-image OCR accuracy corpus. Pixel differences remain informational because the source, working controls and browser chrome differ from the reference.

## Verification and delivery

All 5,283 unit cases across 279 files pass, including 19 native capture cases. Both hosting paths pass 95 browser cases: eight capture cases plus 87 regressions covering the actual engine, existing orders, stock, Inbox, outbox and PWA. The real SQL capture test loses the final purchase reply, resumes the original local group without duplicates, converges it to a second browser and then converges the complete undo. Offline re-read/recording, native failure rollback, source bytes, ordinary backup restore, changed scope/revision and per-line prescription confirmation are covered.

The unchanged 15-image engine corpus again reads 115/120 literal lines and 45/45 exact invoice item rows on each base; every image clears 80% literal accuracy. The expected text, original invoice images, large-data corpora and test deadlines are unchanged. This is clear printed fixture accuracy, not a handwritten prescription guarantee.

Lint, strict types, both builds and all 270 exports pass. The M26/C07 harness produces 15 comparisons per base, with zero automated AA violations or horizontal overflow at all five widths. All ten invoice/pricing comparisons per base check the exact visible Figma icon geometry. Totals/line editors, pricing edits and the final confirmation form are exercised at those widths. Reference differences and deliberate additional controls are documented in the report.

See [the verification record](image-capture-verification.json) for source/corpus hashes and results. Generated local artifacts are [the report](../qa/report.html), [invoice at 390 px](../qa/screens/m40-invoice-screen-390.png), [pricing at 390 px](../qa/screens/m40-pricing-screen-390.png) and [final line checks at 360 px](../qa/screens/m40-confirmation-screen-360.png). These are ignored local artifacts; the committed harness reproduces them using `pnpm qa:visual qa/configs/m40-image-capture.json` against an owned preview. Port 4332 was used here because another project owns 4321. The local check results replace no held CI run or publication.

Final history/artifact scanning runs after the verification record, with the existing private-value comparisons and normal commit/push guards. No guard or reviewed history exception is changed. Hosting, backend/provider configuration, credentials and phone numbers remain installation-owned. Workflows, artifact uploads, Pages publication, service/migration deployment and release tags remain held. M40 stays unchecked for those delivery requirements; its local image-review implementation is complete.
