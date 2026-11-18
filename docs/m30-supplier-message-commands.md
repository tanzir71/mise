# M30 · Original supplier sent records

The legacy `recordSupplierMessage` save now queues a `supplier-message.record`
command in the same transaction as its original message and `supplier.sent`
audit. It preserves the device's record/audit IDs, physical occurrence, normalized
supplier name, literal text, contact method, selected stock IDs and multipart
position. It does not send a message, create a hand-off attempt, receive stock,
record an order or change money.

An exact normalized local retry returns the saved record without another audit or
queue entry. A changed or corrected record cannot be asserted again. A compound
record plus correction keeps both original intents in one ordered queue entry.
Native queue or audit failure rolls back the complete local transaction. Unknown
compound mutations retain their source for recovery and stop ordered delivery.
After a lost reply, saved receipt progress survives reload and delivery resumes
with the same command identity.

Hosted preparation requires a currently active, phone-confirmed owner or an
assigned manager. A private, forced-RLS ticket binds the full normalized intent,
actor, outlet, original time, source snapshot and SHA-256 request fingerprint.
Tickets expire after sixty seconds, with at most one hundred pending per caller.
Service completion rechecks live access and the snapshot, accepts only the exact
validated message and constructs the message, audit and receipt together in SQL.
Only the fixed source-change tag permits a retry, bounded to three preparations.
Receipt replay remains restricted to the original authenticated operator.

The message's creation time remains its original physical occurrence. Updated
metadata and the `supplier.sent` audit use admission time. The existing correction
command retains its twenty-four-hour rule. Accepting a receipt does not reconcile
canonical rows; that remains M31 work.

Names and message text remain inert literals, including NUL and lone UTF-16
surrogates supported by existing local records. SQL handles isolated JSON string
tokens and never deescapes the whole original document into `jsonb`. Saved and
manual suppliers are supported, including original records whose source stock or
supplier has since been archived.

Both command transports use the existing admitted manual-message request limit
of 256,000 bytes. Live outlet authorization runs before obtaining a large body
reader, and parsing binds its kind and outlet afterward. Requests cannot combine
admission headers. A valid request with all 1,000 original stock IDs crosses the
default 32,000-byte limit through both clients, the HTTP handler and actual SQL.

Verification is recorded in [the redacted evidence](m30-supplier-message-local.json).
The synthetic role proof runs unchanged locally and hosted, then rolls back every
fixture Auth, shop and ticket row. It is not real OTP or signed-owner HTTP proof.
Existing UI behavior is unchanged; the default flow continues to use the complete
hand-off transaction. M30, cloud activation, canonical reconciliation and all later
milestones remain open. GitHub workflows and Pages publication remain stopped by
the owner.
