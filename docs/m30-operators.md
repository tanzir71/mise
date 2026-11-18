# Explicit outlet and operator selection

M30/M31 remain incomplete. This increment removes first-member attribution from
the local app and prepares fresh, phone-authenticated outlet discovery. Full
cloud controls remain disabled. The verification record is
[m30-operators-local.json](m30-operators-local.json).

The app keeps the selected business, outlet and member in the internal
`operatorState` table. Local schema 13 adds this table without replacing the
existing upload receipt, queue, original download pages, images or shop records.
Portable backups remain schema 10 with exactly 21 tables. An unchanged, single
owner/single outlet installation continues working without a selection prompt.
Shared or restored data requires an explicit choice; sorting member IDs can no
longer decide who records the next sale.

Owners have implicit access to their business's outlets. Managers see their
actual outlet assignments. Selection never fills in an owner's `outletIds`,
promotes staff, creates a member or invents a phone number. The legacy property
`setup.owner` now carries the selected operator, including a manager. Money,
orders, Inbox worker captures, exports and audits use that identity. Owner-only
profile/market editing is enforced in the domain command and the interface.
A manager's personal phone is not used as a shop-link contact by default.

Every selection has a monotonically increasing revision. Stale choices from
another tab fail for review, and changing the identity remounts pending forms.
Transactions that read business/outlet/member identity include the operator
store before Dexie validates nested scopes, so the selection and the action
share the same native transaction. This also applies to the share worker and
narrow transactions. Revoked assignments, inactive members and changed roles
stop the next command rather than falling back to a cached owner.

Backups preserve all six member roles, optional contact phones, inactive
historical actors and multiple businesses/outlets. Reference validation checks
the business and outlet for every relationship. Restoring shared data returns
to selection; it does not choose the first imported member. Ambiguous recovery
still offers a real JSON download without inventing an owner's preparation
audit. Explicit restoration remains subject to the existing active-upload guard.

Migration `20261118184142_operator_contexts.sql` adds two authenticated,
security-invoker public RPC wrappers. Their private helpers require a current,
confirmed, non-anonymous phone account and live owner/assigned-manager membership.
Discovery returns bounded display labels, actual scope IDs, role, epoch and scope
version. Its account fingerprint hashes PostgreSQL's 16 UUID bytes; the Auth UUID,
phone, project details and credentials are absent. Selection rechecks the chosen
actor and outlet after discovery. Keyset pagination is bounded to 50 choices.
Oversized display labels become null in this metadata view; canonical data is
unchanged. Literal JSON labels, including NUL and lone surrogates, stay intact.

The runtime transport pins requests to the entered connection, sends the original
JWT without cookies or redirects, limits responses to 1 MiB and exposes fixed
errors. Auth, network, stream and provider diagnostics are not shown to the UI.
Connection values remain separate from internal operator state and backups.

Cloud selection stores only account/connection fingerprints and a session-storage
key fingerprint. Explicit sign-out, account changes and cross-tab credential
removal persist a lock. Reload checks saved-session continuity before opening an
active cloud selection. Offline verification failures do not discard a still
bound local identity. These checks can only lock a choice; cached session bytes
never grant fresh membership or unlock it. A local choice cannot bypass a cloud
lock. Every server command/read still performs its own live authorization.

An existing, matching, accepted upload fence can activate the freshly reviewed
operator. A new device or unmatched scope stays pending. This is deliberately
not a fabricated ready receipt: a legitimate join boundary, canonical application
and pending-intent reconciliation remain required for both owners and managers.
The metadata transport and cloud-selection helpers are groundwork, not a new
enabled cloud interface. Real OTP, genuine owner HTTP acceptance and the 3G upload
timing gate are still unproven.

The API hostname now resolves. Live requests using only the private configured
publishable key returned 401 for member/outlet table reads and the command/read
services without a user JWT. Auth settings still disable email, anonymous users,
phone-provider activation and signups; phone auto-confirm is off. These are
negative-access checks, not positive owner authentication or an OTP trial.

The local PostgreSQL suite covers real HTTP-to-RPC requests, role/assignment
revocation, account hashing, privacy, pagination, literal labels and diagnostics.
An identical SQL-role proof also rolls back every fictional account and shop;
it must not be represented as genuine hosted JWT authentication. Native browser
checks cover real cash/backup attribution, cross-tab form replacement, SDK
sign-out, credential removal, recovery and accessibility at 360, 390, 768, 1024
and 1440 pixels. Schema-12 upgrade checks preserve original images, receipts,
queued cash and complete staged downloads.

M30 names no picker frame. The existing onboarding/card primitives and supplied
M38 all-outlets export guide the hierarchy. The visual report treats pixel
differences as informational and does not claim an exact match to an unprovided
screen. GitHub Actions and Pages publication remain stopped by the owner; local
verification is recorded without claiming a CI artifact or a new Pages deploy.

Verified totals: **2,059 unit tests across 109 files**, **382 browser checks**,
**25 root-path browser checks** and **50 visual comparisons**, with zero retries,
failures, flaky checks, skips or horizontal overflow. Lint and typecheck pass;
both build bases pass their generated-output credential guard. The 360, 768 and
1440 picker captures were inspected in the local report. The test installer now
waits for service-worker control and routes worker-owned script requests through
the browser context, retaining the production PWA and CSP during verification.
The supplied 270 exports remain present. These are local results; CI and Pages
remain held.
