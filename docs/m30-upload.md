# M30 · Reviewed upload and recovery

Status: **client snapshot, recovery engine and local journal implemented**.
Authenticated hosted staging/promotion, original-file delivery, UI/outbox integration
and the real 5,000-record / 3G / 60-second acceptance gate remain open. M30 stays unticked.

## Snapshot and integrity

`packages/core/cloud-upload.ts` snapshots a supported backup before its first await.
Shared backup validation retains all 21 tables, literal Unicode, original images,
cross-record links and integer money. One local business, outlet and active owner
are required; pending unclaimed Inbox items must be claimed first.

The full JSON snapshot retains the existing 50 MB backup limit. Independent gzip
chunks contain at most 256 KiB of raw UTF-8, with a 384 KiB compressed bound. This
compresses repeated record metadata without changing any original image bytes.
Chunk boundaries may split UTF-8 characters; decoding happens after raw reassembly.

The immutable version-1 manifest contains only scope IDs, capture time, every table's
count, image count/size, chunk sizes/hashes and complete source/review hashes. Customer
names, messages and filenames remain inside the compressed source. Keeping free-form
strings out of the manifest also avoids PostgreSQL JSONB's NUL/surrogate restrictions.
The canonical manifest hash binds its ID, scope and every reviewed part.

Receiver verification checks each compressed chunk, bounds its expanded output,
checks the full snapshot hash, runs shared backup/link/image validation and compares
the decoded scope/counts/review hash. Validating a hash alone never authorizes a write.
The existing `prepareCloudMigration` codec remains the next step for producing the
fixed, literal-safe SQL record representation under a verified Auth UUID.

## Durable client journal

`apps/web/src/data/cloud-upload.ts` stores manifests, compressed Blobs and progress
in a separate `mise-cloud-uploads` IndexedDB database. It stores no JWTs, refresh
tokens, API keys or PIN material. The shop database remains schema 10 with its same
21 tables; JSON backups contain shop data and remain portable.

An existing upload ID cannot be overwritten. Integrity and receipt bindings are
checked when loading progress. Accepted receipts cannot be replaced with an older
uncommitted state. Quota failures leave the shop available and create no partial
journal record. Upload preparation, sending and completion never replace local data
or enable sync.

## Transport contract

`CloudUploadRemote` supplies three authenticated operations. The HTTP/hosted adapter
is still to be implemented; the current test receiver is explicitly in memory.

| Operation | Contract |
| --- | --- |
| `begin(manifest, hash)` | Derive caller identity from verified Auth, bind an immutable upload ID/hash, and return authoritative received indexes or its original receipt. |
| `put(id, index, Blob)` | Check ownership, expiry, declared size and SHA-256; accept an identical retry without duplicating it; return the current progress. |
| `finish(id, hash)` | Require all parts, validate the full source, enforce new-business ownership/no overwrite, promote records atomically with an audit, deliver/verify original files, and retain one durable acceptance receipt. |

Progress has exactly `id`, `manifestHash`, `received` and `receipt`. Indexes must be
unique and in range. A successful part reply must acknowledge that part and retain
earlier acknowledged parts. Receipts bind the upload, business, outlet, exact source
hash, record/image counts and server acceptance time.

Every resume starts with authoritative server progress. An acknowledged chunk is
not resent even when its previous reply was lost. A lost final reply recovers the
same historical receipt, rather than promoting again. Cancellation preserves progress;
if it races an accepted final reply, that receipt is still saved. Transport failures
stop the run and preserve the original snapshot for retry with its same ID.

## Before exposing Turn on sync

The runner requires a final gate, and the database adapter checks that current local
data still matches the reviewed content. A new export time or row iteration order
does not invalidate a review; an actual record/image change does.

That check cannot cover edits racing a network commit. Before enabling product
controls, integrate an atomic local snapshot/outbox watermark and keep every later
intent queued for M31. Do not hold local writes behind a network request, overwrite
the working copy, or mark the shop synced solely because this snapshot was accepted.
Committed snapshot receipts remain historical evidence when the local shop changes.

The hosted implementation must derive identity from a signed caller token, check
live confirmed-phone access, scope all private staging rows, reject another actor's
ID and existing business collisions, and keep raw table writes closed. Wire manifests
and errors must contain no credentials; actual deployment URLs and keys stay outside
the public repository. Original-file promotion and failure recovery need hosted
Storage verification before the acceptance gate is complete.

## Verification boundaries

The new unit/database checks cover literal data/image round trips, a 5,000-record
snapshot, interrupted replies, duplicate recovery, malformed/changed manifests and
ACKs, bounded decompression, stale reviews, final-gate failures, cancellation races,
quota failure, journal reopening and immutable receipts.

Two native Chromium tests bundle a test-only harness in memory and intercept its
HTTP page. They verify real CompressionStream/Blob/IndexedDB behavior, full page
reload durability and resumed chunk transfer with 5,000 records and an original image.
The harness is not a product route or deployed asset. Its receiver is a test fixture;
these checks do not prove phone OTP, real owner JWTs, hosted promotion or 3G timing.
