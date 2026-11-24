# On-device OCR groundwork

M40 now has a real English/Bangla reader and a conservative invoice proposal parser. The reader runs Tesseract.js 7 in a dedicated browser worker. It needs no OCR account, API key, provider or maintainer phone number. Hosting remains each installation’s choice.

M40 remains unchecked. The next increment must connect the saved-image Inbox entry to the M26 invoice review and C07 order review, including atomic stock/purchase recording, editable lines, and seller confirmation of every prescription line. The `ocr` flag defaults off. This internal reader is not yet a new user-facing capture flow.

## Engine and original source

`apps/web/src/ocr/worker.ts` accepts an immutable image Blob. Its caller must save the original in Inbox before starting recognition, bind review to the original operator/outlet, and discard a late result after that selection changes. The reader itself writes no business records. Invoice proposals do not execute source text or post orders, purchases, payments or stock changes.

Before decoding, the reader checks the encoded JPEG/PNG/WebP dimensions and the existing 5 MiB image limit. Decoded images are limited to 16 megapixels and 16,384 pixels on either axis. Small text is enlarged on a separate temporary raster; transparency is placed on white and browser image orientation is retained. The original Blob stays unchanged. Bitmaps and temporary canvas storage are released, and returned line boxes are scaled back to the displayed original.

The adapter owns the native worker from its creation, including initialization. Cancellation or failure terminates that worker, rejects its pending job and frees the next read. Correlated replies, a per-job timeout and one active read per page prevent overlapping or abandoned work. Tesseract’s pinned worker protocol is isolated in this adapter and tested against the actual shipped worker.

Full engine text is retained without truncation. Layout supplies each line’s original confidence and box. Missing or invalid confidence remains unknown, rather than inheriting the page confidence. Values below 80, or unknown values, receive the warning “Handwriting unclear, check”. An empty result remains empty and needs manual entry.

## Download and offline use

The build copies unmodified files from pinned npm packages into this installation’s `app/ocr/` directory. `assets.json` records the versions, full byte lengths and SHA-256 digests. A dependency or file mismatch fails the build. The staged binaries are ignored in Git; the lockfile, manifest, notices and source are tracked. Licenses and bundled worker notices accompany the generated assets.

The six runtime files total 16,139,332 bytes: the worker, three LSTM core variants and English/Bengali models. They are excluded from PWA precaching and fetched only when an OCR read is requested. The model path and worker/core paths are explicitly same-origin; no CDN or remote image-reading request is used. A controlling service worker is required for the saved reader.

Only known versioned engine files enter the namespaced OCR cache. Complete bytes and hashes are checked on download and again on use. Redirects, oversized/truncated responses, corruption and cache-write failures stop the operation. Damaged offline copies fail; an online retry can fetch a valid replacement. Images and OCR results never enter this engine cache. After the first successful download, recognition works after an offline reload under both `/app/` and `/mise/app/`.

## Invoice proposals and measurement

`packages/core/ocr-invoice.ts` proposes only explicitly printed item name, quantity, unit, unit price and line amount. It understands joined units such as `10L` and `7.5kg`, preserves the raw source and leaves unknown lines available for manual review. It never guesses that `101` means `10 L`. Money uses integer minor units and existing quantity/line arithmetic. Each printed line amount is checked independently; duplicate totals remain ambiguous, and a missing total stays missing. A matching total describes only the proposed lines, not proof that the entire invoice is correct.

The fixed corpus contains 15 synthetic clear printed invoices: 120 text lines and 45 priced item rows. It includes two fonts, JPEG/PNG, decimal quantities and prices, and varied item names. Expected literal text and exact item fields are independent fixture data. All original images and expected lines remained unchanged while the reader was improved. Literal scoring normalizes Unicode and whitespace only; item scoring compares every name, quantity, normalized unit, integer unit price and printed amount, in order. Each image must have at least 80% literal lines and every item field must match. A separate Bangla image checks actual Unicode recognition; it is not evidence of handwritten prescription accuracy.

The first raw run exposed `L`/`1` confusion. Raster preparation corrected those readings. Remaining differences are quantity/unit spacing, retained verbatim in the raw result. The final corpus has 115/120 literal lines (95.83%) and 45/45 exact structured item rows; all fifteen totals match. See [the verification record](ocr-engine-verification.json) for the commands, corpus hashes and hosting-path results.

The browser harness serves a test-only bundled module through Playwright interception. It is never written into the production site. It uses the actual built service worker, actual pinned engine and real fixture pixels; recognition is not mocked. Cancellation during real engine initialization and a subsequent fresh read are also covered.

The convergence HTTP fixture uses the explicit `MISE_E2E_ORIGIN` override, with its existing port-4321 default. It still permits one exact origin. This lets the browser checks use their separately owned port 4332 without touching another project’s preview or widening production CORS.

## Delivery boundary

Installation configuration, backend/provider credentials and verification numbers remain end-user owned. This increment provisions no external service. GitHub workflows, Pages publication and release tags remain held under the owner’s instructions. There is no new UI screen in this checkpoint, so the M26/C07 visual comparisons belong to the upcoming review-flow increment. Full M40 acceptance, including editable review before recording and mandatory per-line pharmacy confirmation, is still open.
