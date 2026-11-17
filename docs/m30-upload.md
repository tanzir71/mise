# M30 · Reviewed upload and recovery

Status: **snapshot/journal, authenticated staging/promotion service and HTTP
transport implemented**. Two new migrations and the upload function are deployed.
Real signed-owner-JWT/phone-OTP verification, UI/outbox integration and the real
5,000-record / 3G / 60-second acceptance gate remain open. M30 stays unticked.

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

`CloudUploadRemote` supplies three authenticated operations. The runtime-configured
`apps/web/src/data/cloud-upload-remote.ts` adapter sends the current caller JWT and
publishable key to `migration-upload`; it persists neither. Requests reject redirects
and have a two-minute timeout. Its additional status/cancel methods use the same
identity boundary. The adapter remains disconnected from product controls.

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

## Private staging and promotion

`20261117171100_initial_upload_staging.sql` adds two forced-RLS private tables with
no direct client access. Confirmed, live Auth identity comes from the original caller's
SQL context. A stage binds the caller, new business, immutable manifest and exact
digest. A caller can have one active stage; a business stays bound to its original
claimant across cancellation. Stages expire after seven days; an exact same-ID resume
can renew an expired stage without discarding its accepted parts. Cancellation cannot
erase an active promotion lease or an accepted receipt.

The Edge Function checks live identity before reading the bounded request body.
Original-JWT invoker RPCs own staging/part reads and writes. Finish acquires a
120-second opaque lease, validates the complete snapshot with shared backup and
migration code, then delivers original files through the private Storage adapter.
An existing immutable object is verified byte-for-byte by SHA-256 after a lost reply.
Auth is rechecked during delivery and again at final promotion.

`20261117171949_initial_upload_promotion.sql` permits only the server service role
to finish/release that exact lease. It allowlists the shared codec's 24 SQL tables
and columns, checks original owner/business/outlet scope, rejects an existing business,
and requires server-owned private Storage metadata for every original image. Record
insertion, deferred foreign-key checks, one original-actor audit, the durable receipt
and private-chunk removal commit together. An identical accepted retry returns its
historical receipt. A failed transaction leaves records unpromoted; failure recovery
can release only its own uncommitted lease. Raw client writes remain denied.

The deterministic Docker-free bundle in `scripts/edge-bundle.mjs` includes shared
TypeScript/JSON/npm code in one module and scans it before producing an ignored
deployment payload. Actual URLs/keys remain runtime server secrets, outside Git and
the public evidence. No new server secret or Auth-provider setting was introduced.

## Before exposing Turn on sync

The runner requires a final gate, and the database adapter checks that current local
data still matches the reviewed content. A new export time or row iteration order
does not invalidate a review; an actual record/image change does.

That check cannot cover edits racing a network commit. Before enabling product
controls, integrate an atomic local snapshot/outbox watermark and keep every later
intent queued for M31. Do not hold local writes behind a network request, overwrite
the working copy, or mark the shop synced solely because this snapshot was accepted.
Committed snapshot receipts remain historical evidence when the local shop changes.

Keep the signed-caller identity, live confirmed-phone checks, private-stage isolation
and no-overwrite rules when wiring the interface. Wire manifests and errors contain
no credentials. Actual deployment values stay outside the public repository. Hosted
Storage and SQL-role checks below do not replace a positive signed-owner HTTP test.
General cleanup of abandoned original objects is still needed; it must avoid racing
another reviewed upload that reuses the same immutable image path.

## Verification boundaries

The new unit/database checks cover literal data/image round trips, a 5,000-record
snapshot, interrupted replies, duplicate recovery, malformed/changed manifests and
ACKs, bounded decompression, stale reviews, final-gate failures, cancellation races,
quota failure, journal reopening and immutable receipts.

Two native Chromium tests bundle a test-only harness in memory and intercept its
HTTP page. They verify real CompressionStream/Blob/IndexedDB behavior, full page
reload durability and resumed chunk transfer with 5,000 records and an original image.
The harness is not a product route or deployed asset. Its receiver is a test fixture.

The server increment passes **47 native PostgreSQL/transport checks**, **16 handler
checks** and a bundled-Deno boot check. Native client → handler → adapter → SQL tests
cover complete promotion, 5,000 records, lost Storage/final replies, changed bytes,
mid-transfer identity revocation and atomic rollback. The full suite passes **1,013
tests across 67 files**, including the separate credential-prevention changes.

Lint and strict TypeScript/Astro checks pass. Both production base paths build and
pass the generated-output credential guard. All **298 browser checks pass without
retries in 4.0 minutes**; four landing/app/catalogue smoke checks pass again after
the final changelog rebuild. No new product layout or visual comparison is claimed.

Hosted PostgreSQL 17.12 role tests use two synthetic confirmed Auth rows inside a
rolled-back subtransaction. The original claimant stages and promotes 31 source
records with one exact 92-byte PNG verified in actual private Storage. A different
confirmed user and raw staging reads are denied. Literal Unicode survives, one audit
is emitted, private chunks are purged, and service/owner receipt retries agree.
All Auth/domain/staging rows roll back; the separately created synthetic Storage
object is deleted and confirmed absent. These SQL role tests do not issue a real
owner JWT or exercise a positive authenticated HTTP upload.

Seven live endpoint checks pass: missing/forged/anonymous JWT rejection, denial of
service-principal owner bootstrap, foreign-origin rejection, method rejection and
CORS preflight. All 13 migration versions and six active functions are confirmed.
Security/performance advisors have no WARN/ERROR findings. Phone OTP, a positive
signed-owner HTTP transfer and real throttled-3G timing remain unverified, including
the Edge runtime's CPU/memory limits for large backups. See
[the redacted server evidence](m30-upload-hosted.json).
