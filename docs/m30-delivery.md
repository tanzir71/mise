# M30 · Supabase foundation

Status: **in progress**. Tenancy, shop-record SQL and an inert migration codec are implemented locally; the app continues to use its existing offline database. No hosted project has been created or modified, and no sign-in or sync interface is enabled. M30 and Phase 3 remain unticked.

## Tenant schema

The CLI-created migration `supabase/migrations/20261117081808_tenant_foundation.sql` adds businesses, outlets, members and explicit member/outlet assignments. Domain record IDs remain ULIDs; the separate Auth identity uses Supabase's UUID. UTC milliseconds retain the existing application format. Composite foreign keys reject assignments across businesses, and indexes cover tenant and identity lookups.

Owners can read their whole business. Managers can read assigned outlets and the member profiles assigned there. An unassigned manager has no outlet access. Staff can read their own profile and assignment, but this increment does not enable shared-screen or agent access. The privileged membership lookup lives in the unexposed `private` schema, accepts no caller-selected identity and pins an empty search path. It checks `auth.uid()`, active membership, confirmed phone and current Auth ban/deletion state rather than editable metadata or cached tenant claims.

All **29 public tables** now enable and force RLS. Anonymous callers have no table grants. Authenticated callers get scoped reads only; direct writes remain denied even to an owner until audited transaction handlers are implemented. Future tables and functions receive no implicit client access. PostgreSQL's built-in PUBLIC function execution is revoked globally because a schema-local revoke cannot subtract a global default; explicit grants then allow only the membership lookup required by the policies. See the [PostgreSQL default-privilege reference](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html) and [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Shop records and migration transport

The second CLI-created migration, `20261117085319_shop_records.sql`, adds named tables for the existing catalogue, customers, orders, sales, khata, stock, invoices, closing, Inbox and audit records, plus the remaining handover entities. Composite foreign keys bind related rows to the same business/outlet. Ledger entries also retain their account/customer/currency relationship; refunds must refer to a sale from the same order. Deferred checks allow record/audit cycles to commit together. Money uses bounded integer minor units, and stock uses exact thousandth quantities. These constraints complement the shared command validation still required by the future write endpoint.

Customers are business-level identities with explicit outlet associations. Initial migration associates every local contact with its source outlet, including contacts with no transactions. Owners retain unassociated profiles; managers can read only associated contacts. Balances and customer activity totals remain derived from authorized records.

Free-form strings, original arrays and audit snapshots use PostgreSQL `json`. This preserves escaped NUL and lone UTF-16 surrogates in retained source, which `jsonb` and SQL text cannot represent. Existing identity names/addresses convert with `to_json`; their values are preserved. The [PostgreSQL JSON reference](https://www.postgresql.org/docs/17/datatype-json.html) explains the differing input rules.

`packages/core/cloud-records.ts` defines a versioned, inert upload plan for all **21 local tables**. It validates the backup before JSON serialization, snapshots it before asynchronous work, maps explicit SQL columns and validates a complete reverse round trip. JSON columns travel as serialized JSON tokens; active uniqueness keys use canonical JSON-escaped text. Original files travel separately with their scoped path and SHA-256. Missing/tampered files, image-order gaps, unsupported fields/versions and foreign-business metadata fail explicitly. The codec performs no network request or database write. Its Auth UUID argument must come from a future server endpoint's verified identity; the codec itself checks format and grants no authority.

Inbox image metadata derives object paths from business/outlet/item/image ULIDs rather than filenames. Immutable metadata and positions cap each item at four images; an atomic parent-row reservation enforces the 10 MB total without an aggregate read/write race. The private Storage bucket, object permissions and upload/download integration are **not implemented yet**. Metadata and local file hashes do not establish that any object was uploaded.

## Local verification

`pnpm exec vitest run tests/tenant-foundation.test.ts` loads the actual migration into an ephemeral in-process PostgreSQL engine and executes queries as non-bypass `authenticated` and `anon` roles. It verifies owner/manager isolation, metadata spoofing, unassigned/inactive/unconfirmed identities, immediate revocation, Auth bans/deletion, multi-business membership, cross-tenant foreign keys, direct-write denial and future-object grants. The first run caught the inherited function-execution grant; the migration now revokes the global default.

PGlite is pinned to **0.3.16**, which reports PostgreSQL **17.5**, matching the target major version. Its current 0.5 series uses PostgreSQL 18. The test asserts major 17 to make a future tooling upgrade explicit. PGlite is a development-only dependency and opens no network listener. The test Auth fixture supplies only the `auth.users` fields and claim-to-UID boundary needed by these policies. It does not verify Supabase JWT signatures, phone OTP, sessions, PostgREST or hosted configuration. Those remain separate acceptance gates.

The first tenant increment passed 546 unit tests and 296 browser checks; its evidence is preserved in [m30-tenant-local.json](m30-tenant-local.json). The shop-record increment passes **611 unit tests** across 50 files, including **134 PostgreSQL checks**, lint and TypeScript/Astro checks. The 65 new checks load both migrations, round-trip actual app transactions from every local table and exercise all 23 outlet-record tables across two same-business outlets and another business. They cover literal source and original image bytes, unpriced orders, deleted-item snapshots, refunds, ledger reversals, stock corrections, closings, customer privacy, denied direct writes, scoped financial references and the exact image-byte budget. Both production base paths build successfully and all **296 `/mise/` browser checks pass without retries**. Logs, source hashes and compiled entries are in [m30-records-local.json](m30-records-local.json). The prior 142 visual comparisons remain the current layout evidence; this increment changes only the embedded changelog copy in the app.

## Configuration and external state

The CLI is pinned to **3.2.0**. The local config exposes only `public`, requires explicit API grants, disables the email provider, anonymous sign-in and local mail service, and uses 900-second access tokens with refresh-token rotation. A reserved fictional phone with a fixed OTP is configured for local development only; never push this test code to a hosted project. Unneeded local Studio, analytics, storage and realtime services are disabled for this first increment.

The connected account contains no Mise project. Its organization is on the free plan and quoted **$0/month** for a new project on 17 November 2026. Singapore (`ap-southeast-1`) and Twilio are the recorded region/provider choices; production SMS credentials and actual sending are unconfigured. No unrelated project was changed.

Automatic approval review rejected the combined local-config/database-start command, stating **"blocked by policy"** without further detail. That command did not execute. The config was then prepared through a scoped file edit. No database service was started through another route. Read-only CLI status confirms `supabase_db_mise` is absent. The embedded tests are not a claim that a Supabase stack or hosted migration has passed.

## Remaining M30 work

- Complete the identity/device/capability schema and private Storage integration; the 21-table local-record mapping is implemented.
- Provision the dedicated project, verify phone-only Auth settings, configure SMS and test real owner/manager authentication.
- Implement device enrolment, protected four-digit staff PIN verification and constrained staff/agent access.
- Implement transactional `/commands` with shared validation and audit writes; keep direct browser writes denied.
- Add resource-specific public capabilities and prove that each token can read only its own order or khata.
- Build the reviewed local-to-cloud upload and prove a resumable 5,000-record upload under the required 3G/60-second gate.
- Run Supabase database advisors, target-runtime database/API tests and full delivery verification before enabling sync or ticking M30.

Phase 2's physical QR scan and installed Android sharing checks remain open independently. GitHub Actions remain disabled by the owner's instruction; local checks and direct-main commits continue, with no workflow dispatch or Pages deployment.
