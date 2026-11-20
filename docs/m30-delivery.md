# M30 · Supabase foundation

Status: **in progress**. The dedicated Supabase project has 40 source migrations, seven Edge Functions, 60 application tables under forced RLS and one private image bucket. Audited domain commands, durable upload staging/promotion, scoped snapshot and image reads, original command coverage, outlet event feeds and the order financial review protocol are deployed. Actual project details and credentials remain outside Git.

Behind the default-off cloud flags, the app now supports [reviewed owner upload and automatic sync](m31-sync-runtime.md), [new-device outlet join](m31-join-runtime.md), [pending actions and complete original images](m31-pending-intents.md), [concurrent original intents](m31-concurrent-intents.md) and [existing-outlet scope recovery](m31-scope-recovery.md) and [original-owner sign-in recovery](m30-owner-resume.md). The normal app remains local-first. Genuine hosted phone OTP and positive signed-owner HTTP acceptance, financial/manual conflict resolution and remaining staff/agent resources stay open. M30/M31 remain unchecked; GitHub workflows and Pages publication remain stopped.

## Tenant schema

The CLI-created migration `supabase/migrations/20261117081808_tenant_foundation.sql` adds businesses, outlets, members and explicit member/outlet assignments. Domain record IDs remain ULIDs; the separate Auth identity uses Supabase's UUID. UTC milliseconds retain the existing application format. Composite foreign keys reject assignments across businesses, and indexes cover tenant and identity lookups.

Owners can read their whole business. Managers can read assigned outlets and the member profiles assigned there. An unassigned manager has no outlet access. Staff can read their own profile and assignment, but this increment does not enable shared-screen or agent access. The privileged membership lookup lives in the unexposed `private` schema, accepts no caller-selected identity and pins an empty search path. It checks `auth.uid()`, active membership, confirmed phone and current Auth ban/deletion state rather than editable metadata or cached tenant claims.

All **29 public tables** enable and force RLS. Anonymous callers have no table grants. Authenticated callers receive scoped reads and the explicitly authorized audited RPCs described below; raw table writes remain denied even to an owner. Future tables and functions receive no implicit client access. PostgreSQL's built-in PUBLIC function execution is revoked globally because a schema-local revoke cannot subtract a global default; explicit grants allow only the required functions. See the [PostgreSQL default-privilege reference](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html) and [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Shop records and migration transport

The second CLI-created migration, `20261117085319_shop_records.sql`, adds named tables for the existing catalogue, customers, orders, sales, khata, stock, invoices, closing, Inbox and audit records, plus the remaining handover entities. Composite foreign keys bind related rows to the same business/outlet. Ledger entries also retain their account/customer/currency relationship; refunds must refer to a sale from the same order. Deferred checks allow record/audit cycles to commit together. Money uses bounded integer minor units, and stock uses exact thousandth quantities. These constraints complement the shared command validation still required by the future write endpoint.

Customers are business-level identities with explicit outlet associations. Initial migration associates every local contact with its source outlet, including contacts with no transactions. Owners retain unassociated profiles; managers can read only associated contacts. Balances and customer activity totals remain derived from authorized records.

Free-form strings, original arrays and audit snapshots use PostgreSQL `json`. This preserves escaped NUL and lone UTF-16 surrogates in retained source, which `jsonb` and SQL text cannot represent. Existing identity names/addresses convert with `to_json`; their values are preserved. The [PostgreSQL JSON reference](https://www.postgresql.org/docs/17/datatype-json.html) explains the differing input rules.

`packages/core/cloud-records.ts` defines a versioned, inert upload plan for all **21 local tables**. It validates the backup before JSON serialization, snapshots it before asynchronous work, maps explicit SQL columns and validates a complete reverse round trip. JSON columns travel as serialized JSON tokens; active uniqueness keys use canonical JSON-escaped text. Original files travel separately with their scoped path and SHA-256. Missing/tampered files, image-order gaps, unsupported fields/versions and foreign-business metadata fail explicitly. The codec performs no network request or database write. Its Auth UUID argument must come from a future server endpoint's verified identity; the codec itself checks format and grants no authority.

Inbox image metadata derives object paths from business/outlet/item/image ULIDs rather than filenames. Immutable metadata and positions cap each item at four images; an atomic parent-row reservation enforces the 10 MB total without an aggregate read/write race. The private bucket and server upload/download path are now prepared below. Reviewed migration and app integration remain unavailable. Metadata and local file hashes alone do not establish that any object was uploaded.

## Customer-link capabilities

The third migration, `20261117102312_public_capabilities.sql`, adds a private, forced-RLS capability table and four explicit RPC entry points. A confirmed, active owner or an assigned manager can issue or revoke a link. These mutations check and lock live membership, outlet assignment and Auth state, and append an event in the same transaction. Staff, agents and anonymous callers cannot issue or revoke links. Direct table access remains denied.

The database creates a 256-bit, URL-safe random token and returns it once. Only its SHA-256 hash persists; audit metadata contains neither token nor hash. Repeating a create ID cannot replace the original grant. If the response is lost, the caller must revoke that known link ID and issue a fresh one; HTTP retry/recovery integration is still pending. Default expiry is seven days for orders and thirty days for khata, with an explicit ninety-day ceiling. Revocation is idempotent and takes effect on the next read. Existing grants belong to the business and survive the issuing operator's later deactivation; expiry and explicit revocation control customer access independently.

An order token returns that order's tracking, item, price and payment-status projection. Khata tokens return that account's name, exact derived balance and a cursor-bounded financial ledger. Customer line instructions are part of the order; merchant order notes, original source messages, customer contact details, credit limits, internal payment details and audit identities are excluded. Disabling further credit does not hide an existing balance. SQL money totals outside JavaScript's safe-integer range fail explicitly. Literal JSON fields travel as serialized JSON tokens to preserve the original Unicode values.

Customer reads intentionally require no account: the unguessable token is their authority. They accept no caller-selected business, outlet or resource ID, and cannot switch resource or purpose. Invalid, unknown, expired, revoked and wrong-purpose tokens all return null. Public entry points use security invoker; privileged implementations stay in the unexposed private schema with an empty search path and explicit execution grants. Built-in hashing is documented in the [PostgreSQL binary-string reference](https://www.postgresql.org/docs/17/functions-binarystring.html); the [Supabase function guidance](https://supabase.com/docs/guides/database/functions) covers execution privileges and search paths.

These RPCs are applied to the hosted database, but customer tracking/khata pages are not published. Rate limiting, HTTP/cache behavior, complete hosted resource-isolation verification, owner link-management UI and the M33/M35 customer interfaces remain unfinished.

## Device enrolment and staff PINs

The fourth CLI-created migration, `20261117114114_device_auth.sql`, adds four private, forced-RLS tables for devices, PIN verifiers, reserved attempts and short sessions. A confirmed active owner or an assigned manager can enrol or revoke kitchen/counter devices. Enrolment returns a random token once; only its SHA-256 hash persists, with a ninety-day lifetime. Device loss is handled by revocation and fresh enrolment. Device metadata and security events contain no token or verifier.

The owner manages the staff member's global PIN; a manager's outlet permissions do not grant a cross-outlet PIN reset. The server-only module uses an independent 16-byte salt and PBKDF2-HMAC-SHA256 with 600,000 iterations, then an HMAC with a separate pepper and business/member scope. The database receives no raw PIN, and the pepper is not stored there. A missing secret or unsupported version fails closed. This uses built-in Web Crypto rather than an added runtime dependency; see the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Before deriving a verifier, the service-only RPC reserves a try under row locks. Five attempts per fifteen-minute server window apply to each device and to the member across devices. Unknown members, abandoned requests and wrong proofs consume attempts. A successful login refunds its reservation without clearing earlier failures. Each attempt expires after one minute and is usable once. A successful finish atomically writes its audit and issues a separate, hashed, twelve-hour session bound to that device, member and PIN revision.

Session reads check current membership, outlet assignment, mode and permission booleans. Kitchen mode is restricted to three order permissions; explicit false values remove role defaults. Counter mode grants only explicitly enabled counter/order/khata permissions from its allowlist. PIN rotation/removal, logout, device revocation/expiry and member deactivation affect the next read. If a member has an Auth identity, bans, deletion and identity changes also invalidate access. The private PIN retains the linked UUID snapshot, so `ON DELETE SET NULL` cannot silently turn a deleted Auth identity into an accountless staff session. A staff member without an Auth account can use their owner-enabled PIN.

`supabase/functions/device-pin/index.ts` wires the login handler to two fixed service-only RPCs. Its custom device authentication intentionally uses `verify_jwt=false`; no caller can supply an arbitrary database command or successful PIN proof. The handler validates the device bearer token and bounded 2 KB JSON with a five-second read deadline, rejects unexpected fields/origins, derives the proof on the server, and returns only the short session. Responses are uncached, errors do not expose backend details, and no request credentials are logged. The new `sb_secret_…` API key goes only in `apikey`, with redirects disabled; see [Supabase key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys) and [function authorization headers](https://supabase.com/docs/guides/functions/auth-headers). Server-only variable names are in `supabase/functions/.env.example`; there are no configured values or fallback credentials.

All public RPCs are invokers with explicit grants; privileged implementations remain private with empty search paths. A device/session grants no raw shop-table reads, owner mutation, financial operation or agent access. The enrolment/PIN UI, staff data projections, staff commands, browser session handling and shared-screen routes remain unfinished. The earlier embedded HTTP checks did not verify the Supabase gateway; hosted commissioning and its limits are recorded below.

## Owner PIN administration

`20261117122734_owner_pin_admin.sql` adds an owner-only preflight context. It derives business/member scope from the selected outlet and member, checks the live confirmed owner, and exposes only scope IDs and whether a PIN exists. Setting requires an active staff/kitchen member assigned there; clearing remains possible for inactive or unassigned members of that business. Managers, foreign owners and service/anonymous callers cannot obtain this context.

The `staff-pin` Edge Function forwards the caller's JWT with a new publishable key. It never uses the service identity for owner changes or treats decoded/user metadata as authority. After authorization, it derives the verifier with the server pepper and calls the existing audited set/clear RPC, which checks live access again. Input accepts only the selected operation, outlet/member IDs and four digits for setting; caller-supplied business IDs, roles or proofs are rejected. Responses contain only audit metadata. Clearing works without the pepper so its loss cannot prevent PIN removal. Both handlers share the bounded, timed request reader and uncached/CORS responses.

## Scoped staff order reads

`20261117134918_device_order_reads.sql` adds a service-only read bound to the actual device and short-session tokens. Every call checks the existing live membership, assignment, PIN revision, device/session expiry/revocation and `orders.read` permission. No caller-selected business/outlet, role claim or decoded JWT controls its scope. Both public invoker and private implementation deny anonymous/authenticated execution, even with otherwise valid device credentials. Raw table grants remain unchanged.

`device-orders` performs its own device/session authentication (`verify_jwt=false`), accepts only bounded POST JSON and uses a fixed server-key Data API adapter. It permits only the session token, validated cursor and page limit. Exact CORS origins, five-second input/RPC deadlines, generic errors and uncached responses match the PIN services. GET is rejected; tokens never go in request URLs. The RPC wrapper is also POST-only in PostgREST. See [Supabase function privileges and definer guidance](https://supabase.com/docs/guides/database/functions#secure-a-database-function).

The Edge Function builds every output field explicitly. Kitchen tickets contain number, fulfilment type, source kind, status, timing, table and operational line details, with no prices, customer identity/contact, payment or audit data. Counter tickets additionally contain the order's customer-name snapshot, prices, totals and payment kind/status; they expose no linked customer record, phone, address, private messages, ledger or audit identity. Line and swap fields are allowlisted in both modes, so extra nested properties cannot smuggle private data into either response.

The native integration tests caught that PostgreSQL's JSON field extraction rejects retained NUL/lone-surrogate values. The service-only SQL therefore transports the original line JSON as a string, and server-side JavaScript parses and projects it without losing the original code units. Neither the raw line payload nor the service key is exposed to clients. Literal names, instructions and substitutions remain inert data.

History is paged by `(created_at,id)`, at most 100 orders per page, using a tenant/outlet index and one statement snapshot. Tied timestamps retain deterministic pagination. Cancelled/completed orders are included so a consumer can remove a finished ticket. This listing is **not** the M31 change cursor, realtime subscription or conflict protocol; it does not establish concurrent sync convergence. The shared-screen interface, caching and queued taps remain unfinished.

Live Deno → Data API → PostgreSQL tests verify counter/kitchen reads, both Unicode code units, field redaction, nested-field removal, two-page pagination, terminal status retention, exclusion of a second same-business outlet, immediate permission removal, mismatched device/session denial (401), foreign-origin denial (403), raw RPC denial (401), GET rejection (405) and `Cache-Control: no-store`. The fixture used direct synthetic sessions; it does not claim a new PIN login or real phone OTP. Every fixture row was removed with the business ID and ownership marker; orders, audit/security records and Auth users count zero. No credential file was created for this test. Source/runtime proof is in [m30-device-orders-hosted.json](m30-device-orders-hosted.json).

## Private original images

The private `mise-inbox` bucket is configured through the Storage API from `deploy/supabase/inbox-bucket.json`: JPEG/PNG/WebP only, at most **5 MB per image**. Original filenames stay in image metadata; object paths contain only the four scoped ULIDs. A restrictive `storage.objects` policy denies every direct anonymous/authenticated operation on this bucket, including when an unrelated feature adds permissive policies. Other buckets are unaffected. Bucket/object creation and removal use the API; managed Storage metadata is read-only to this implementation, as required by the [Storage schema guidance](https://supabase.com/docs/guides/storage/schema/design).

`20261117141552_inbox_image_storage.sql` adds owner/assigned-manager image context and completion RPCs. They derive scope from the saved image and check the actual caller's live confirmed Auth identity, membership and assignment. Public functions are invokers; private implementations have empty search paths. Anonymous/service identities cannot invoke them. Completion locks the image, rechecks access, verifies the private bucket and actual Storage metadata, then marks the upload and writes one metadata-only event in the same transaction. Repeating completion preserves its original timestamp/event. A missing object, size/type/hash mismatch or failed audit cannot mark an image uploaded.

The `inbox-image` Edge Function requires platform JWT verification and forwards the original JWT with the publishable key for both context and completion. Only its fixed Storage adapter uses the server key. `PUT ?image=<id>` consumes the original binary bytes, verifies the exact saved length, existing shared MIME signature checks and SHA-256 before uploading. The upload uses `x-upsert:false`; its hash metadata comes from the verified bytes. A duplicate or lost response is recovered by fetching and verifying the existing immutable object, without overwriting it. The database trusts that server metadata because clients cannot write the bucket. `GET` verifies downloaded bytes and repeats caller authorization before returning them. No signed URL or public access bypasses that check.

Bodies are bounded to the saved size (maximum 5 MB), with a ninety-second incoming deadline to accommodate uploads on 3G. RPCs time out after five seconds and Storage requests after ten. Responses use exact CORS origins, `no-store`, `nosniff` and a restrictive image response CSP. Original names never enter headers. PNG/JPEG/WebP signature validation is shared with local backup/import through the dependency-free `packages/core/inbox-image.ts`; existing exports remain compatible.

Storage and PostgreSQL do not share a transaction: a transfer interrupted before completion can leave a private, unconfirmed object. Retrying the same original verifies and reuses it, then completes the audited database state. The reviewed batch-upload driver and app interface still need to expose this progress and recovery. No uploaded flag is inferred from a request that merely started.

Live Storage API checks preserve the exact 92-byte test PNG and reject duplicate writes, anonymous/public reads, anonymous uploads, SVG and a 5 MB + 1 byte payload (all return 400). Anonymous listing returns an empty array. The actual stored size/MIME/server-hash metadata matches the completion predicate. The deployed Deno function rejects a signed anonymous identity with its own uncached error (401); the platform rejects a forged owner JWT (401). The first probe expected 403 for anonymous SQL denial; PostgREST correctly returned 401, and the corrected probe passed. All test paths were removed through the Storage API, with zero remaining objects verified. No Auth account, SMS, message or credential file was created. These checks **do not prove positive owner/manager JWT transfers or phone OTP**; those gates remain open. [m30-images-hosted.json](m30-images-hosted.json) records the evidence.

## First transactional commands

The next two sections describe the earlier catalogue contract. The current
device-intent contract requires outlet and occurrence time on every action and
the saved category ID on create/update; its replacement RPCs close the older
entry points. See [catalogue queue verification](m30-catalogue-outbox.md).

The original two strict intents in `packages/core/cloud-commands.ts` are `catalogue.availability` (`id`, `itemId`, boolean `available`) and `catalogue.undo` (`id`, `undoOf`). The shared parser rejects extra actor, role, tenant, SQL, money or record fields. The endpoint requires platform JWT verification; these two intents forward the original JWT with a publishable key to one fixed RPC without a service identity. Responses are uncached, exact-origin CORS is enforced, and backend errors expose no private details. The current four-kibibyte limit and additional write intents are described below.

`20261117145205_catalogue_commands.sql` adds private, forced-RLS command receipts with no direct client/service table grants. Each accepted ID is bound to its original Auth identity, actor, target and exact intent. A transaction-level advisory lock serializes duplicate IDs; the outlet and item are locked for changes, and live confirmed owner/assigned-manager access is checked under the existing authorization locks. Staff, agents, anonymous/service identities and foreign/unassigned operators cannot apply commands. The item mutation, metadata receipt and audit event commit together; an audit collision rolls all three back. The public RPC is an invoker; privileged functions remain private with empty search paths. See [PostgreSQL transaction/row locks](https://www.postgresql.org/docs/17/explicit-locking.html) and [Supabase function privileges](https://supabase.com/docs/guides/database/functions#secure-a-database-function).

Retries with the same ID/intent return the original receipt, including after a newer change, without repeating the write. Reusing an ID for different intent conflicts; another actor cannot take over the ID. A receipt describes the accepted historical command, not the current catalogue value. Clients must retain ordering when handling acknowledgements and fetch current state through the future sync protocol.

Availability setters apply to the latest committed state and record both the previous value and server acceptance time. Monotonic receipt sequences break timestamp ties; this receipt mechanism is **not** a complete change feed or M31 sync engine. Legacy future creation timestamps are preserved without falsifying audit server time. Undo derives the inverse from the original receipt and refuses when any newer availability intent exists, even if its value was identical. It changes only the flag and logs the current actor plus the original event reference. Prices, variants, photos and unrelated fields are retained. Core-compatible before/after snapshots preserve original NUL/lone-surrogate names through JSON construction rather than field extraction.

The original deployed endpoint's live checks reject a signed anonymous identity through the actual Deno/Data API path (401 with its own `no-store` error), forged owner JWT (401), caller-supplied identity fields (400), foreign origin (403), GET (405) and anonymous raw RPC (401). That verification created no domain/Auth fixture, credential file or message. Real owner/manager JWT writes and multiple-connection concurrency remain **unverified** until Auth commissioning. Native transaction tests are recorded below. Financial/stock/order commands, device/agent writes, the browser outbox and user interface remain unfinished. Historical evidence for these first two intents is in [m30-commands-hosted.json](m30-commands-hosted.json); the extension follows.

## Catalogue create, edit and delete

`catalogue.create` carries caller-generated command/item IDs, an outlet ID and the exact item input; update derives its outlet from the existing item, and delete accepts only command/item IDs. The local catalogue and Edge service share the same save validation, whitespace handling, default category, NFKC category matching and integer prices through `packages/core/catalogue-save.ts`. IDs remain device-generated where appropriate. The request limit is now 4,096 bytes so valid maximum-length escaped Unicode fits; the five-second read deadline and other PIN endpoints' original 2,048-byte default remain unchanged.

The tenth migration adds private forced-RLS write tickets. Preparation runs with the original caller JWT, verifies active confirmed owner/assigned-manager access, locks the outlet, and returns literal item/category JSON plus a random proof. Only its hash persists. The ticket binds the original Auth UUID, actor, business/outlet, intent hash and catalogue snapshot for sixty seconds. A service-only finish RPC accepts shared-validated scalar fields rather than executing or extracting arbitrary customer JSON. It rechecks the stored live identity, phone/ban/deletion state and manager assignment, then locks the outlet/item and checks the latest snapshot. Ordinary callers cannot finish tickets or read their private rows; the server cannot prepare them under its own service identity.

Category creation, the item mutation, original receipt and audit event commit atomically. Normalized categories are reused after a snapshot race. The server prepares at most three times for the same immutable intent, recording the latest before-state; other conflicts and failures stop. Create/update/delete replay their original acceptance receipts even after later edits or deletion, without recreating a deleted item. Edits preserve variants/photos and original creation times; deleted full rows remain privately retained. Availability undo rejects a newer catalogue edit. This increment does not add CRUD undo, a change feed, browser writes or sync.

A live HTTP probe exposed repeated PostgREST retries on an expected `40001` conflict. The eleventh migration replaces those application errors in both write completion and older availability undo with explicit `PT409` errors, following [Supabase's documented retry-loop fix](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b). Only the tagged snapshot conflict permits bounded re-preparation; backend error details stay private. The confirmed synthetic request backend was stopped. The same service request now returns 409/`PT409` in 751 ms. The `commands` service is active at version 3 with platform JWT verification retained.

Hosted PostgreSQL role tests perform create/edit/delete, literal NUL/surrogate round trips, receipt replay after deletion and live revocation, then roll back the complete synthetic Auth/domain fixture in a subtransaction. Final Auth/business/item/receipt fixture counts are zero. Actual HTTPS checks separately prove Deno validation, the 4 KB limit, rejected anonymous/forged identities, CORS and the service-only conflict response. These layers do not establish a real owner JWT write, phone OTP or multi-connection concurrency. [m30-catalogue-hosted.json](m30-catalogue-hosted.json) records the evidence and its boundaries without live project identifiers or keys.

## Local verification

`pnpm exec vitest run tests/tenant-foundation.test.ts` loads the actual migration into an ephemeral in-process PostgreSQL engine and executes queries as non-bypass `authenticated` and `anon` roles. It verifies owner/manager isolation, metadata spoofing, unassigned/inactive/unconfirmed identities, immediate revocation, Auth bans/deletion, multi-business membership, cross-tenant foreign keys, direct-write denial and future-object grants. The first run caught the inherited function-execution grant; the migration now revokes the global default.

PGlite is pinned to **0.3.16**, which reports PostgreSQL **17.5**, matching the target major version. Its current 0.5 series uses PostgreSQL 18. The test asserts major 17 to make a future tooling upgrade explicit. PGlite is a development-only dependency and opens no network listener. The test Auth fixture supplies only the `auth.users` fields and claim-to-UID boundary needed by these policies. It does not verify Supabase JWT signatures, phone OTP, sessions, PostgREST or hosted configuration. Those remain separate acceptance gates.

The first tenant increment passed 546 unit tests and 296 browser checks; its evidence is preserved in [m30-tenant-local.json](m30-tenant-local.json). The shop-record increment passes **611 unit tests** across 50 files, including **134 PostgreSQL checks**, lint and TypeScript/Astro checks. The 65 new checks load both migrations, round-trip actual app transactions from every local table and exercise all 23 outlet-record tables across two same-business outlets and another business. They cover literal source and original image bytes, unpriced orders, deleted-item snapshots, refunds, ledger reversals, stock corrections, closings, customer privacy, denied direct writes, scoped financial references and the exact image-byte budget. Both production base paths build successfully and all **296 `/mise/` browser checks pass without retries**. Logs, source hashes and compiled entries are in [m30-records-local.json](m30-records-local.json). The prior 142 visual comparisons remain the current layout evidence; this increment changes only the embedded changelog copy in the app.

The customer-capability increment passes **660 unit tests** across 51 files, including **183 PostgreSQL checks** (69 tenancy, 65 shop records and 49 capability checks). The new suite loads all three real migrations against core-generated records in two outlets and a separate business. It verifies hashed one-time tokens, role and live-Auth restrictions, scope and purpose isolation, expiry, immediate/idempotent revocation, atomic audit rollback, exact ledger pagination and balance arithmetic, excluded merchant fields, and explicit overflow failure. Lint and TypeScript/Astro checks pass. This remains a test-only Auth boundary; it does not establish hosted JWT, OTP or API behavior.

The first full browser run passed 295 checks and timed out in the offline PDF setup while waiting for service-worker control after restore and route navigations. The two offline report tests now verify initial worker control before restore reloads the document. Their financial, Bengali, PDF and offline assertions are unchanged. Both tests then passed three independent repetitions each, with no retries. The original failed log and trace are retained locally; this setup correction changes no production app code.

The second full run passed 295 checks, including the PDF, and exposed a separate early read in the poster regeneration test. Its status text already existed from the first generation, so the test could read the old published URL before the new transaction's view updated. It now waits for the actual URL to change before downloading and decoding the QR; all original QR-content and literal-name assertions remain. Three independent repetitions pass without retries. This also changes only test synchronization.

The final full run passes **all 296 browser checks without retries** in 7.6 minutes. Both `/` and `/mise/` production builds pass. Source, compiled-entry and log hashes, including the two initial failures and focused verification, are recorded in [m30-capabilities-local.json](m30-capabilities-local.json). No layout changed; the prior 142 visual comparisons remain the layout evidence, with no new visual run claimed. These local checks used Node 24.22.2 and pnpm 10.33.2; the repository's Node 20.19+ requirement is unchanged.

The shared-device suite exercises all four migrations and the real request handler, Web Crypto derivation and service-only SQL protocol together. It covers wrong/unknown credentials, cross-device/outlet/business denial, charged and cross-device rate limits, live permissions, Auth hard deletion, expiry, replay denial, owner-only PIN removal, logout, audit rollback and bounded input. A separate server test cancels a stalled body at its five-second deadline before any database call.

The device-authentication increment passed **725 unit tests** across 54 files, including **225 PostgreSQL checks** (69 tenancy, 65 shop records, 49 customer capabilities and 42 device/PIN tests), plus 16 PIN-derivation and seven handler/configuration checks. TypeScript/Astro and lint passed, including server modules in strict type checking. Both static build bases passed and all **296 browser checks passed without retries** in 7.3 minutes. The final body-deadline change was server-only and passed the subsequent full unit/type/lint checks; the static sources and compiled entries were unchanged. [m30-device-local.json](m30-device-local.json) preserves that increment's source, log and compiled hashes.

The current owner-PIN/hosted increment passes **747 unit tests across 55 files**, including **235 PostgreSQL checks** (69 tenancy, 65 shop records, 49 customer capabilities and 52 device/owner-PIN checks), plus 16 PIN-derivation, seven device-handler and twelve owner-handler checks. The owner tests exercise real KDF/SQL integration, changed permissions between preflight and mutation, inactive/unassigned clearing, audit rollback, unexpected input and forwarded caller identity. Lint and strict TypeScript/Astro checks pass. Both `/` and `/mise/` builds pass; the final **296 browser checks pass without retries in 6.9 minutes**. There are no server-function imports in app/shared packages. [m30-owner-hosted.json](m30-owner-hosted.json) records local hashes and hosted proof. No layout changed or new visual run is claimed; the prior 142 comparisons remain the layout evidence.

The scoped device-order increment passes **788 unit tests across 57 files**, including 35 new native HTTP/PostgreSQL integration checks and six handler/transport checks. The native suite loads all seven migrations and real core-generated orders for all four business packs, including unpriced lines, substitutions, cancelled orders, tied timestamps and literal NUL/lone-surrogate names/instructions. It covers mode-specific redaction, unknown nested fields, bounded pagination, wrong credentials, live permission/role/assignment changes, revocation/expiry, PIN removal, raw RPC denial and cache headers. Lint and strict TypeScript/Astro checks pass. Both production base paths build, and **all 296 browser checks pass without retries in 5.9 minutes**. This backend increment changes only the embedded changelog copy in the app; no new layout or visual comparison is claimed. [m30-device-orders-hosted.json](m30-device-orders-hosted.json) records source/build/log hashes and live evidence.

The private-image increment passes **817 unit tests across 59 files**, including 22 native HTTP/PostgreSQL image checks and seven handler/transport checks. Owner and assigned-manager uploads/downloads, unassigned/foreign/staff denial, immutable retries, audit rollback, missing/wrong Storage proof, byte corruption, mid-transfer revocation, body deadlines and restrictive-policy behavior are covered. Storage tables in the native suite are an explicitly test-only metadata fixture; actual object-byte behavior is verified separately through the hosted API. Lint and strict TypeScript/Astro checks pass (80 Astro files clean). Both `/` and `/mise/` builds pass and **all 296 browser checks pass without retries in 6.0 minutes**. The shared validator extraction and embedded changelog change the compiled entries without changing layouts; the prior 142 visual comparisons remain the layout evidence, with no new visual run claimed. [m30-images-hosted.json](m30-images-hosted.json) records source, compiled and log hashes plus the hosted proof and its limits.

The first-command increment passes **856 unit tests across 61 files**, including 32 new native HTTP/PostgreSQL checks and seven handler/transport checks. The suite loads all nine migrations and core-generated catalogue data across two businesses and three outlets. It compares the audit snapshots with the existing core availability command, including literal NUL/lone-surrogate names, and tests exact retries, older receipt replay after a newer change, actor-bound IDs, role/outlet isolation, undo freshness, audit rollback, live revocation and preservation of unrelated/future-dated data. Lint and strict TypeScript/Astro checks pass (81 Astro files clean). Both production bases build; **all 296 browser checks pass without retries in 6.7 minutes**. No layout or new visual comparison is claimed. [m30-commands-hosted.json](m30-commands-hosted.json) records hashes and the separate native/hosted verification limits.

The catalogue CRUD increment passes **923 unit tests across 62 files**, including 67 native command HTTP/PostgreSQL checks and 30 handler/transport checks. All eleven migrations load in the native suite. Coverage includes maximum-length escaped input, normalized category races, full-row retention, exact replay, actor/scope isolation, all live identity revocations, audit rollback and bounded tagged conflicts. Lint and strict TypeScript/Astro checks pass (82 Astro files clean). Both production bases build, and **296 browser checks pass with no retries in 6.8 minutes**; after the final changelog rebuild, both catalogue CRUD/offline smoke cases pass again at 390/1440 px. No layout or new visual comparison is claimed. [m30-catalogue-hosted.json](m30-catalogue-hosted.json) records source/build/log hashes and the separate native, hosted-role and actual HTTP proof boundaries.

The local upload-recovery increment passes **945 unit tests across 64 files**, including 22 new snapshot/runner/journal checks. Lint and strict TypeScript/Astro checks pass (84 Astro files clean); both production bases build. **All 298 browser checks pass with no retries in 7.1 minutes**, including two isolated native Chromium checks for 5,000-record Blob/IndexedDB durability, full-page reload and lost-reply recovery. The receiver in those new tests is a fixture, so no hosted upload, phone OTP or 3G timing is claimed. The new journal and harness are absent from shipped JavaScript; no product layout or new visual comparison is claimed. [m30-upload-local.json](m30-upload-local.json) records hashes and the exact verification scope; [m30-upload.md](m30-upload.md) defines the remaining hosted/outbox contract.

Earlier, `supabase db advisors --type all --fail-on error` against the local stack exited 1 with `ECONNREFUSED 127.0.0.1:54322`. No local database service was started. The actual hosted advisor checks are recorded below; the embedded engine alone does not establish hosted behavior.

## Configuration and external state

The CLI is pinned to **3.2.0**. The local config exposes only `public`, requires explicit API grants, disables the email provider, anonymous sign-in and local mail service, and uses 900-second access tokens with refresh-token rotation. A reserved fictional phone with a fixed OTP is configured for local development only; never push this test code to a hosted project. Unneeded local Studio, analytics, storage and realtime services are disabled for this first increment.

The dedicated Mise project belongs to the owner-selected organization and is hosted in Singapore (`ap-southeast-1`), on the quoted **$0/month** plan. Its managed database reports PostgreSQL **17.12**. No unrelated project was changed.

Hosted configuration is isolated in `deploy/supabase/config.toml`. The CLI's reviewed diff was applied with an explicit project ref; a follow-up diff has zero declared changes. A direct `/auth/v1/settings` read confirms email, phone, anonymous users and every external provider are disabled, and signups are disabled. Access-token expiry is fifteen minutes. The local fictional phone/test OTP was never transferred. Twilio credentials and actual phone OTP remain unconfigured; phone/signups should be enabled only when that setup is ready.

All sixteen local migration versions are present in hosted history, with no seed/custom-role/Vault update. Catalog checks confirm 29 public and eleven private application tables all enable and force RLS, zero public security-definer functions and postgres function ownership. Anonymous raw-table SELECT and authenticated direct INSERT/UPDATE/DELETE remain denied. `20261117130209_hosted_fk_indexes.sql` resolves the hosted foreign-key index notices. The seventh migration adds device-order reads, the eighth private-image authorization/completion, the ninth audited catalogue receipts, the tenth scoped catalogue write tickets, and the eleventh prompt HTTP conflicts without managed retry loops. The twelfth and thirteenth migrations add private initial-upload staging and atomic reviewed promotion. The fourteenth adds private customer/khata command preparation and atomic finalization; the fifteenth covers its event foreign key, and the sixteenth restricts shared-contact status to every associated outlet while narrowing ordinary snapshots. They grant no raw client table writes.

The deployed `device-pin` v1 uses its custom device/PIN authentication (`verify_jwt=false`); `staff-pin` v1 requires platform JWT verification. Four environment names are configured in the project's secret manager; no secret value is in the repository. Live Deno → Data API → PostgreSQL verification rejects an unknown device and a wrong PIN (401), accepts the synthetic staff PIN (200), returns the expected shop/outlet and permission intersection, signs out (200), returns null for the old session, and responds 429 after five failed tries. An anonymous raw orders read is denied (401); a forged owner JWT is rejected (401). The synthetic fixture was then removed with exact IDs and its ownership marker. Businesses, outlets, members, audit events, device/PIN/attempt/session records and Auth users all count zero. No Auth account, customer record, SMS or other message was created. These tests do **not** establish real owner/manager phone OTP or positive owner JWT access.

Hosted security/performance advisors have no WARN/ERROR findings. The eleven [RLS-without-policy notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) are intentional private default-deny tables with no direct client grants. The 79 [unused-index notices](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) are informational after the empty project's small verification workload; required constraint/FK indexes are retained. Full workload performance remains part of the 5,000-record gate.

Automatic approval review rejected removal of the four temporary credential/fixture files, stating **"blocked by policy"**. No deletion command executed and no alternative route was attempted. They remain in a private temporary deployment directory, outside the repository. Database fixture cleanup succeeded independently. Do not confuse this retained local copy with the configured server secret manager.

Earlier automatic approval review rejected the combined local-config/database-start command, stating **"blocked by policy"** without further detail. No local database service was started through another route. The later dedicated hosted project and API-based function deployments are separate authorized operations; the local-stack gate remains open.

## Hosted upload and repository privacy

The new `migration-upload` function uses the original signed caller identity for private staging, an opaque promotion lease and a service-only atomic finalizer. Shared validation retains exact source records and original images, while receipt replay prevents duplicate imports. Native client/handler/SQL tests and separate rolled-back hosted role/Storage checks pass; positive signed-owner HTTP upload, actual phone OTP, UI/outbox integration and real 3G performance remain open. See [the upload contract and verification boundaries](m30-upload.md) and [redacted hosted evidence](m30-upload-hosted.json).

The repository audit finds no credentials in working files, the index, reachable Git history or built output. Actual deployment identifiers are absent from current files/output; older nonsecret identifiers remain in history. Local commit/push hooks and the production build now run the redacting guard while GitHub workflows remain disabled. See [credential handling and audit notes](security.md).

## Customer and khata saves

The expanded `commands` v4 supports strict customer create/update/archive/restore and khata settings. A shared mutation preserves the existing local transaction across the profile, terms, optional opening and all audits. The original caller prepares a live scoped snapshot; a service-only finalizer verifies its opaque proof, rechecks identity, holds business/outlet locks and commits the records and original receipt atomically. Managers receive no other-outlet ledger or balance-preview data. Global status changes require every associated outlet, and archival independently checks all khata balances. Source/local checks, the deployed bundle boot, hosted rolled-back SQL roles and live negative/CORS probes pass separately from the still-open signed-owner HTTP/OTP gate. See [the detailed contract](m30-customer-commands.md) and [redacted evidence](m30-customer-hosted.json).

## Remaining M30 work

Complete atomic remote order transactions now preserve device order, line,
payment, cancellation, refund and companion-audit identities, including linked
khata reversals. See [the order command contract and verification limits](m30-order-commands.md).

- Local immutable upload snapshots, gzip chunk validation, resumable transfer orchestration and a separate credential-free IndexedDB journal are implemented; see [the upload contract and verification limits](m30-upload.md). The authenticated staging/promotion service and original-file checks are now deployed; complete the snapshot/outbox boundary and positive signed-owner HTTP verification before enabling controls or claiming the 3G/60-second gate.
- Complete remaining staff/agent resources and private-image migration/UI integration; the bucket, RPCs and image endpoint are deployed, with positive hosted owner/manager transfer verification still open.
- Configure the production SMS provider and test real owner/manager phone OTP; email/anonymous sign-in must stay disabled.
- Complete the device/PIN interface, with scoped staff data/commands and browser session handling; both PIN HTTP functions are deployed.
- Extend transactional `/commands` beyond the deployed catalogue, customer/khata, counter/payment, stock, supplier/invoice, order, closing, complete hand-off and Inbox families to remaining staff/agent and other intents; preserve shared validation, scoped authorization, idempotent receipts and atomic audits. Keep raw browser writes denied.
- Complete public capability HTTP/rate-limit integration and hosted tests; local SQL tests cover isolation, expiry and revocation.
- Finish the reviewed upload interface/outbox integration and prove a resumable 5,000-record upload under the required 3G/60-second gate.
- Complete positive owner JWT/resource-isolation tests, remaining target-runtime checks and full delivery verification before enabling sync or ticking M30; hosted advisors and device/PIN tests are recorded above.

Phase 2's physical QR scan and installed Android sharing checks remain open independently. GitHub Actions remain disabled by the owner's instruction; local checks and direct-main commits continue, with no workflow dispatch or Pages deployment.

## Counter receipts and khata payments

The hosted command service now also records cash/wallet/card and credit counter sales, khata payments, manual communication records and guarded counter/standalone-entry undo. Caller-generated record IDs and device occurrence times survive retries; the actual financial rows, literal audit snapshots and receipts agree on their server admission metadata. Eighteen migrations and `commands` v5 are deployed. See [implementation and verification](m30-money-commands.md). Other money linked to an order or refund requires its complete original transaction. All cloud controls remain unavailable, with phone OTP, signed-owner HTTP, related-ID reconciliation and the app/outbox boundary still open.

## Device-generated customer identities

Customer/profile and khata settings commands now retain the originating device’s account, opening-entry and companion-audit IDs. A pending offline payment can reference that same account after customer admission. Conflicting account creation requires explicit retained-intent review rather than a silent ID substitution. See [implementation and verification](m30-customer-identity.md). The outbox remains unavailable and the full M30 acceptance gates remain open.

## Stock saves, counts and movements

The hosted service now supports stock creation/editing, archive/restore, relative movements, atomic batches of up to 1,000 items and 24-hour guarded undo. Device item/move/audit/batch IDs and physical occurrence times are retained. Relative movements merge across newer relative revisions; active physical counts create a review barrier. Stock batches pass an original-caller outlet authorization check before the larger body is consumed. All twenty migrations and `commands` v7 are deployed with JWT verification enabled. The exact deployed bundle, rolled-back nine-command hosted fixture and nine HTTP/CORS denial checks pass; all 42 application tables force RLS, with no anonymous table grants, direct client writes or public security-definer functions. See [stock implementation and verification](m30-stock-commands.md). Phone OTP, positive signed-owner HTTP, remaining command families and the app/outbox boundary remain open.

## Suppliers and priced invoices

Supplier creation/editing/archive/restore, complete 200-line invoice recording and ten-minute guarded undo now share local validation and preserve device IDs. Invoices do not receive stock, create counter sales or change customer debt. Larger invoice bodies require an original-caller outlet check before reading. All 21 migrations and `commands` v8 are deployed with JWT verification enabled. The exact deployment module, rolled-back six-action hosted fixture and thirteen HTTP/CORS checks pass. All 43 application tables force RLS; there are no anonymous table grants, direct client writes or public security-definer functions. See [supplier/invoice implementation and verification](m30-purchase-commands.md). Remaining M30 gates and the app/outbox boundary stay open.

## Complete order transactions

All eleven order command types now reuse the complete local lifecycle: create/edit,
compound save-and-pay, statuses and undo, notes/contact history, payment and undo,
cancellation/restore, partial refunds and undo, and warning settings. Related device
IDs survive bounded retries, with a canonical outlet number assigned under lock.
The complete 200-line body requires original-caller outlet admission before reading.
All 22 migrations and `commands` v9 are deployed with JWT verification enabled.
The exact deployment module and thirteen-action rolled-back hosted role fixture
pass, including credit reversal, wallet/refund restoration and historical replay.
All 44 application tables force RLS, with zero anonymous grants, direct client
writes or public security-definer functions. See [implementation and verification](m30-order-commands.md)
and [redacted evidence](m30-order-hosted.json). Remaining M30 acceptance gates and
the app/outbox boundary stay open; GitHub workflows and Pages publication stay held.

## Reviewed day closing

Closing now recomputes the complete reviewed Today snapshot at the original
device time, preserving the cash count, optional surplus sale and all device IDs.
Same-day undo retains original snapshots, reverses only the linked surplus receipt
and preserves later sales. The live database day uses the original closing
timezone, independently of preparation time or changed outlet settings. All 23
migrations and `commands` v10 are deployed with JWT verification enabled. The exact
deployed module matches the checked bundle; the rolled-back five-action hosted
fixture passes with eight audits and historical replay. Fourteen actual HTTP/CORS
checks pass. All 45 application tables force RLS, with zero anonymous table grants,
direct client writes or public security-definer functions; advisors report no
warnings or errors. See [implementation and verification](m30-closing-commands.md)
and [redacted evidence](m30-closing-hosted.json). Phone OTP, positive signed-owner
HTTP and remaining M30/outbox gates stay open. GitHub workflows remain disabled.

## Complete manual message transactions

Preparation, Open/Copy/failure, explicit Sent and guarded correction now share
the complete local mutation. Sent atomically records its credit, order or supplier
communication with the original device IDs; identical supplier resends reuse
their original record. All seven source kinds are outlet-scoped, and topic
generations are assigned under lock. Literal text, templates and history clocks
survive retries. All 24 migrations and `commands` v11 are deployed with JWT
verification enabled. The checked module matches deployment; the rolled-back
23-action hosted fixture passes with 32 audits, and all 15 HTTP/CORS checks pass.
All 46 application tables force RLS with no anonymous table grants, raw client
writes or public security-definer functions. Clone-local commit/push/build guards
automatically compare private deployment values without publishing them. See
[implementation and verification](m30-handoff-commands.md), [redacted evidence](m30-handoff-hosted.json)
and [credential safeguards](security.md). Inbox, Auth commissioning and the
remaining M30/outbox gates stay open; GitHub workflows remain disabled.

## Original Inbox captures and sorting

Capture retains original title/text/URL, creation and capture times, image IDs,
names, types, sizes and hashes. Private image bytes upload separately; metadata
cannot mark them uploaded. Reviewed classification, archive and reopen preserve
complete source history and reject stale revisions. Repeated current choices
keep the source unchanged and retain one command-metadata audit/replay receipt.
No sorting action creates an order, money or stock. All 25 migrations and
`commands` v12 are deployed with JWT verification enabled. The exact module,
fourteen-action rolled-back hosted fixture and sixteen HTTP/CORS checks pass.
All 47 application tables force RLS; anonymous table grants, direct client writes
and public security-definer functions remain absent. Advisors report no warnings
or errors. See [implementation and verification](m30-inbox-commands.md) and
[redacted evidence](m30-inbox-hosted.json). Phone OTP, positive signed-owner HTTP,
staff/agent resources and remaining app/upload/outbox gates stay open. GitHub
workflows remain disabled and private deployment values stay outside the repo.

## Runtime phone sign-in and private configuration

The default-off `cloudSetup` route adds device-entered project settings, phone OTP,
fresh verified-user checks, SDK session refresh and local sign-out, plus a durable
count review of all 21 local tables. Real deployment values never enter source,
build variables, static artifacts or JSON shop backups. A privileged key is rejected
before a request. Auth sessions are scoped to the project, publishable key, base
path and shop, and stale in-flight verification cannot restore a forgotten session.
Public shop/marketing connection policies remain restricted. See the
[implementation and verification notes](m30-auth-interface.md).

The production provider remains uncommissioned and Auth signups disabled. Browser
proof uses intercepted synthetic responses on a reserved `.test` host, with no SMS
or hosted user creation. The count review sends no shop data and does not enable
sync. Actual OTP, the positive owner HTTP path, complete upload activation and the
outbox remain required. GitHub workflows and Pages publication remain stopped.

## Initial upload and local change queue

Local schema 11 now keeps the upload boundary and outbox in the same IndexedDB
database as shop records. The snapshot stays immutable while later writes commit
with their recovery rows and original intent identities. Normal, worker and narrow
transactions share the same persistent ordering fence. Backup files still use
schema 10 and contain only the 21 shop tables. Six financial intent kinds have
typed delivery and persistent receipts; other writes remain retained for review
and stop ordered delivery. Server-confirmed staging cancellation preserves history
and allows a fresh review without wiping local data. See the
[implementation and verification notes](m30-outbox-boundary.md).

Unsupported write adapters, canonical receipt/pull reconciliation and upload/outbox
controls remain unfinished. This increment enables no sync interface, commissions
no phone provider and changes no hosted schema or service. M30 stays unticked and
GitHub workflows and Pages publication remain stopped.

## Catalogue device intents and queue

Catalogue lifecycle actions and full-size local paste now retain their original
identities and occurrence times in typed queue transactions. The hosted service
binds complete normalized fields to its private plan and closes the older
unplanned catalogue entry points. All 26 migrations and `commands` v13 are
deployed; no sync control is enabled. See the
[catalogue implementation and verification](m30-catalogue-outbox.md). Remaining
M30 acceptance gates stay open; Actions and Pages publication remain held.

## Original upload review recovery

Count-review refresh now preserves all snapshots and follows the exact active
upload before its first acknowledgement and through cross-tab changes, reload or
lost responses. A scoped durable selection survives backwards clocks; missing or
damaged originals require read-only recovery. Concurrent chunk acknowledgements
preserve verified progress. The separate journal upgrades without changing shop
or portable backup schemas. See [implementation and verification](m30-upload-review.md).
Full upload activation and remaining M30 gates stay open. No hosted service,
workflow or Pages deployment is changed.

## Reminder wording, export preparation and recovery

The queue and hosted command service now support original `khata.wording` and
`export.prepare` actions. Wording changes preserve unrelated outlet fields;
export records contain only reviewed preparation metadata. Bound normalized inputs,
live scoped identity, canonical audit/receipt metadata and atomic writes protect
both families. Prepared JSON backups retain a manual download when history cannot
be written. A cancelled connection no longer blocks a fresh review after importing
another shop. See [implementation and verification](m30-settings-commands.md).
Legacy supplier writes and remaining M30
gates stay open; no full sync interface is enabled.

## Owner profile and market settings

Original `setup.update` saves now have typed local intents and an owner-only hosted
transaction. Full portable before/after history accompanies allowlisted updates to
the business, selected outlet and owner's contact. Existing assignments, other
outlets/members, permissions, Auth login phones, outlet preferences and historical
financial/catalogue records remain intact. Local and hosted metadata stays
monotonic, and write failures leave the form available for retry. See
[implementation and verification](m30-profile-commands.md). Initial setup remains
part of reviewed upload admission; no sync interface or Auth provider is enabled.

## Original shop-link publications and undo

Typed `shopLink.generate` and `shopLink.undo` intents now retain the original
operator, occurrence, approved snapshot and exact public URL/code/edition.
Owner/assigned-manager completion preserves frozen publications and audits the
actual URL replaced by server-time last-write-wins. Guarded undo uses the original
physical generation time, including after delayed delivery. Local queue/audit
failures roll back all writes; the statically loaded adapter also supports cold
compound transactions. See [implementation and verification](m30-link-commands.md).
Canonical pull/apply, legacy supplier saves and remaining M30 gates stay open.

## Original legacy supplier sent assertions

The [standalone supplier command](m30-supplier-message-commands.md) queues the remaining direct sent save before its existing correction. It preserves the complete original assertion and private actor/scope binding, without a fabricated hand-off or stock/financial side effects. The source and hosted proof are recorded separately in its redacted evidence. M30 remains incomplete; no cloud control, real OTP or signed-owner acceptance is claimed.

## Durable scoped download

The [download service](m30-sync-feed.md) captures projected changes and tombstones
atomically, then returns fixed-snapshot pages with complete record hashes,
bounded gzip envelopes and signed cursors. Cached reads still check current access.
Independent hosted connections prove that a late commit with an earlier ordinal
arrives in the next window. Canonical application, active-operator selection,
image delivery and complete cloud controls remain open. The latest evidence also
records 1,990 unit tests, 366 browser checks and the ten-value credential audit.

## Durable local download staging

The [same-database download journal](m30-sync-staging.md) persists original requests,
immutable pages and fully verified records on empty or existing devices. Schema 12
retains shop data, image Blobs, upload receipts and original outbox entries while
portable backups stay at 21 tables/schema 10. Downloads preserve local financial
writes and exact recovery across offline reload, concurrent tabs and quota failure.
No domain apply, accepted-cursor advance or sync control is enabled by this step.

The [explicit operator increment](m30-operators.md) replaces first-member lookup
with selected owner/manager identity, scope-checked multi-outlet backup recovery
and durable sign-out/account locks. Schema 13 preserves earlier images, queues,
accepted upload receipts and staged downloads. The dedicated project now has 32
migrations; the new authenticated metadata wrappers return no Auth UUID or
credentials. The exact 15-check hosted SQL-role proof rolls back every fixture,
and unauthenticated RPC HTTP requests return 401. All 56 application tables still
force RLS; seven Edge Functions and all secrets are unchanged. Actual OTP/owner
HTTP, legitimate new-device activation, canonical application and convergence
remain open. GitHub Actions and Pages publication remain stopped.
