# M30 · Owner profile and market settings

Business/profile saves now retain an original `setup.update` command in the same
local transaction as the business, outlet, owner contact and complete audit. Initial
setup remains part of the reviewed shop upload; this command cannot create a new
shop or reseed sample items. Cloud activation remains off and M30 stays incomplete.

The command projects only business type, market, shop name, contact phone, selected
outlet name/address, message language, timezone and currency. It retains the local
business/outlet/owner/audit identities and occurrence time. Defaults, trimming,
phone normalization and market validation share the existing setup domain code.
Unrelated input metadata, credentials and Auth fields never enter the command.

Saving settings preserves the owner's existing outlet assignments. Business,
outlet and owner timestamps cannot move backwards when the device clock does.
Existing catalogue samples, orders, sales and balances keep their original values;
changing the current market/currency does not reprice historical records.

The hosted path requires the live, confirmed, active owner whose contact is being
edited. Managers, staff, agents, foreign tenants and other owners cannot edit that
contact, even with forged user metadata. Another owner may update their own contact
and authorized business settings. Completion and receipt replay recheck current
membership and Auth state. The contact phone is separate from the Auth login phone:
this command never changes an Auth user, enrols a user or sends an OTP.

SQL updates only the business fields, the selected outlet's profile/market fields
and that owner's contact phone. Other outlets, members, permissions, assignments,
Auth identities, outlet preferences and existing shop links remain intact. The
audit contains complete portable before/after snapshots; mutation, audit and
original receipt commit atomically. Exact replay returns the old receipt without
restoring an older profile after later changes.

The CLI-created migration `20261118130956_profile_settings_commands.sql` adds a
private forced-RLS preparation table with no direct client/service grants. Its
canonical intent text/hash binds every normalized field, identity and physical
time. Isolated JSON string tokens retain Bangla, escaped NUL and lone UTF-16
surrogates; SQL never extracts literal strings from an entire JSON profile.
Service completion accepts only the bound normalized input. SQL computes the
allowlisted mutation and audit itself, preserving monotonic server metadata.

Preparation locks business, outlet, owner and Auth in that order. `NOWAIT` on these
locks avoids waiting in a cycle with older command paths that first hold membership
share locks. A fixed busy/snapshot-conflict tag permits at most three fresh
preparations; other errors remain explicit. Proofs expire after sixty seconds,
with at most one hundred pending preparations per caller. Privileged helpers stay
private with empty search paths and explicit grants; public wrappers are invokers.

Audit/queue failures roll back all three local records and the ordering fence.
The settings form retains entered values for retry. Compound actions preserve
their original command order; lost replies resume using stable IDs and durable
receipts. Unclassified writes beside a profile save retain the complete entry and
stop ordered delivery, including a previously unclaimed Inbox source.

The [redacted verification](m30-profile-local.json) records checks, source/bundle
hashes, the exact local/hosted SQL-role proof and credential scanning. The role
fixture exercises three owner commands, literal fields, historical replay, manager
and other-owner denials, private grants and normalized plan/completion binding. All
synthetic users, business records and tickets roll back. This does not establish a
real signed-owner HTTP write or phone OTP commissioning.

Verification passes 1,839 unit tests across 100 files, all 360 browser tests with
no retries, skips or flaky cases, and 24 focused browser checks at the root base
path. Lint, typecheck and builds at both `/` and `/mise/` pass. All 270 reference
exports are present. Forty visual comparisons cover the established cloud/recovery
states and the settings save; changed pages pass axe at all five target widths.

The hosted project has 28 source migrations and six active Edge Functions;
`commands` version 15 verifies JWTs. All 49 application tables enable and force
RLS, with no anonymous table access, direct authenticated table writes, direct
profile-ticket grants or public security-definer functions. The image bucket
remains private. Security advisors report no warnings or errors. The three-command
SQL-role fixture leaves no synthetic Auth users, businesses or tickets. HTTP
preflight returns 204; missing and invalid JWTs return 401. Auth/provider settings
and Vault secrets were not changed; no real SMS or messages were sent.

Visual QA uses the established settings form and the supplied M33 onboarding card
and type reference at 360, 390, 768, 1024 and 1440 px. There is no dedicated profile
settings frame or exact-pixel-match claim.
Full-page capture styling suppresses the normally offscreen skip link to prevent
a scrolling artifact. Native accessibility checks use the app styles. Run:

```sh
pnpm qa:visual qa/configs/m30-auth.json qa/configs/m30-upload-review.json qa/configs/m30-settings.json qa/configs/m30-profile.json
```

The [local report](../qa/report.html) includes the
[360 px settings form](../qa/screens/m30-profile-form-360.png),
[390 px settings form](../qa/screens/m30-profile-form-390.png) and
[desktop settings form](../qa/screens/m30-profile-form-1440.png).

Shop-link generation/undo, legacy direct supplier writes, canonical reconciliation,
full upload/outbox/image controls, real OTP/signed-owner HTTP, the 5,000-record 3G
gate and subsequent milestones remain open. GitHub Actions and Pages publication
remain stopped by the owner; this increment creates no CI artifact or Pages deploy.
