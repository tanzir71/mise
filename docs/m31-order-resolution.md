# M31 — Deliberate order financial resolution

An offline payment can retain an earlier price after another device changes the
order. Retrying that payment must neither alter its original intent nor create
another sale after a lost response. The order review protocol now reads the
actual accepted outcome first, then prepares a bounded review of the current
order, credit balance and limit through the original verified phone account.

A review binds the original normalized command, complete local source hash,
selected operator/outlet, proposed new command identity and current database
context. Its private token expires after 15 minutes. A changed context requires
another deliberate review; completion never silently refreshes the decision.
The same original account is checked across HTTP and native receipt acceptance.
Provider response bodies and runtime credentials are not written to shop data.

There are two explicit outcomes. Withdrawal performs no financial action and
retains a distinct resolution receipt and advances the order revision. An indexed
audit fence separately requires explicit financial completion even when a later
offline action happens to match that revision. Nonfinancial notes and merely
preparing a review cannot clear the fence. Replacement creates a new primary command with
the reviewed revision, preserving every original linked financial/source ID,
input and physical occurrence time. The existing domain calculation and complete
SQL writer apply it in the same transaction as the original action's resolution.
Undo expiry, source-sale checks and current credit consent remain enforced.
An expired undo can be withdrawn without changing the actual paid money.

The actual resolution audit uses the original action identity with command
`sync.resolve`; it contains the distinct resolution identity and exact receipt.
The original intent remains archived as literal JSON text, preserving NUL and
unpaired-surrogate sources. The bounded review capsule contains original money
facts rather than duplicating photographs and large before/after audits; the
complete original source and bytes stay in the local outbox. Private records keep
the original source hash and capsule. No queued original command is rewritten.

Receipt coverage proves the original command was finalized. Before removing its
tentative projection, the client also compares the saved resolution with the
actual canonical audit. A substituted local source, hash or outcome fails closed.
A response lost after SQL commit is recovered through the original outcome,
without repeating money, rotating the selected review or discarding evidence.

Migration 39 adds two private forced-RLS tables and scoped review RPCs; only the
service role can finish the transaction. Public wrappers use invoker privileges
and empty search paths. Ordinary authenticated and anonymous roles cannot read
the archive or invoke privileged completion. The existing commands function
serves review requests without adding another hosted service.

Migration 40 preserves that fence across intervening nonfinancial changes. Only
the guarded review transaction can stamp its short-lived private completion
capability after checking the selected token, current context and exact
replacement. A later actual financial resolution clears the fence. Two SQL/HTTP
regressions cover the original wrong-price acceptance, an intervening note,
review preparation without approval, and the deliberate correct-price outcome.

Hosted verification confirms all 60 application tables enforce RLS, no ordinary
role has direct archive grants, and no public review function uses definer
privileges. The deployed commands source matches the reviewed bundle exactly and
retains JWT verification. Security advisors report no warnings or errors; the
private deny-by-default tables intentionally have no row policies.

Local SQL/HTTP tests cover current-price replacement, withdrawal, late original
completion, expired undo, credit consent, foreign business/outlet/staff/agent
access, revoked membership, changed sources, expired tokens, tampered plans and
transaction rollback. Native two-browser checks make offline conflicting edits,
lose the actual SQL completion response, reload offline, retry the exact
decision, and converge all domain records and images with later counter cash.
These fixtures use explicit synthetic Auth; genuine hosted OTP acceptance is
still required. Validation is recorded in [the local record](m31-order-resolution-local.json).

The operator interface and other financial command families are unfinished.
Cloud flags remain off, M30/M31 remain unchecked, and all GitHub workflows and
Pages publication remain held. Actual deployment details and credential values
stay outside Git and static build variables.
