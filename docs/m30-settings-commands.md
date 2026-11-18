# M30 · Reminder wording, export preparation and backup recovery

Changes to khata wording and prepared-export audits now retain typed commands in
the same local transaction as their records and history. This covers
`khata.wording` and `export.prepare`. Shop-link changes and legacy direct supplier
messages still require their own adapters. Owner profile saves are covered by the
[subsequent profile increment](m30-profile-commands.md). M30 remains incomplete
and cloud activation stays gated.

Reminder wording projects only the payment note and four English/Bangla templates.
Local and server validation share trimming, length limits and allowed placeholders.
Literal source text, including accepted NUL and lone UTF-16 surrogates, stays inert
JSON data. A save changes only the outlet's wording and metadata; currency, contact
details, shop link and order-warning preferences are preserved. Existing future
metadata timestamps never move backwards.

An export command contains the original format, ordered dataset choices, row count,
filename, capture time, date range and phone preference. Dates must be valid and in
order. It contains no file bytes, backup records, connection settings or Auth
credentials. This records the client's preparation claim; it does not prove that
a file was downloaded, shared or received. No sale, payment or khata balance changes.

Both command kinds retain the actual local audit ID, outlet and occurrence time.
The hosted transaction derives the actor from the original confirmed caller and
checks live owner/assigned-manager access again at completion. Another actor cannot
replay a receipt. Exact retries return the original receipt after later changes,
without restoring earlier wording. Changes admitted later apply to the latest
outlet state; before/after history retains what was replaced.

The CLI-created migration `20261118120357_settings_audit_commands.sql` adds a
private forced-RLS preparation table with no direct client/service table access.
Canonical intent text and its SHA-256 bind every normalized field, original ID and
time. SQL constructs this text from isolated JSON string tokens, preserving literal
Unicode without extracting strings from an entire object. A service completion
cannot substitute a different normalized input. SQL computes the allowlisted
outlet mutation and complete audit itself and commits its receipt atomically.

Preparation proofs expire after sixty seconds, with at most one hundred pending
preparations per caller. Only the fixed snapshot-conflict tag allows three bounded
re-preparations; other failures remain explicit. Public wrappers are security
invokers, privileged functions stay private with empty search paths, and raw table
writes remain denied. No new browser credential or build-time configuration exists.

Queue or audit failure rolls back the complete local action and ordering fence.
Wording fields stay available for retry. Compound actions retain their command
order and durable receipt prefix after a lost response. An unclassified write in
the same transaction retains the whole entry and stops later delivery.

A prepared JSON backup now remains available even if recording its history fails.
The screen explains that failure and offers **Download prepared backup**. This
manual action downloads the original in-memory file without retrying a failed
database write or claiming that an audit was saved. It works in both the backup
page and restore preview. The file keeps the complete twenty-one-table portable
snapshot, including original records and phone numbers; internal queue/journal
state and runtime connection/Auth settings remain excluded.

After server-confirmed cancellation, importing another shop's backup can prepare
and arm a new scoped review. The old cancelled snapshot and its recovery queue
remain intact. Active bindings still reject scope mismatches and replacement.
The native regression imports through the actual backup screen and checks the
old snapshot's byte hash and queued work before arming the replacement shop.

The [redacted verification](m30-settings-local.json) records local checks, exact
source/bundle hashes, hosted role verification and the repeated credential audit.
The hosted role fixture exercises four owner/manager commands, historical replay,
literal wording/filename retention, denied unassigned outlets and private reads,
and bound preparation/completion fields. It rolls back all synthetic Auth/domain
rows. This is SQL-role verification; real phone OTP and a signed-owner HTTP write
remain unproven.

Visual QA combines the existing connection/review comparisons with five backup
failure states at 360, 390, 768, 1024 and 1440 px:

```sh
pnpm qa:visual qa/configs/m30-auth.json qa/configs/m30-upload-review.json qa/configs/m30-settings.json
```

The local [report](../qa/report.html) compares the supplied M27 More, Desktop 14
Business data and M17 export shells. Key captures are the
[360 px backup fallback](../qa/screens/m30-settings-backup-fallback-phone-screen-360.png),
[390 px backup fallback](../qa/screens/m30-settings-backup-fallback-phone-screen-390.png)
and [desktop backup fallback](../qa/screens/m30-settings-backup-fallback-desktop-screen-1440.png).
Added recovery controls have no dedicated Figma export; pixel differences remain
informational rather than an exact-frame-match claim. The isolated synthetic
fixtures are intercepted by tests/QA and are absent from the production bundle.

Verification passed with 1,790 unit tests across 98 files, 354 browser tests without
retries or skips, 33 focused browser checks at the root base path, lint, typecheck
and builds at both `/` and `/mise/`. All 270 reference exports are present and all
35 visual comparisons completed without overflow. Changed pages pass axe checks.

The hosted project now has 27 source migrations and six active Edge Functions;
`commands` is version 14 with JWT verification enabled. All 48 application tables
enable and force RLS. Anonymous table access, direct authenticated table writes,
direct preparation-table grants and public security-definer functions are absent.
The bucket remains private. Security advisors report no warnings or errors. The
four-command SQL-role proof left no synthetic users, businesses or preparation
tickets. HTTP preflight returns 204; missing and invalid JWTs return 401. These
checks do not establish real-owner signed HTTP acceptance.

Actions and Pages publication remain stopped by the owner; there is no new CI
artifact or Pages deployment. No real SMS, message, phone-provider activation or
Auth configuration change is performed. Canonical receipt/pull reconciliation,
complete upload/outbox/image controls, unsupported writes, real OTP/signed-owner
HTTP, the 5,000-record 3G gate and subsequent milestones remain open.
