# M30 · Durable scoped download

The server captures changes to all twenty-one portable entities and the three
association/image-metadata tables in the same transaction as each source write.
Capture failure rolls back the source, and source rollback removes its feed rows.
Legacy rows receive an initial backfill. Deletes and privileged truncation retain
tombstones. New outlets receive the existing global profiles they may need.

The feed stores only explicit projected columns. Auth UUIDs, storage paths,
server-only settings and credentials stay outside those projections. PostgreSQL
reads identifiers from typed row columns and serializes literal JSON without
reparsing the full document. This preserves NUL and lone UTF-16 surrogates that
existing local records can contain.

A read requires a currently active, phone-confirmed owner or an assigned manager.
It selects one outlet, including its linked customers and visible members.
Private feed, scope-version, read-window and page tables force RLS and have no
direct client or service grants. Public wrappers grant only the three guarded
authenticated read operations; shared devices, staff, agents and anonymous callers
cannot use this owner/manager interface.

Each window fixes its previous and next PostgreSQL snapshots. Page ordinals order
that window; transaction visibility determines which commits it contains. A
transaction that commits late remains eligible in the next window even when its
allocated ordinal is lower than one already downloaded. The
[snapshot groundwork](m30-sync-snapshot.md) explains the cursor primitive.

Pages contain at most 196,608 raw payload bytes and 256 fragments. Large individual
rows span pages at byte offsets, including across UTF-8 boundaries. Every original
row has a complete SHA-256 hash; decoding checks the assembled hash and projection
before returning data. No oversized row is silently omitted. Responses use a
bounded gzip envelope with an exact byte count and SHA-256, and decompression
stops when the declared budget is exceeded.

Read windows last twenty-four hours and allow ten pending windows per account.
Pages are cached in order for exact replay. Every replay still checks live account,
outlet, role, epoch, visibility version and expiry. Removing a member/customer
association invalidates affected windows, including cached pages. A newly visible
profile is captured with its new association so it arrives in a subsequent window.
Expired or changed windows restart from the last accepted cursor.

The `sync-read` HTTP function admits the outlet before obtaining a request body
reader. It binds the parsed body to that outlet, rejects other origins and keeps
provider diagnostics private. A dedicated server-only HMAC key protects stateless
cursor integrity. Cursor scope and signatures are rechecked independently of the
fresh database access check. Signing keys are neither sent to the browser nor used
as public build variables. The local credential guard also compares that key's
actual value from ignored private configuration.

The runtime browser transport freezes requests before refreshing Auth, pins the
configured HTTPS origin, refuses redirects/cookies, verifies compressed responses,
and preserves original window/page identities through retries and reload. It does
not mutate shop records, outbox receipts or accepted cursors. There is no sync UI
activation in this increment.

The local SQL/HTTP tests include owner/manager scope isolation, literal and large
records, stable pagination, lost replies, HMAC tampering, live revocation, epoch
changes, pending-window bounds, rollback, legacy backfill and a complete
5,000-record functional download. This download is not the M30 real-owner upload
benchmark under 3G throttle. Verification and hosted limitations are recorded in
[the redacted evidence](m30-sync-feed-local.json).

Hosted SQL-role verification used temporary synthetic records and two independent
connections. A held write allocated its change ordinal first; another write
committed and a read window was fixed while the first transaction was still open.
That window included only the committed write. The next window included the late
commit with its lower ordinal and did not repeat the covered write. Full hashes,
cached replay, assigned-manager access and revocation passed. Guarded cleanup
removed every fixture account, business, feed row and read window.

Migration 31 and the JWT-verified `sync-read` function are deployed. Publishing the
dedicated server key advanced existing function versions; their bundle hashes and
JWT settings are unchanged. All 56 application tables force RLS; private feed
tables grant no direct authenticated or service access. Advisors report no
warnings/errors and 27 intentional private-table policy notices. The API hostname
did not resolve from this machine during this run, so hosted HTTP admission is
not counted as passed. Real OTP and a genuine signed-owner request remain open.

Canonical application, the immutable remote coverage journal, explicit active
operator/outlet selection, pending-intent reconciliation, image-byte delivery and
the complete upload/outbox controls remain unfinished. Received data must be
staged completely before atomic application; a returned download cursor alone
does not prove convergence. M30 and M31 remain unticked, and `cloudSetup` remains
off. GitHub workflows and Pages publication remain stopped by the owner.
