# Original accounts during command delivery

Both command transports now require the original connection/account fingerprints
and a live phone-session adapter. A JWT alone cannot construct either transport.
The adapter verifies the original account before sending and after reading the
bounded receipt. A changed account, connection, shop scope or session generation
keeps the saved action unconfirmed, including an account change away and back.
M30/M31 remain incomplete; full cloud controls stay off. Verification is recorded
in [m31-command-account-local.json](m31-command-account-local.json).

`PhoneAuth.commandAuthorization()` obtains a session token, freshly verifies the
confirmed, non-anonymous phone user with Auth, and rechecks the session afterward.
It does not treat cached session metadata as server verification. This follows
the distinction between [getSession](https://supabase.com/docs/reference/javascript/auth-getsession)
and [getUser](https://supabase.com/docs/reference/javascript/auth-getuser).
The account generation changes on identity/phase changes and immediately on
relevant storage notifications. A synchronous check also compares the current
scoped session immediately before sending and before accepting the local receipt.
Neither these client checks nor local operator metadata grant server authority;
the existing live SQL role/scope checks still authorize every command.

The request deadline includes Auth, account hashing, fetch, streaming response
reading and final Auth verification. Existing per-family body limits, scope
headers and 45/60/120-second deadlines are preserved. Receipts are limited to
2 MiB and strict UTF-8 JSON. Cancellation releases the caller even if an Auth or
fetch callback ignores its signal; error messages contain no backend response,
connection or session values. Requests exclude cookies, redirects and caching.
The original reviewed command is serialized before the first Auth wait.

A network receipt carries an in-memory continuity check in a WeakMap. It adds no
field to the receipt, queue, backup or command, and cannot put an Auth token or
UUID into the shop database. The outbox checks the original receipt object again
immediately before its native write. This closes the interval after the final
Auth response when a storage event can invalidate the session while a locked
operator-store transaction is still preventing the revocation writer from running.
Pure local domain fixtures continue to supply their own validated receipts.

Delivery captures the original upload/join binding and operator selection. Every
receipt transaction locks the operator, binding and queue stores together and
rechecks their identity and revision. It verifies the complete original queue
entry, including original image bytes, rather than only its command list. New
local cash can advance the queue sequence without changing an earlier action's
receipt. Changed source, operator, account, quota or transaction closure retains
the pending original. A native guard refuses to open an independent writer after
its receipt transaction has expired. A receipt that the server committed before
the interruption is fetched by retrying the same original command ID.

Native browser regressions run the actual Supabase client and PhoneAuth code
against the local HTTP/SQL convergence fixture. They switch accounts after real
SQL commit, lock the operator while a response is held, and change the scoped
session from inside the locked native receipt transaction. Each leaves the local
receipt pending and preserves shop data, then accepts the original receipt on a
fresh original-account retry without duplicate cash. The prior uploaded-owner
and joined-manager offline convergence tests use this same runtime adapter.
The account verifier and Storage adapter are explicitly synthetic. No real SMS,
hosted phone JWT, positive hosted Storage acceptance or production Auth change
is claimed.

Local schema 18/32 stores and portable backup schema 10/21 tables are unchanged.
No hosted migration, function, key, provider or bucket setting changes in this
increment. Actual Supabase deployment values stay private, and credential checks
cover source, index, reachable history and generated output. All three workflows
remain disabled under the owner's instruction; no CI artifact or new Pages
publication is claimed.

Remaining work includes other unconfirmed command-family merges and explicit
conflict recovery, changed-scope bootstrap, backoff/realtime orchestration, header
sync state, genuine phone OTP and hosted owner/image HTTP, the 5,000-record 3G
gate, remaining M30/M31 requirements and every subsequent handover milestone.
