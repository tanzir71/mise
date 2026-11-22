# Changelog

All notable changes are documented here. Milestone completion is recorded after verification.

## [Unreleased]

### Added

- In progress: owners and assigned managers can inspect and close an original customer-link issuance attempt without recovering its secret. A durable closure revokes an issued link and blocks a delayed original request before replacement; original audit identities and retry receipts are preserved. The owner interface and full M30 acceptance remain open.

- In progress: customer order and khata capabilities gain a bounded, uncached HTTP read endpoint with installation-wide and per-link server budgets. Direct reader RPCs cannot bypass those limits. Original tokens, expiry, revocation, private projections and financial records are preserved; M30 stays open and customer pages remain gated.

- Each installation configures its own backend, phone provider and other optional services. Cloud setup links to a configuration guide included in the site build; privileged credentials stay in the installation backend. Blank server templates and provider readiness checks keep unconfigured services off while local work remains available.

- In progress: preparation screens load current tickets without paging through completed history. Cancelled orders retain the design's outlined Understood control until a real acknowledgement; offline taps, lost replies and undo/re-cancel preserve their original sources and receipts. M32 remains open and its flags stay off.

- In progress: one coordinated kitchen scheduler inspects due orders and starts eligible desk notifications without a second polling delay. Idle ticks enqueue no HTTP request. Private Vault references and a fixed Cron command keep runtime configuration out of job metadata; expiring, single-use signed requests keep reusable keys out of the platform queue. Failed inspections retain their original work with bounded retries, and fresh work can proceed independently. The managed scheduler passes isolated timing and recovery checks and is disabled afterward; real provider/device acceptance and full M32 delivery remain open.

- In progress: opt-in desk notification controls connect complete kitchen warnings to Inbox and the red order-queue indicator. Enable preserves the explicit browser gesture; offline Disable and earlier-setup cleanup retain original requests through reload and lost replies. Generic service-worker notices check the actual native desk and current browser capability before opening this installation’s Inbox. Share capture stays independently gated. Scheduling, provider/device commissioning and full M32 acceptance remain open; publication stays held.

### Fixed

- In progress: preparation screens and warnings stop at fulfilment handoff while retaining original history and offline taps. Scheduled warnings consistently use the later original creation/scheduled time; premature warnings resolve without a fabricated Got it. A released wake lock clears its visible On state and keeps manual controls available.

- The private kitchen scheduler now binds the original Vault secret references explicitly, avoiding a collision with Vault's encryption-key column. An isolated live run verifies the default two-minute alarm, actual Got it, disable/resume and transactional dispatch recovery without changing order money or registering notification recipients. Cleanup leaves no job enabled; full M32 acceptance remains open.

- A Ready gesture keeps its original ticket and acknowledgement parent when its own accepted Got it reaches the cache during the save. Changed preparation content, undone acknowledgements and unrelated newer revisions still require review; original receipts and money stay unchanged.

### Security

- In progress: private per-desk subscriptions and leased alarm delivery retain original recipients, cancel unsent work on actual Got it and recover lost results. An explicit withdrawal also blocks an older registration which arrives late. Exhaustive task pages and a private account-bound cache retain verified data through interrupted reads and storage failure. A separate operation journal preserves original retries, mutes notifications offline and prevents late results from undoing Disable or replacing a newer subscription. The original phone account can register or revoke only its own capability; runtime keys and browser encryption material stay out of public audit, metadata replies and the local journal. Local SQL, HTTP, crypto and packaged-runtime checks pass; desk controls, scheduling and hosted acceptance remain unfinished, with both new functions undeployed.

- In progress: server-owned kitchen alarms create audited Inbox tasks and cancel pending notifications on a genuine Got it. Configured or disabled warnings pass through the scoped reader and offline cache. Web Push request encryption, provider restrictions and deadlines are verified locally; subscriptions, scheduled delivery, desk Inbox/queue integration and hosted acceptance remain open. The new migration/worker are not deployed and kitchen flags stay off.

- An older unconfirmed kitchen tap can no longer defeat a newer owner status undo. An undone Got it remains historical proof, while Ready requires a current acknowledgement; undoing Ready keeps its still-current Got it. Original offline taps remain available for review, with prices and payments unchanged. Reserved alarm and VAPID values are covered by the credential guard before generation. M32 alarms/push and full acceptance remain open.

- Saved kitchen taps can be checked after a fresh staff PIN without changing the original actor or resending an earlier gesture. Explicit closure is journaled before delivery, recovers lost replies and prevents a late original request from preparing the order. Full original tickets remain available to copy; prices and payments stay unchanged. M32 alarms/push and final acceptance remain open, with the screen flag off and publication held.

- An opt-in shared preparation screen caches actual tickets and journals Got it/Ready taps before delivery. A device-authenticated private realtime relay wakes scoped reads without sending service credentials, customer details or money to the screen. Original sources and PIN sessions remain bound across offline reload and retries. Alarm/push and final M32 acceptance remain open; `kitchenScreen` stays off by default and publication stays held.

- Kitchen preparation has a device-scoped backend for Got it and Ready. Original tap identities, ticket content and acknowledgement parents survive retries; changed items require review, and prices, payments and customer details stay intact. Revoked devices, PIN sessions, assignments and permissions are checked again before a write. Full M32 acceptance remains unfinished; device access stays off by default.

- Shared screens keep device credentials in an isolated native journal, outside shop backups and owner Auth. Pairing requires the owner's complete verification comparison; PIN digits stay transient. Lost replies recover the original attempt, and revoked staff or managers lose access after a fresh server check. The new interface remains off by default.

- Saved closing undo stays bound to its original count creation event during delivery and canonical replay. A reviewed replacement cannot silently become the target of the old undo; the saved action remains available for explicit review.

- Offline customer contact and terms edits retain their existing khata identity after a shop currency change. Contact-only edits write no account or ledger entry; original-unit limits preserve other currency accounts. Scoped admission, fresh access checks and immutable source guards remain enforced.

- Offline customer opening balances and credit limits keep their original khata currency during delivery, canonical sync and outlet recovery. Existing historical-account settings remain valid; contact-only edits cannot silently create an account in a different unit.

- Offline supplier invoices keep their original currency during delivery, canonical sync and outlet recovery. A changed shop currency cannot reinterpret saved prices; historical invoice undo and genuine completed receipts retain their original unit.

- Git privacy checks now reject newly introduced deployment identifiers in reachable history, branch/tag names and historical filename aliases. Exact opaque fingerprints retain only the 22 documented old nonsecret findings; credentials always fail. Missing policy and shallow history fail closed. All 35 guard tests pass, including a permitted legacy-only push and a blocked later identifier.

- Rechecked source, staged files, fetched Git history and existing site output against private Supabase values: no credentials or current deployment details found. All 35 credential-guard tests pass; commit/push/build guards and GitHub secret scanning/push protection remain enabled. Older nonsecret project identifiers remain disclosed in the audit; GitHub workflows remain stopped.

### Added

- Opt-in shared-screen settings let owners and assigned managers create pairing codes, compare and approve a screen, and revoke it. Owners can set or clear staff PINs. The separate screen setup supports QR or manual entry, staff PIN sign-in and interrupted sign-in/sign-out recovery while preserving any owner records in the browser. M30/M31 and hosted acceptance remain open.

- Saved physical cash counts gain an opt-in comparison of the original count, current records and proposed cash effect. Explicit withdrawal or replacement preserves the physical amount, count time, day, currency and complete source. A token-free local journal recovers genuine outcomes after lost replies and offline reloads; changed cash parents require another review. Copy and JSON backup remain available. Cloud sync stays off by default.

- Saved customer and khata actions gain an opt-in comparison of original details, current records and the reviewed result. Explicit withdrawal or replacement preserves the original financial parents, opening amount and balance date. A token-free journal recovers genuine outcomes after lost replies, offline reloads and account changes; conflicting khatas are never silently retargeted. Copy and JSON backup remain available. Cloud sync stays off by default.

- Saved stock actions now have an opt-in comparison of original and current quantities, units, supplier selections and physical-count history. Explicit withdrawal or replacement retains the original source and recovers genuine outcomes after lost replies, offline reloads and account changes. Review tokens stay ephemeral; cloud sync remains off by default.

- Saved stock descriptions and archive choices now merge with the latest online item while preserving its current quantity, unit and physical-count history. Original edits stay intact; physical counts and undo retain their review rules. Cloud sync remains off by default.

- Stock quantity, target and supplier buttons include their displayed values in their accessible names.

- M31 saved invoice actions gain an opt-in comparison and explicit withdrawal or same-currency replacement. The original invoice identity, prices, quantities and undo clock stay intact; a token-free local journal retains deliberate choices and recovers genuine outcomes after interruption. Full cloud acceptance remains open and sync stays off by default.

- M31 opt-in counter and khata review compares the original amount/currency with current sale, customer, balance and limit. Explicit withdrawal or replacement preserves original financial identities and undo clocks; credit above the checked limit needs separate consent. A token-free native journal recovers genuine outcomes after lost replies and offline reload, and changed values require another choice. Confirmed history remains recoverable after the original account is restored, without reviving an old decision. Full milestone and hosted acceptance remain open; cloud sync stays off by default.

- M31 pending counter/khata and order projections now retain their original queue currency during canonical downloads and outlet-access recovery. A changed profile cannot reinterpret saved amounts or advance the accepted cursor; original sources, images and backup remain available. Covered historical money, same-currency replay and historical payments/undo remain valid. Cloud sync stays off by default.

- M31 counter sales and khata payments now assert their original saved currency outside unchanged commands. Missing or conflicting source stays local, new admission and commit-time profile races cannot reinterpret money, and historical account payments/undo plus actual completed receipts remain valid. Counter rejections no longer advertise order-only review. Non-order financial review/resolution remains unfinished; cloud sync stays off by default.

- M31 queued orders now carry their original saved currency separately from the unchanged command. A profile change or commit-time race retains mismatched orders for review; historical-currency payments remain valid, and actual completed receipts still replay before new admission checks. No currency is guessed from the device's current profile.

- M31 saved order actions now have an opt-in comparison and explicit apply/withdraw controls. The token-free review journal survives offline reload and lost replies, checks the actual server outcome before retrying, and shows current currency, customer, khata and payment/refund effects. Changed values require a fresh choice; original sources and financial identities remain intact. The sync header's visible queue count and accessible label now match; financial previews decode literal method labels once. Other financial families and hosted acceptance remain open.

- M31 order conflicts now have a current-value review protocol and distinct server-authorized withdrawal or replacement receipts. Replacement retains the original financial IDs and physical time; lost replies recover the actual outcome, and canonical audit proof is required before retiring the original projection. Native two-browser checks preserve later cash, full sources and images. Other financial families remain unfinished; cloud sync stays off by default.

- Sync now retains an account-bound observation of an exact rejected action, its original queue source and accepted receipt prefix. Reviews survive offline reload without changing money, source images or commands. A genuine later receipt confirms the observation atomically; the financial review interface remains unfinished, and cloud sync stays off by default.

- M31 setup and outlet joining now show the count of shares already saved on an empty device. A real offline service-worker capture survives one phone verification and manager admission, then can be explicitly claimed before the first canonical application; original images and offline cash converge without duplicate money or another upload. Cloud and share-target flags remain default off.

- M24 shares received with a locked operator stay unassigned on the device until an explicit outlet review. Original text, images and capture identities survive recovery, reload, competing claims and audit failure; unrelated typed work can sync without acknowledging or uploading the unassigned source. Default flags and remaining acceptance gates stay unchanged.

- M30 original owners can restore a lost phone sign-in after upload and before first download, without uploading again or replacing the working shop. Durable resumption preserves original receipts, queued cash and complete images; live account checks cover native selection and activation. Default cloud flags remain off and full M30/M31 acceptance stays open.

- M31 existing outlets can review changed server scope or role through the original phone account, with resumable full downloads, fresh command coverage, complete images and a retained original shop backup. Atomic admission preserves the original upload/join and queue; lost activation resumes without applying twice. The feature remains default off and full cloud acceptance stays open.

- M31 original concurrent notes and confirmed order communications now append against the current order, with server admission ordering for supplier and nonfinancial order edits. Inbox classification and archive changes preserve each other and original image bytes. Financial, source, undo and reviewed-closing guards remain strict; full cloud acceptance stays open.
- M31 tentative replay retains actions made more than five minutes after a frozen download, without inventing server admission times or changing commands and receipts. Actual server clock and expiry checks remain enforced.

- M31 fixed downloads now retain every currently typed pending action family through shared domain replay, including complete order/refund companions, reviewed closings, manual messages, original Inbox images and frozen shop links. Original commands and receipts stay intact; remaining concurrent revision merges and full cloud acceptance stay open.
- M31 automatic sync now uploads complete original Inbox image bytes after metadata acceptance, with original-account and source guards, idempotent lost-reply recovery and verified canonical upload checks. Portable backups retain and validate image-upload audits without changing manual sorting revisions.

- M31 new devices can explicitly join an allowed outlet through one phone verification. A durable original selection, resumable snapshot/images, guarded atomic admission and automatic sync preserve existing records, original downloads and receipts. Fresh access checks and cancellation retain manual recovery and JSON backups; cloud sync remains opt-in.

- M31 opt-in sync now connects the saved local upload, original queued actions, verified downloads and header status. Durable retries, pause/resume, original-account checks and insert-only outlet event hints preserve offline work through lost replies and reloads. Full cloud acceptance and remaining conflict families stay gated.

- M31 command delivery now stays bound to the original verified phone account and connection across HTTP and native receipt acceptance. Bounded Auth/response work, ephemeral session checks and original operator/source guards retain pending actions through account switches or transaction expiry; exact retries preserve cash without duplicates. Native convergence uses the actual phone client with an explicit local test verifier. Cloud controls and remaining M30/M31 acceptance stay gated.

- M31 original owner uploads can now enter canonical reconciliation without replacing their receipt or original source. Fixed-snapshot promotion proof, schema-18 source admissions, account-pinned reads and exact native write plans preserve pending cash/stock, later offline edits and images through retries, quota failure and revocation. An original owner and joined manager converge in native browser checks. Full cloud controls and remaining M30/M31 acceptance stay gated.

- M31 joined devices can now apply canonical downloads while retaining original offline cash, credit and stock intents. Exact native transactions preserve original queues and images, separate immutable join admission from the current base, and roll back on quota, stale scope or unexplained writes. Two native browsers converge through the SQL-backed HTTP services without duplicate money, stock or outgoing echoes. Schema 17 adds an internal application journal; original-upload adoption, other pending families, realtime and full cloud controls remain gated.

- M30/M31 can now join an existing outlet on an empty device through the internal sync engine. A complete canonical snapshot, original images, accepted cursor, actual operator and distinct join fence commit atomically without an upload receipt or outbox echo. Historical member references preserve owner-authored financial records without exposing unassigned staff contact details. Schema 16 retains existing uploads and queues; pending-work reconciliation and full cloud controls remain gated.

- Sync groundwork now preserves original saved actions, attachments and recovery evidence while checking which changes are already present online. Interrupted replies, offline reloads and conflicting receipts retain the original work. Full cloud sync remains in development and unavailable by default.

- M30 image downloads now retain fully verified original bytes beside their sealed metadata. Schema 14 adds an immutable internal image cache with exact per-image retries, offline verification and native transaction guards; existing shop data, operator selection, upload receipts and queued cash remain intact. The image boundary rejects anonymous phone accounts. Canonical application and full cloud controls remain gated.

- M30 explicit outlet/member selection now attributes local actions to the chosen owner or manager, retains real assignments, guards owner settings, and supports multi-outlet backup recovery. Schema 13 adds an internal operator table while portable backups stay unchanged. Fresh authenticated metadata discovery, bounded runtime RPC transport and durable sign-out/account locks prepare the canonical sync boundary; full cloud controls remain disabled.

- Credential guards now inspect Windows UTF-16 files in both byte orders, with or without a byte-order mark, including ZIP downloads. All 23 security tests pass, including a real rejected commit of a PowerShell credential file. Existing commit, push and build guards remain enabled; GitHub Actions remain stopped.

- M30 downloads now retain their original request, immutable pages and verified records in the shop's IndexedDB. Schema 12 preserves existing images, upload receipts and queued actions; portable backups remain unchanged. Cross-page fragments, complete hashes, exact retries and integrity seals support empty devices, offline reload, concurrent tabs and storage recovery without applying records or advancing an accepted cursor. Cloud controls remain gated.

- M30 durable download captures original scoped changes and tombstones in their source transactions. Fixed PostgreSQL snapshot windows, hashed fragments, bounded gzip responses and signed cursors retain large records and exact retries. Owner/manager access is checked before body reading and again on cached pages. The runtime transport remains separate from shop writes; canonical application and sync activation stay gated.

- Credential checks now compare the dedicated server cursor-signing key from private configuration, including staged files, history and generated output. No deployment value is added to source or public build variables.

- M30 canonical download groundwork now validates PostgreSQL snapshot cursors without losing 64-bit precision or skipping a transaction that commits late. A PostgreSQL oracle and overlapping read-only hosted transactions verify the primitive. Change-feed delivery, reconciliation and cloud activation remain gated.

- M30 legacy supplier sent records now queue their original message and audit identities before correction. Hosted saves bind the complete literal assertion, recheck owner/manager outlet access and preserve physical time without inventing hand-off history, sending messages or changing stock/money. Exact retries and lost correction replies retain their original ordering. Cloud activation remains gated.

- M30 generated shop links and undo now retain their original reviewed URL, publication identity and audit in the local queue. Hosted saves preserve frozen snapshots, log the URL replaced by last-write-wins, and use original occurrence time for delayed offline undo. Queue failures leave the form ready to retry; first-use compound transactions stay atomic. Cloud activation remains gated.

- M30 profile settings now join the local queue with their original audit identities. Saves retain owner outlet assignments, preserve timestamps through backwards device clocks and leave historical money/catalogue records intact. Hosted owner-only updates keep shop contact and Auth login phones separate. Cloud activation remains gated.

- M30 reminder wording and export preparation now join the local change queue with their original audit identities. A prepared JSON backup stays downloadable if its history cannot be saved. Importing another shop after a cancelled upload preserves previous recovery data and allows a new review. Cloud activation remains gated.

- M30 upload review recovery: refreshing counts preserves every original snapshot, and an active upload keeps its exact source through reload, concurrent tabs and lost acknowledgements. A durable selection survives backwards clocks; missing or damaged evidence offers read-only recovery. Stale chunk acknowledgements retain verified progress. Cloud controls remain gated.

- M30 catalogue queue: create, edit, availability, delete and guarded sample removal retain original outlet/item/category/audit IDs and occurrence times. Full-size paste keeps one atomic local transaction and ordered resumable item commands. Hosted preparation binds the complete normalized input, and older unplanned catalogue RPC grants are closed. Cloud controls remain off; credentials and actual deployment values stay outside source and static output.

- M30 Inbox queue: original manual and worker captures now retain typed commands with their literal sources, image IDs, creation times and complete manual sorting history. Full image hashes are computed before the writer opens; bytes remain local. Queue/audit failures roll back the whole action, and missing Web Crypto retains images for review without blocking local saving. Text-only recovery checks keep their backup reader inside the active transaction. Cloud controls remain off.

- M30 manual-message queue: preparation, Open/Copy/failure, explicit Sent and undo now retain typed commands with complete original history. Sent commits its credit, order or supplier companion in the same transaction and queue entry; supplier resends reuse the original confirmation. Failed queue/audit writes roll back the whole action, while Copy remains available when preparation cannot be saved. Supplier correction keeps its new audit ID. Cloud controls remain off.

- M30 order queue: creation/editing, compound save-and-pay, all four status flows and undo, notes/contact history, payments and corrections, cancellation/refunds and warning settings now save typed intents with their original local records and audits. Compound writes use one command and one occurrence time. Correcting an old receipt cannot undo a newer payment. Legacy payments missing their optional occurrence field remain locally undoable and retained for review; no remote time is invented. Cloud controls remain off.

- M30 local command adapters: customer profiles and khata settings, stock changes and physical-count batches, suppliers, full invoices and day closing now retain executable intents alongside their original local records and audits. Closing undo keeps its own companion audit IDs. Failed queue writes roll back the complete action. Catalogue, order, hand-off and Inbox adapters, reconciliation and the complete upload interface remain unfinished; cloud setup stays gated.

- M30 upload boundary: a same-database local queue retains every later shop write, including the share worker and narrow transactions, while an immutable reviewed snapshot uploads. Counter, credit, payment and manual communication intents retain their original record IDs and durable receipts. Unsupported writes remain local for review and stop ordered delivery. Confirmed staging cancellation preserves recovery history. Sync metadata stays out of JSON backups; full upload controls, remaining adapters and canonical reconciliation are still gated.

- M30 phone sign-in (behind `cloudSetup`): device-only runtime connection settings, official phone OTP/session refresh, verified-user checks, cross-tab sign-out and a saved local record-count review. Connection values and Auth tokens are excluded from shop backups and static builds. The production phone provider, initial upload activation and outbox remain unfinished; no SMS or cloud write starts automatically.

- M30 Inbox transactions: original source text, creation times and image metadata keep their device identities. Manual classification, archive and reopen retain complete history and reject stale reviews. Unchanged choices retain the source revision and an original-actor replay receipt. Capturing metadata leaves image bytes pending private upload and never records orders, money or stock. Cloud controls remain unavailable.

- M30 manual messages: preparation, Open/Copy/failure, explicit Sent and undo retain complete attempt history. Sent commits its credit, order or supplier communication together; supplier resends reuse the original confirmation and never receive stock or change debt. Cloud controls remain unavailable.
- M30 day closing: the complete reviewed Today snapshot, cash difference and optional walk-in receipt retain device IDs and commit with their audits. Same-day undo retains the original closing, reverses only its linked surplus receipt, and preserves later sales. Original occurrence days and live undo limits remain distinct; sync controls stay unavailable.
- M30 preparation: scoped access, original-image transfers, audited catalogue edits, customer/khata saves, counter receipts, khata payments, availability changes with undo and resumable reviewed uploads are prepared. Customer and financial commands retain device record IDs, and financial records retain their occurrence times. Rows, audits and receipts commit together. Sign-in, sync and cloud interfaces remain unavailable while the full milestone is in progress.
- M30 stock commands: item saves/archive/restore, relative movements, physical counts, atomic batches of up to 1,000 items and guarded undo retain device IDs and original movement times. Relative movements can merge across newer relative changes; a newer physical count requires review. Larger batches require an authenticated outlet check before their body is read.
- M30 supplier/invoice commands: supplier saves/archive/restore, complete 200-line priced invoices and ten-minute invoice undo share the local validation and retain device IDs. Recording an invoice leaves stock, counter sales and customer debt unchanged; receiving stock remains a separate reviewed action. Larger invoices require an authenticated outlet check before reading their body.
- M30 order identities: shared lifecycle commands accept stable device record and companion-audit IDs. Credit reversals keep their original charge/refund links; new order lines cannot reuse an existing line identity. Sync controls remain unavailable.
- M30 order transactions: scoped create/edit and compound save-and-pay, statuses/undo, notes/contact history, settlements, cancellation/refund correction and warning settings share the local domain. Complete 200-line orders use authorized body admission. Original IDs, linked money, audits and replay receipts commit together; credit-payment reversals retain explicit order/sale links. Sync controls remain unavailable.
- M24 interface (behind `shareTarget`): opt-in Android share manifest, bounded offline POST receiver, local Inbox with source-image previews and manual-add fallback, reversible sorting/archive, and editable order/payment/invoice/stock forms. The standard install remains unchanged while installed Android acceptance is pending.
- M24 storage foundation (behind `shareTarget`): local shared-text and image records, reversible manual classification/archive, atomic audit history, and byte-preserving JSON image backups. Schema 10 upgrades existing databases and imports schema-7/8/9 backups. Installed Android acceptance remains open.
- M23: a shared hand-off for receipts, reminders and calls, order quotes, supplier requests, summaries, shop links and customer messages. Reviewed text and explicit send progress resume offline; opening or copying leaves confirmation to the sender.
- M23 recovery: manual Copy remains available when storage or the clipboard fails, long messages keep every part, and customer requests retain form choices and photo reminders. Forget clears the customer’s local trail; backups retain owner message history.

- M22 (behind `qrPosters`): saved-link QR posters and counter cards, market scan copy, offline local fonts, PNG download/open and native PDF printing at A5 or counter-card size.
- M20: bounded public shop links, bilingual structured order messages, audited generation and ten-minute undo; Shop link settings with item selection, preview and copy/share fallbacks. The public customer page supports lists/menu choices, optional voice and photo preview, remembered details/last request, fulfilment/time and WhatsApp/Copy/manual completion, with a separate offline worker and a complete page budget below 60 KB.
- M21: paste English/Bangla customer requests into editable order drafts, with explicit count/unit suggestions, unsaved counter pricing, clipboard/manual fallbacks and owner-confirmed creation. Complete original requests survive order saves and JSON backup/restore; payment preferences never record money.

### Fixed

- First-time offline setup now finishes when you navigate while it is preparing. Your open cash calculation stays in place, and app updates still wait for your Reload action.

- Phone sign-in: the saved challenge and displayed resend cooldown now share one timestamp, preserving the exact cooldown across reloads.

- Supabase client compatibility: pin the official SDK and require Node 22.12+. Only owner-app pages allow runtime HTTPS API connections; public shop and marketing policies retain their restricted connections. Workflow templates are updated while GitHub Actions stays disabled.

- Supabase privacy: local commit, push, lint and production checks automatically compare private deployment values from clone-local Git configuration. Plain project/organization IDs and prefix-free PIN peppers are checked without committing configuration or printing values. An unavailable private input blocks the scan.

- Preserve required audit JSON nulls when reading SQL rows, so original message attempts and deletion snapshots reconstruct without losing their before/after fields.
- Decode escaped stock-name and closing-day keys without adding an extra layer of quotes; literal Bengali, NUL and surrogate data survive the cloud codec.
- Return expected catalogue conflicts promptly as HTTP 409, with bounded server retries for changed snapshots.
- Keep deployment credentials and project-specific operational details out of the repository; local lint now checks for accidentally committed secrets.
- Check for exposed credentials before local commits, pushes and production builds, including Git commit/tag messages and filenames; audit reports redact matched values.
- M23 recovery: immediate customer-detail saves cancel their older debounce so storage failure cannot overwrite the latest Copy/manual-selection notice.

## [0.2.0] - 2026-11-16

### Added

- M10: business and market packs, three-question setup, phone navigation, desktop sidebar, local settings and an audited IndexedDB workspace.
- M11: catalogue editing, local item names, exact prices, categories, availability, search and reviewed bulk paste.
- M12: cash-first counter, calculator keypad, given/change, optional customer/items, manually confirmed wallet/card payments, receipts, QR and sales-log undo.
- M13: customers and khata, balances and limits, explicit over-limit choices, payments/corrections, history, and bilingual reminder/receipt handoffs.
- M14: manual orders, queue/board, customer lookup and usual orders, typed-item pricing and swaps, fulfilment/status history, warnings, payment, cancellation and refunds.
- M15: stock targets and pack-rounded needs, reviewed quick updates, night counts, movement corrections, suppliers and bilingual order drafts.
- M16: record-derived Today totals and payment splits, waiting orders, low stock, due reminders, reviewed cash closing, saved summaries and same-day undo.
- M17: six datasets in CSV, Excel and PDF with dates/columns and masked phone fields; complete twenty-table JSON backup, reviewed atomic restore and native file sharing with download fallbacks.
- M18: installable manifest and original Mise icons, install guidance, offline relaunch, explicit updates, native storage-protection requests and direct backup/restore access.

### Fixed

- Credit tanziro.com in both regional landing footers.
- Explicit app updates reload only the requesting tab after its worker takes control, preserving another tab’s open form.

## [0.1.1] - 2026-11-15

### Refinement pass

- R0: supplied Figma exports and updated design requirements, a single `@figma` asset source, required-export checks in CI, and a manual Figma refresh workflow.
- R1: one Figma picture pipeline with AVIF / WebP / PNG at 1× and 2×, all drawn product previews removed, source and payload guards, and exported icons.
- R2: calm light navigation and hero for both regions, regular 56px desktop type, one exported phone, responsive reading order, and a light mobile menu with keyboard support.
- R3: full-size alternating detail images, six evenly spaced day screens with a phone scroll-snap row, and equal-height business cards aligned to the supplied exports.
- R4: regular section type, reference backgrounds and spacing, horizontal before/after cards, compact capture/check panels, a left-aligned CTA and a simpler footer; both gradients removed.
- R5: native phone disclosures for workflow steps and extra checks, two-column basics/business cards, compact phone spacing, 44px touch targets, and regional landing pages under 20,000px at 390px.
- R6: reference-based setup/downloads with four desktop device cards, a focused five-step phone guide, native guide disclosures, manifest-backed availability and checksum copying; new 1200×630 hero share images for both regions.
- R7: reusable section capture and Figma comparison reports with informational pixel differences, automatic config discovery for app milestones, CI artifact uploads and PR evidence requirements. Mobile Lighthouse: BD 95 / Intl 98 performance; accessibility, best practices and SEO 100.

## [0.1.0] - 2026-11-15

### Added

- Original Mise handover, copy and brand assets.
- M00: pnpm monorepo, strict TypeScript, static Astro site and React app placeholder, portable build, CI and GitHub Pages deployment.
- M01: shared Astro and React primitives, Lucide icons, token-mapped Tailwind theme, self-hosted Geist / Geist Mono / Hind Siliguri, and an opt-in UI gallery.
- M02: complete Bangladesh product page using the supplied copy, twelve detailed workflows, responsive product previews, accessible mobile navigation, and About / Privacy pages.
- M03: international page from shared components, remembered region switcher, non-blocking region routing with configurable country lookup, and canonical / hreflang metadata.
- M04: regional social cards and screenshots, mobile Lighthouse targets, copy fallbacks, optional analytics hook (off), sitemap / robots, and a build-time content security policy.
- M05: setup and downloads guide, runtime manifest with validated checksums and stable download links, installation instructions, artifact publishing skeleton, and self-hosting guide / agent prompt.
