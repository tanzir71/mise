# Complete payment originals without repeated ledgers

M41 now stores complete shared snapshot values once in the ordinary audit store. Payment matches, financial recordings and undo retain scoped references to that data. The actual financial commands, original source/parser context, recording clocks and confirmation rules remain unchanged.

This is a storage and validation increment in the same unfinished M41 milestone. Its product review interface and complete backend/canonical adapter are still required. Installation configuration remains end-user owned; workflows, CI uploads, publication, services/migrations, provider commissioning and tags stay held.

## Reproduced problem and covered scale

A fixed simulated imported history contains 5,000 immutable charges, their complete original audits/notes, and one customer note of 1,000,000 code units including NUL and an unpaired surrogate. Three actual native collections initially produced 46,271,419 bytes of Payment rows and 46,279,075 bytes of Payment audits. The resulting ordinary backup exceeded the existing 50 MB limit and could not be exported.

With shared evidence, that same fixture produces 8,728 bytes of Payment rows and 16,384 bytes of Payment audits. Its complete backup is 24,463,291 bytes, including all original charges/audits, the full imported note, three real collections and eleven shared evidence records. A fresh native restore retains all originals and can undo the exact third collection. A separate case links three already-recorded collections, then undoes only metadata: debt and all original ledger rows remain unchanged by those match operations.

These are measurements of this fixed corpus, not an unlimited database-size or device-speed guarantee. The ordinary 50 MB backup limit remains. No note, ledger entry, image, original parser result or historical financial outcome is truncated to meet it.

## Shared immutable data

`source.payment-evidence` audit records contain a complete literal value, its business/outlet scope and a SHA-256 content digest. A deterministic identity deduplicates the same scoped value; the full digest and complete body are checked before reuse. Evidence records describe saved data rather than a new sale, collection, order change or provider verification.

Compact snapshot roots reference the complete original account/customer, order, receipt or setup values. History stores the small root reference instead of copying large labels into each revision. Received/recorded times and checked integer money stay explicit. Historical match roots remain reachable through their original Payment audit even after metadata unmatch, edits or setting an observation aside. No new native table or index is needed.

Credit targets retain a checked prefix witness: account, row count, final sequence, balance and a domain-separated digest chain over every complete original entry in sequence order. The immutable entries remain in the ordinary ledger table. Validation recomputes their chain, checks the precise prefix and financial sequence, and detects missing/changed rows even when their net balance is unchanged. Appending later entries does not rewrite the earlier prefix.

The synchronous portable SHA-256 implementation is the explicitly pinned `@noble/hashes` 1.8.0 package already present in the lockfile. It keeps ordinary backup validation synchronous and works inside existing native transactions. Its result is checked against an independent Node implementation; canonical JSON escaping distinguishes NUL, unpaired surrogates and replacement characters. See the [upstream implementation](https://github.com/paulmillr/noble-hashes/tree/1.8.0).

## Validation and atomic actions

Each root has a strict version, stage, target, scope and money header. Resolving it verifies complete snapshot content, related entity shapes and business/outlet relationships. The reader rejects a snapshot captured later than the consuming action, including after a cached read. Unreferenced evidence and missing or changed nodes fail ordinary backup validation. Matching an existing receipt remains separate from recording new received money.

Actual domain effects, shared evidence, Payment changes and their audits commit together. An evidence audit failure rolls everything back. Original-request recovery expands the checked original reference without replaying an old request over later money. Existing financial undo uses its real domain receipts and original ten-minute/dependency rules.

Digests and restored snapshots are equality evidence, never new write authority. Native source/operator/binding guards, actual current comparisons, explicit financial confirmation and the live-binding fence remain. No backend adapter is fabricated by serializing these records into a different observer protocol or into human messages.

## Backward compatibility and remaining work

Native schema 29 and the twenty-two ordinary tables remain. New ordinary backups use schema 13. Strict schema-12 imports retain their original complete inline financial snapshots and audits unchanged; they cannot claim the newer compact fields or evidence records. Earlier supported schemas retain their existing upgrades. Empty-payment version-one cloud wire snapshots and original review fingerprints stay compatible. Nonempty Payments remain blocked from unsupported upload/canonical operations.

The complete backend/source-command, upload vocabulary, original financial/allocation outcomes and canonical recovery still belong to M41. The product review must expose the actual original and manual/offline recovery while preserving all end-user configuration and privacy rules. This increment enables no production capture/review consumer and deploys no service.

## Verification

The [verification record](payment-storage-verification.json) records exact source fingerprints and completed checks. New cases cover content/hash/scope/time integrity, complete prefix retention, shared large labels, native rollback, legacy import and large ordinary restore/undo. The real Chromium corpus uses the same fixed 5,000-entry history and complete note, with offline reload and actual IndexedDB restore/undo; its dedicated new deadline does not change any existing browser case.

Existing export, upload and restore contexts are compared to supplied references at both hosting paths. These are compatibility checks, not a substitute for M41's remaining product interface.

All 5,449 unit tests in 286 files passed with the original corpora and deadlines. After that full run, the deprecated SHA-256 import path changed to its identical `/sha2` export; an identity check and all 81 focused cases in six files passed again. Final lint, strict types (zero errors/warnings/hints), both production builds and the 270-export check passed.

At each hosting path (`/` and `/mise/`), all 166 distinct selected browser cases across 22 files passed once, with no retries, skips or flakes. These include six native-payment cases, the actual large IndexedDB corpus, offline reload, fresh restore, original financial undo and metadata unmatch. Accessibility assertions in the selected cases passed. Each visual report has 18 supplied-reference comparisons across 360, 390, 768, 1024 and 1440 px, with no overflow.

The [root report](../.private/m41-storage-root-qa/report.html) and [Pages report](../.private/m41-storage-pages-qa/report.html) remain ignored local artifacts while workflow uploads are held. Three compatibility captures are the restored-payment preview at [390 px](../.private/m41-storage-root-qa/screens/native-payment-restore-390.png) and [1440 px](../.private/m41-storage-root-qa/screens/native-payment-restore-1440.png), plus the [existing upload review at 390 px](../.private/m41-storage-root-qa/screens/m30-upload-review-armed-phone-screen-390.png). They do not claim a delivered M41 product editor or a new hosted deployment.
