# M30 · Complete manual message transactions

The subsequent [local manual-message queue](m30-handoff-outbox.md) attaches these
commands to the original local preparation, choices and complete Sent transactions.
Its notes record the newer regression pass; canonical reconciliation and full
upload/sync controls remain unfinished.

The shared local and server mutation records manual message preparation,
Open/Copy/failure, explicit Sent and correction. No endpoint opens another app,
contacts a recipient or sends a message. Opening or copying does not confirm
delivery. Copy failure preserves any earlier confirmation; Undo Sent removes
only that confirmation and retains the communication history.

All seven existing source kinds are supported: khata, customer, order, supplier,
sale, day closing and shop. Original confirmed active owners and assigned managers
can access only scoped source rows; customers require an association with that
outlet. Original message text, template, destination, part and every device
attempt/action ID survive retries. New attempts receive a canonical topic
generation under the outlet lock. M31 still needs accepted-row reconciliation
when two offline devices chose the same provisional generation.

Explicit Sent joins the complete source transaction: a zero-amount khata
communication with its next ledger sequence, a reviewed order revision and
communication, or a supplier message with its selected stock IDs. Every companion
record/audit retains its planned ID. A stale order review stops the entire save.
Repeated supplier confirmation reuses an identical active original message,
including reordered selections; its original ordering remains unchanged. Neither
confirmation nor supplier correction changes customer debt, sales or stock.
The separate supplier-message correction voids its original record once within
twenty-four hours. Later records remain untouched.

The complete hand-off history requires `event.at` to equal the session's
monotonic device/history clock. That invariant is retained; the original command
occurrence and server admission time are separately recorded in the immutable
receipt. SQL reconstructs the exact next progress/session snapshot independently,
checks the real live ten-minute Undo Sent deadline and retains literal predecessors.
Backdated commands or a forged preparation clock cannot extend either undo window.

The hand-off draft parser already rejects NUL, lone surrogates and unsupported
control characters. Only those validated hand-off snapshots use JSONB. Business,
customer, order, supplier and companion/audit JSON can contain NUL or lone
surrogates and remains literal JSON throughout. Supplier names are escaped inside
the private JSON-safe plan. The shared SQL-row decoder now preserves required
audit JSON nulls while leaving optional absent fields absent; this allows complete
attempt roots and deletion snapshots to reconstruct correctly.

Preparations support the full 12,000-character text and optional 12,000-character
template, without shortening either. `X-Mise-Handoff-Write` proves original-caller
outlet access before the 256,000-byte/twenty-second body reader. Preparation RPCs
allow fifteen seconds and the client 120 seconds. Confirmed choices retain the
ordinary 32,000-byte/five-second body and 45-second client boundary; all 1,000
selected stock IDs fit. Admission headers are mutually exclusive. Text, template,
choices, completion, selections and IDs freeze before asynchronous Auth.

Private forced-RLS tickets hold only opaque proof hashes, immutable plans and
source hashes, with sixty-second expiry and a hundred-live-ticket cap. Complete
duplicate requests are discarded after hashing. Public wrappers are invokers.
Only service completion writes exact hand-off/communication codec columns after
live identity/assignment, proof, scope, snapshot and revision checks under
business-then-outlet locks. New IDs are insert-only; another outlet's ID race
cannot overwrite data. Main and companion audits, source mutations and the
original-actor replay receipt commit together. Failure rolls everything back.
Only a fixed source-race tag permits up to three preparations. Database messages
and details never appear in client errors.

Native verification includes every choice/source, all eight live revocations,
physical/history and admission clocks, live undo enforcement, 1,000 stock IDs,
full maximum text/template, literal names, quotas, proofs, replay, foreign-ID
races, complete rollback and payload tampering. The exact deployment module
checks original-JWT admission/preparation and service-only compound completion.
The twenty-three-action SQL-role fixture covers every source, communication
companions, supplier resend/correction, historical replay and a second generation;
it rolls back all fictional Auth/business/ticket rows.

All twenty-four migrations and `commands` v11 are deployed with JWT verification
enabled. The deployed module matches the validated bundle and its forty-nine
source hashes. The hosted twenty-three-action fixture passes with thirty-two
audits, one zero-debt communication, one order communication and two supplier
messages. All fictional Auth, business and ticket rows roll back. Fifteen actual
HTTP/CORS checks pass. All forty-six application tables force RLS, with no
anonymous table grants, direct client writes or public security-definer functions.
Security and performance advisors report no warnings or errors.

Final local verification passes all 1,490 unit tests across 84 files, lint and
strict typechecking, both production base paths (`/` and `/mise/`), and all 298
browser checks with two workers, no retries, skips, failures or global errors.
Changed source, staged files, reachable history and built output are scanned
against nine private deployment values without exposing them in the report.

Clone-local credential checks now run automatically against private key/pepper
values and plain project/organization references before commit, push and build.
Their values and operational paths stay outside tracked files; unavailable
configured input blocks the scan. Sixteen guard checks include staged secrets,
historical leaks, private configuration, redaction and actual rejected commits/pushes.
See [security details](security.md) and [redacted hosted evidence](m30-handoff-hosted.json).

Phone OTP, positive signed-owner HTTP, app/outbox integration, Inbox and remaining
staff/agent resources, and M31 convergence remain open. No new layout or visual
comparison is claimed. Cloud controls, GitHub workflows and Pages publication
remain held. Actual project/organization details, credentials and private
operational paths stay out of public evidence.
