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

The same day's live read-only verification found all **47 public/private application
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

The nine Git/Node process integration fixtures have an explicit thirty-second test
budget. Their assertions still verify history detection, redaction and rejected
real commits/pushes; they do not benchmark filesystem or process-start latency.
Application and transfer deadlines are separate.
