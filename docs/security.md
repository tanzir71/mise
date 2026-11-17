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

For a full audit, run:

```sh
pnpm check:secrets --history --artifacts
```

The guard checks credential patterns, filenames, commit/tag messages and ZIP
contents. Its optional `--known-directory` input compares private local key/pepper
values in memory; keep that directory outside the repository and its path out of
public evidence. Findings contain rule names and redacted locations, never matched
values. Hooks depend on Node and installed dependencies; a missing dependency or
incomplete scan blocks the operation.

ZIP extraction is bounded; incomplete archive coverage fails the scan. Thirteen
guard tests cover redaction, ZIP contents, ignored configuration, staged/history
leaks, filename-only leaks, commit/tag messages and real blocked commit/push attempts.

The 18 November 2026 audit found **zero credentials** in current files, the index,
reachable history and built output. Current files and output also contain no actual
deployment references. Earlier commits retain nonsecret project identifiers; their
presence does not provide database or server access. Published history was preserved.

The same day's live read-only verification found all **38 public/private application
tables** enforcing row-level security, zero anonymous table grants, zero public
security-definer functions and a private image bucket. Supabase security advisors
reported no warnings or errors. Nine informational private-table notices describe
the intentional absence of direct-access policies. No hosted authentication or
storage configuration was changed by this audit.

Local checks reduce accidental disclosure; they do not replace row-level security
or review of future authentication changes. If a credential ever reaches a public
location, rotate it and remove the exposed value; deleting the latest file alone
does not remove Git history.
