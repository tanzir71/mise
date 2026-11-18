# Verified original image downloads

M30/M31 remain incomplete. This increment stages the original private image bytes
beside a complete, sealed download. It does not apply shop records, accept a
download cursor, invent a joined-device receipt or enable the cloud interface.
The verification record is [m30-sync-images-local.json](m30-sync-images-local.json).

The runtime client uses the existing authenticated `inbox-image` service. It pins
the original connection and account fingerprints, sends the original user JWT
without cookies or redirects, and checks the same account again after reading
and hashing the body. The whole request, including Auth lookup and body reading,
has a 120-second maximum and supports cancellation. Only fixed errors leave this
boundary; provider diagnostics, project details and credential values do not.

Every image must match the sealed record's MIME type, actual decoded byte count,
signature and full SHA-256. A matching header or declared Content-Length cannot
replace full-byte verification. Limits remain 5 MiB per image, four images and
10 MiB per original Inbox item. Bootstrap downloads also require the original
parent and contiguous image positions. Incremental downloads can legitimately
contain only an image change without repeating its unchanged parent.

Schema 14 adds internal `syncImages`, keyed by download and image identity. Each
immutable row holds the original Blob and the fingerprints of its exact scoped
metadata source. Filenames and literal source fields remain in the original
record journal, including Bangla, NUL and lone-surrogate values. Connection
settings, Auth UUIDs, JWTs, keys, signed URLs and Storage paths are excluded.
Portable backups remain schema 10 with 21 tables. The new 28-store schema
preserves original upload receipts, selected operators, queued actions and
download pages through the schema-13 upgrade.

The client reconstructs the full metadata seal before planning images. Native
transactions recheck the binding, read state and original record before saving
bytes. Hashing, Blob reads and network waits stay outside those transactions.
A lost response retries only missing images. Two tabs retain one immutable row
per source. Storage failure retains the original download for retry. Corrupt
cached bytes are retained for recovery and fail verification instead of being
silently replaced. The offline reader checks the complete original bytes again;
a cache entry never grants current membership or unlocks an operator.

Migration `20261118204041_image_account_guard.sql` adds the existing verified,
non-anonymous phone-account check to image context and completion, after the
existing membership-first locks. The service already checks access before and
after reading Storage. No table, bucket policy, Edge Function, secret or Auth
provider is added or changed by this migration.

Verification covers the runtime transport, native IndexedDB retries and offline
reload, concurrent tabs, retained corruption, quota rollback and a real
schema-13 upgrade with original images, selected operator, accepted upload
receipt, queued cash and staged pages. A local HTTP server exercises the actual
client, image handler and PostgreSQL role checks together. The exact hosted
SQL-role proof checks owner/assigned-manager access and denies foreign,
unassigned, staff, revoked, anonymous, unconfirmed, banned and deleted accounts;
all synthetic rows roll back. These proofs do not represent genuine phone/JWT
authentication, native hosted Storage delivery or the 3G performance gate.

The first two-worker browser run passed 386 of 388 checks, including all six new
image cases. Two existing operator checks timed out during a service-worker wait
and restore navigation. All 11 operator checks passed in an isolated one-worker
diagnostic run. The final complete browser and portable-base checks use one
worker, without changing assertions or production code. Both the original
failures and final results are retained in the evidence; no production fix for
those unreproduced timeouts is claimed.

GitHub Actions and Pages publication remain held by the owner. Local checks and
the security audit are recorded without claiming a CI artifact or a new Pages
deployment. No product interface changes in this increment. Legitimate
new-device join, canonical application, intent reconciliation and full offline
convergence remain required before cloud controls can be enabled.

Verified totals: **2,108 unit tests across 111 files**, **388 final browser
checks**, **31 root-path browser checks**, **50 visual comparisons** with no
horizontal overflow, and **16 identical local/hosted SQL-role checks**. Lint and
typecheck pass; both build bases pass their generated-output credential guard.
All 270 supplied exports remain present. Hosted state has 33 migrations, 56
forced-RLS application tables, one private bucket, zero Auth users and no security
advisor warnings or errors. All seven Edge Function versions remain unchanged;
no provider, secret, OTP or publication is commissioned.
