# M30 · Supabase foundation

Status: **in progress**. This increment prepares tenancy and identity in SQL; the app continues to use its existing offline database. No hosted project has been created or modified, and no sign-in or sync interface is enabled. M30 and Phase 3 remain unticked.

## Tenant schema

The CLI-created migration `supabase/migrations/20261117081808_tenant_foundation.sql` adds businesses, outlets, members and explicit member/outlet assignments. Domain record IDs remain ULIDs; the separate Auth identity uses Supabase's UUID. UTC milliseconds retain the existing application format. Composite foreign keys reject assignments across businesses, and indexes cover tenant and identity lookups.

Owners can read their whole business. Managers can read assigned outlets and the member profiles assigned there. An unassigned manager has no outlet access. Staff can read their own profile and assignment, but this increment does not enable shared-screen or agent access. The privileged membership lookup lives in the unexposed `private` schema, accepts no caller-selected identity and pins an empty search path. It checks `auth.uid()`, active membership, confirmed phone and current Auth ban/deletion state rather than editable metadata or cached tenant claims.

All four tables enable and force RLS. Anonymous callers have no table grants. Authenticated callers get scoped reads only; direct writes remain denied even to an owner until audited transaction handlers are implemented. Future tables and functions receive no implicit client access. PostgreSQL's built-in PUBLIC function execution is revoked globally because a schema-local revoke cannot subtract a global default; explicit grants then allow only the membership lookup required by the policies. See the [PostgreSQL default-privilege reference](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html) and [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Local verification

`pnpm exec vitest run tests/tenant-foundation.test.ts` loads the actual migration into an ephemeral in-process PostgreSQL engine and executes queries as non-bypass `authenticated` and `anon` roles. It verifies owner/manager isolation, metadata spoofing, unassigned/inactive/unconfirmed identities, immediate revocation, Auth bans/deletion, multi-business membership, cross-tenant foreign keys, direct-write denial and future-object grants. The first run caught the inherited function-execution grant; the migration now revokes the global default.

PGlite is pinned to **0.3.16**, which reports PostgreSQL **17.5**, matching the target major version. Its current 0.5 series uses PostgreSQL 18. The test asserts major 17 to make a future tooling upgrade explicit. PGlite is a development-only dependency and opens no network listener. The test Auth fixture supplies only the `auth.users` fields and claim-to-UID boundary needed by these policies. It does not verify Supabase JWT signatures, phone OTP, sessions, PostgREST or hosted configuration. Those remain separate acceptance gates.

Full-repository verification passes **546 unit tests** across 49 files, including **69 native PostgreSQL tenant checks**, lint and TypeScript/Astro checks. Both `/` and `/mise/` production builds pass; all **296 `/mise/` browser checks pass without retries**. Logs, source hashes and compiled entries are recorded in [m30-tenant-local.json](m30-tenant-local.json). The owner entry includes the new embedded changelog note; the isolated customer entry retains its previous hash. No screen layout changed, so the previous 142 M24 visual comparisons remain the current UI evidence rather than a new visual run.

## Configuration and external state

The CLI is pinned to **3.2.0**. The local config exposes only `public`, requires explicit API grants, disables the email provider, anonymous sign-in and local mail service, and uses 900-second access tokens with refresh-token rotation. A reserved fictional phone with a fixed OTP is configured for local development only; never push this test code to a hosted project. Unneeded local Studio, analytics, storage and realtime services are disabled for this first increment.

The connected account contains no Mise project. Its organization is on the free plan and quoted **$0/month** for a new project on 17 November 2026. Singapore (`ap-southeast-1`) and Twilio are the recorded region/provider choices; production SMS credentials and actual sending are unconfigured. No unrelated project was changed.

Automatic approval review rejected the combined local-config/database-start command, stating **"blocked by policy"** without further detail. That command did not execute. The config was then prepared through a scoped file edit. No database service was started through another route. Read-only CLI status confirms `supabase_db_mise` is absent. The embedded tests are not a claim that a Supabase stack or hosted migration has passed.

## Remaining M30 work

- Complete the domain schema and compatible mapping for existing local records, including the financial and audit invariants.
- Provision the dedicated project, verify phone-only Auth settings, configure SMS and test real owner/manager authentication.
- Implement device enrolment, protected four-digit staff PIN verification and constrained staff/agent access.
- Implement transactional `/commands` with shared validation and audit writes; keep direct browser writes denied.
- Add resource-specific public capabilities and prove that each token can read only its own order or khata.
- Build the reviewed local-to-cloud upload and prove a resumable 5,000-record upload under the required 3G/60-second gate.
- Run Supabase database advisors, target-runtime database/API tests and full delivery verification before enabling sync or ticking M30.

Phase 2's physical QR scan and installed Android sharing checks remain open independently. GitHub Actions remain disabled by the owner's instruction; local checks and direct-main commits continue, with no workflow dispatch or Pages deployment.
