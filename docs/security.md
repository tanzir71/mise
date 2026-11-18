# Deployment credentials

Actual Supabase credentials, project/organization references and private operational
records stay outside Git. Environment templates contain names and blank values.
`.env*`, `.private/`, `.secrets/`, key exports and Supabase CLI temporary files are
ignored. Server API keys, PIN peppers and access tokens belong in the server secret
manager; they must never use a public build-variable prefix.

This includes legacy service-role keys, database passwords and personal access
tokens. Do not import them into browser code or write them to logs. Publishable
keys are designed for clients, but this repository still keeps actual deployment
values private. Ignore rules do not protect files that are already tracked or
force-added.

Run `pnpm security:install-hooks` once in each clone. The installed pre-commit hook
scans working files and index blobs, including a staged secret whose working copy
has since been cleaned. The pre-push hook also scans reachable Git history and
`site/`. `pnpm lint` checks source/index files and `pnpm build` checks the completed
static output. These checks run locally while GitHub workflows remain disabled.
ESLint excludes ignored private tooling and secret directories; the separate
credential guard continues to inspect all tracked and staged files.

For a full audit, run:

```sh
pnpm check:secrets --history --artifacts
```

The guard checks credential patterns, filenames, commit/tag messages and ZIP
contents. Clone-local Git configuration `mise.secretScanDirectory` automatically
loads private key/pepper values for every scan; `mise.privateDeploymentRef` is
repeatable and checks plain project/organization IDs too. The configured directory
stays outside the repository; its path and all values remain in `.git/config` and
out of public evidence. `--known-directory` can explicitly select the private input.
Values are compared in memory. Findings contain rule names and redacted locations,
never matched values. Hooks depend on Node and installed dependencies; a missing
dependency, unreadable configured input or incomplete scan blocks the operation.

ZIP extraction is bounded; incomplete archive coverage fails the scan. Sixteen
guard tests cover redaction, ZIP contents, ignored configuration, staged/history
leaks, filename-only leaks, commit/tag messages, automatic clone-local comparisons,
unavailable private input and real blocked commit/push attempts.

The 18 November 2026 audit found **zero credentials** in current files, the index,
reachable history and built output. Current files and output also contain no actual
deployment references. Earlier commits retain nonsecret project identifiers; their
presence does not provide database or server access. Published history was preserved.
The latest audit fetched remote branches/tags first and compared nine private
key, pepper and deployment values in memory. It found zero credentials, zero
current deployment references and zero coverage gaps; the 22 historical findings
were nonsecret deployment references. Commit/push hooks remain enabled. The
[Inbox evidence](m30-inbox-hosted.json) records the redacted counts.

GitHub's repository secret scanning and push protection are also enabled. The
latest owner-authenticated, read-only API check returned zero open secret alerts.
These protections remain enabled independently of the stopped Actions workflows.

The same day's latest live verification found all **50 public/private application
tables** enforcing row-level security, zero anonymous table grants, zero public
security-definer functions and a private image bucket. Supabase security advisors
reported no warnings or errors. Informational private-table notices describe
the intentional absence of direct-access policies. No hosted authentication or
storage configuration was changed by this audit.

Local checks reduce accidental disclosure; they do not replace row-level security
or review of future authentication changes. If a credential ever reaches a public
location, rotate it and remove the exposed value; deleting the latest file alone
does not remove Git history.

The runtime phone sign-in interface accepts only a publishable key. Device
connection settings stay separate from the SDK session, which is scoped to the
project, key, base path and shop. Neither enters shop tables, JSON backups or build
variables. Private server keys are rejected
before any Auth request. Auth errors use fixed messages, and the client pins every
request to its configured HTTPS Auth origin. Sign-out aborts in-flight work and
verifies removal of saved credentials; a failed removal remains retryable. Browser
checks include cross-tab logout and a real downloaded backup after synthetic phone
verification. The [Auth/privacy evidence](m30-auth-local.json) records the latest
redacted audit and live read-only access checks. The older identifiers described
above remain historical; no history rewrite or credential rotation is claimed.

The upload boundary stores only a connection/account fingerprint in internal sync
state. Project URLs, publishable keys and session credentials remain separate.
`cloudState` and `outbox` are excluded from the explicit 21-table JSON backup.
Recovery rows stay local; network delivery accepts only validated domain intents
through the authenticated command endpoint. New queue identities are insert-only,
and an incomplete sequence blocks delivery. See the
[local boundary verification](m30-outbox-local.json).

The nine Git/Node process integration fixtures have an explicit thirty-second test
budget. Their assertions still verify history detection, redaction and rejected
real commits/pushes; they do not benchmark filesystem or process-start latency.
Application and transfer deadlines are separate.

The [local domain adapter verification](m30-domain-adapters-local.json) repeats the
nine-value source/index/history/build-output audit with no credentials, current
deployment references or coverage gaps. All 16 guard tests also pass in its full
1,615-test unit run. New profile/khata intents project only editable fields from
saved models; storage metadata and unrelated values stay outside the wire command.

The [order adapter verification](m30-order-outbox-local.json) repeats that scan and
all 16 guard tests within its 1,644-test unit run. Order/line/payment requests also
project only editable fields; full saved models are not serialized as commands.

The [manual-message queue verification](m30-handoff-outbox-local.json) repeats the
nine-value source/index/history/build scan and all 16 guard tests within its
1,673-test unit run. Queued message commands contain reviewed domain values and
companion IDs, with no connection settings, Auth session or server credentials.

The [Inbox queue verification](m30-inbox-outbox-local.json) repeats that audit and
all 16 guard tests within its 1,691-test unit run. Captures project only literal
source fields and original image metadata/hashes into commands; Blob bytes remain
local. Connection settings, Auth sessions and server credentials stay outside the
shop database, recovery entries and portable backups.

The [catalogue queue verification](m30-catalogue-outbox-local.json) repeats the
nine-value source/index/history/build audit and all 16 guard tests within its
1,718-test run. Catalogue commands project only editable domain values. The
private server plan binds their full normalized fields and original identities;
older unplanned catalogue entry points deny client and service execution. Hosted
checks confirm no anonymous table access or direct authenticated table writes.
Runtime connection settings and server secrets remain outside source, build
variables, shop records, command payloads and portable backups.

The [upload-review recovery verification](m30-upload-review-local.json) repeats
the source/index/history/build-output audit. Journal selection contains only the
original local shop identities and upload ID; it stores no project connection,
JWT or API key. Bound reviews verify their complete original payload and receipt.
Read-only recovery cannot silently replace missing evidence. Synthetic test/QA
interfaces stay outside the shipped application.

The [wording/export verification](m30-settings-local.json) repeats the nine-value
source/index/history/static-output audit. New commands project only editable
wording or preparation metadata, with no file bytes, connection details or Auth
fields. Private preparation binds the complete normalized intent and original
identity; service completion cannot replace those fields. A backup download after
an audit failure reads the already prepared file and performs no second database
write or fabricated audit. Old recovery evidence remains separate from portable
shop backups when a cancelled connection is replaced.

The [profile verification](m30-profile-local.json) repeats the credential audit.
Profile commands project only editable shop/contact/market fields. A contact edit
cannot change the Auth login phone, roles, permissions or assignments. Live owner
checks and complete normalized plans bind preparation, completion and historical
receipt replay. No runtime connection settings, credentials or Auth session enter
the shop records, audit command, queue, portable backup or static build.

The [shop-link verification](m30-link-local.json) repeats the credential audit.
Commands retain only reviewed public data and domain identities; no connection
settings or Auth session enter their payloads. Larger requests require live
outlet admission before body reading, followed by exact kind/scope binding and
fresh authorization for preparation/completion. A complete normalized plan binds
the exact frozen/restored URL; raw private table access remains denied. Server
validation never follows a published URL or acts on its literal public text.
