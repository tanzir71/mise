# M31 — Original rejected-action reviews

An offline payment can meet a different price when another device reconnects
first. The command transport previously returned a generic review error and the
sync session stopped without retaining which exact action received that response.

Schema 22 adds an internal `syncActionReviews` store. A verified command response
with HTTP 400, 409, 413 or 415 records the original command and queue identities,
the complete source hash, the genuine accepted receipt prefix, and the original
operator, outlet, admission and hashed account/connection binding. The local
observation times are device times, never server admission times. Provider error
bodies remain unread and are not saved.

The transport rechecks the original live account after rejected response headers.
An ephemeral proof binds the exact serialized request and refuses account or
generation changes. A local error or a serialized copy cannot create that proof.
The native writer checks it again before and after its write, checks the complete
original queue entry and refuses an expired transaction before independent DML.
Quota failure, a changed operator or a changed source retains the original shop,
queue and financial action without creating a receipt.
The retained-source fallback runs before requiring Web Crypto, so an unsupported
image capture still blocks later delivery safely on devices without that API.

Repeated responses preserve the first observation, count retries and retain the
original source. Concurrent tabs update that same observation transactionally.
A genuine later receipt confirms it in the same transaction as the existing
outbox acknowledgement; the observation is retained. An account change inside
either native write rolls both changes back. Reads validate the original active
operator, complete source, exact command, receipt prefix and any confirmation.
They remain available offline. Portable backups retain their existing schema 10
and 21-table allowlist; review metadata does not enter the portable shop model.

The native browser regression uses two actual IndexedDB stores and the shared
SQL-backed HTTP handlers. Both devices edit offline: one changes a price while
the other records the original cash payment and later counter cash. After the
price wins admission, the original payment receives a real HTTP conflict. The
manager retains its complete original payment, later cash, images and source
through offline reload and an exact retry. No server sale or substitute receipt
is manufactured. Auth is the explicit local synthetic verifier; this does not
establish genuine hosted OTP or provider acceptance.

This observation is not proof that a financial action never committed. It does
not authorize a replacement, deletion, changed revision or automatic rebase.
The subsequent [order resolution protocol](m31-order-resolution.md) adds current-value
review and server-authorized outcomes for orders. Its interface and other financial
families remain unfinished. M30 and M31 remain unchecked, cloud flags default
off, and the owner's GitHub workflows and Pages publication remain held.

Local validation is recorded in [the verification record](m31-action-reviews-local.json).
