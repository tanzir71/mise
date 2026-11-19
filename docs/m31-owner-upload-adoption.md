# Original owner uploads in the canonical sync engine

The internal sync engine now supports the device that originally uploaded a shop,
as well as devices that joined it later. An owner can retain pending offline cash
and stock while accepting a complete canonical bootstrap. The original upload
fence, receipt, compressed snapshot, IDs, physical times and queue remain intact.
Full cloud controls stay disabled; M30/M31 are not complete. Verification is in
[m31-owner-upload-local.json](m31-owner-upload-local.json).

An accepted receipt proves that a promotion happened. Applying a download also
requires proof that the promotion is visible in that exact snapshot. The new
migration stamps the top-level transaction identity only when an upload actually
becomes committed. It makes the accepted promotion row immutable and adds a
read-only, owner-scoped coverage RPC. Historical receipts without that identity
remain unknown; the migration never backfills invented proof. PostgreSQL's
transaction and snapshot functions preserve full 64-bit identities and distinguish
visible from later transactions. [PostgreSQL documentation](https://www.postgresql.org/docs/17/functions-info.html).

The RPC requires the original uploader's live phone account, current owner role,
business, outlet and completed bootstrap window. It rechecks expiry, epoch and
scope, including on repeated reads. Assigned managers can download their own
outlet but cannot adopt an owner's upload. Private table reads remain closed;
the public entry point is an invoker wrapper with no anonymous or service-role
execution grant. No Auth UUID, lease, token, transaction identity, deployment
setting or new authority is returned. A non-waiting upload-row lock avoids reversing
the legacy upload path's lock order.

The existing JWT-protected sync-read service signs coverage with the same cursor
codec as the completed download. The runtime transport pins the original account
and connection before requesting the fact and again after reading the bounded
response. The complete manifest, receipt, scope and signed cursor must agree.
Unknown, later, substituted or revoked proof retains the local source and prior
cursor. Server errors use fixed messages without private response details.

Local schema 18 adds internal `syncAdmissions` as the thirty-second store. An
owner admission keeps verified original compressed chunks and their manifest,
real receipt, fixed-window proof and initial canonical base. Full chunk and
snapshot hashes are checked again when reading it. Portable backups remain schema
10 with 21 tables; connection values and sessions stay outside them. Joining a
device still uses its distinct version-2 join admission. Adopting an owner upload
keeps its original version-1 fence and receipt, and creates no join or replacement
upload receipt.

The same application engine proves the working copy from the original upload and
queued local transactions, reconstructs the canonical model and re-evaluates
pending money/stock intents. It commits domain rows, original source admission,
application journal, current base and accepted cursor together. The finite native
write plan now checks every store, including control rows, complete Blob bytes and
staging evidence. Unexpected metadata writes abort the transaction as well as
unexpected domain writes. Original queued changes and receipts are never rewritten.

The owner regression exposed a lost Dexie transaction context during the admission
check. Writes could otherwise open independent transactions and create outbox
echoes before a final check rejected the operation. The check now returns Dexie
promises, and source reads return their actual transaction promise. A native
transaction guard refuses every domain write after context loss or transaction
closure. Local hashing is explicitly kept inside the native transaction where
needed. Tests prove that a deliberately expired writer changes no domain row,
queue, fence, source or cursor. The failing reports are retained in the redacted
verification record.

Exact adoption retry preserves cash saved after a lost local reply, including
after offline reload. Subsequent downloads use the current canonical base while
the original admission stays immutable. Retrying the original upload after
rebasing only fetches its actual receipt; it neither reconstructs the working
copy from old row changes nor resends chunks or promotes the shop again.
Quota failure rolls back the complete native application and retains staged pages
and images. A damaged source cannot unlock from cached metadata; a JSON backup of
the working shop remains available. Concurrent cash, fresh revocation and
unexplained changes remain review work with their original evidence intact.

Native browser coverage includes an original uploaded owner and a joined manager
editing offline, delivering their original cash/stock intents and converging
without duplicates or echoes. It also covers lost adoption replies, offline
reload, native quota rollback and owner revocation after a real visible proof.
The service uses all committed migrations, real SQL roles, original promotion
tickets/receipts and actual TCP HTTP. Its account verifier and object adapter are
explicitly synthetic. This does not claim genuine hosted phone JWTs, SMS delivery
or positive hosted Storage acceptance.

The hosted change adds promotion visibility and the existing read-service route.
Migration 36 is applied, and sync-read version 4 is active with JWT verification.
The deployed source matches the reviewed bundle; the other six functions are
unchanged. Twelve role checks pass both locally and in an exact rollback-only
hosted proof. Its own uncommitted promotion correctly reports later; this is not
a positive hosted owner-HTTP test. No synthetic Auth/shop/upload rows remain.
All 58 application tables enforce RLS, with no anonymous table grants, public
security-definer helpers or public buckets. Security and performance advisors
each report no warnings or errors.
No Auth provider, server secret, bucket visibility or anonymous table grant is
changed. Actual deployment values remain private. Actions remain disabled at the
owner's request, so there is no CI artifact or new Pages publication.

Remaining work includes live-account-pinned command delivery, other unconfirmed
command-family merges and explicit conflict recovery, changed-scope bootstrap,
reconnect/realtime orchestration and the header sync state. Genuine phone OTP,
positive hosted owner/image HTTP, the 5,000-record 3G gate and all subsequent
handover milestones remain required.
