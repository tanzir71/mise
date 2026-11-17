# Deployment credentials

Commit configuration templates with blank credential values. Keep actual Supabase
project/organization references, dashboard links and deployment records outside the
repository. Public verification reports use redacted identifiers.

Server API keys, legacy service-role keys, database passwords, personal access
tokens and PIN peppers belong in the deployment secret manager. Never prefix them
with `VITE_` or `PUBLIC_`, import them into browser code, or write them to logs.
Supabase publishable keys are designed for clients, but actual deployment values
still stay out of this repository. RLS and scoped server authorization protect data.

Local `.env` files, API-key exports, `edge.env`, private credential directories and
Supabase CLI caches are ignored. Ignore rules do not protect already tracked or
force-added files.

`pnpm lint` includes `pnpm check:secrets`. The guard scans current files and staged
Git blobs, reports file locations and rule names without matched values, and fails
on credentials or deployment endpoints. Use `pnpm check:secrets --history --artifacts`
before publication to also inspect reachable Git history and the built `site/`.
ZIP downloads are inspected with bounded extraction; incomplete archive coverage
fails the check. The optional `--known-directory <private-directory>` also compares
against actual API keys and PIN peppers in memory, without printing their values.
That directory must remain outside the repository.

Scanning is a defense against accidental disclosure, not a substitute for reviewing
changes. If a credential is published, revoke/rotate it before considering Git
history cleanup. Nonsecret project identifiers in older commits are recorded
separately; sanitizing current files does not remove those older references.

These checks run locally. GitHub Actions and Pages publication remain stopped under
the owner's instruction.

The 17 November 2026 audit found no credentials in current files, staged blobs,
reachable Git history or the existing built site, including exact comparisons
against the configured API keys and PIN pepper. Current delivery notes were
redacted; older commits retain nonsecret project metadata. Nine guard tests cover
redaction, ZIP contents, staged/history leaks and ignored local configuration.
