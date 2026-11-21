# 03 · Roadmap and rollout order

## How milestones are ordered
Each milestone is scored on three things:

- **Dependency tier** (the most important):
  - T0 static
  - T1 one device (browser storage)
  - T2 backend + sync
  - T3 device integrations (browser extension, Android)
  - T4 AI agents and third-party APIs
- **Effort:** S ≤ 1 day · M 2–4 days · L 1–2 weeks (agent time, roughly)
- **Value:** how useful it is to a real shop on its own

Rule: **lower tier first; within a tier, smaller effort and higher value first.** A milestone may only use what earlier milestones shipped.

Each milestone is deployed to GitHub Pages when merged, and tagged when a phase completes. Unfinished UI sits behind a flag.

## Phase 0 — Foundation and landing (T0) → tag `v0.1.0`
Spec: `phases/phase-0-landing.md`

- [x] **M00** Repo, monorepo, CI, Pages deploy skeleton · S · T0
- [x] **M01** Design tokens + base UI primitives in `packages/ui` · S · T0
- [x] **M02** Landing: Bangladesh page, all sections, static · M · T0
- [x] **M03** Landing: International page from the same components + region router + hreflang · S · T0
- [x] **M04** Landing polish: screenshots, Lighthouse targets, OG images, phone layouts · S · T0
- [x] **M05** Setup & downloads page (`/setup/`) reading `downloads/manifest.json`; `downloads/` folder + artifacts workflow skeleton · S · T0

## Phase R — Refinement before the app (T0) → tag `v0.1.1`
**Blocking: do not start M10 until every item is ticked.** Spec: `09-refinement-appendix.md` (added 15 Nov 2026 after the owner's review of the live site).

- [x] **R0** Figma exports in the repo, `pnpm check:exports` in CI, Figma export workflow installed · S · T0
- [x] **R1** `<Shot>` image pipeline (AVIF/WebP/PNG); delete every hand-drawn mockup; CI guard · M · T0
- [x] **R2** Nav + hero rebuilt to the new calm Figma hero (both regions) · S · T0
- [x] **R3** Product images in Operations in detail (12), A day with Mise (6), Businesses (4) · M · T0
- [x] **R4** Section-by-section match: 40 px Regular headlines, backgrounds, no gradients · M · T0
- [x] **R5** Phone pass: no overflow at 360–414, page ≤ 20,000 px at 390 · M · T0
- [x] **R6** Setup page matches Figma; remove ®; new OG images · S · T0
- [x] **R7** Visual QA harness (`pnpm qa:visual` → `qa/report.html`), required on every UI PR from now on · S · T0

## Phase 1 — Useful on one device (T1) → tag `v0.2.0`
The app at `/app/`. Works offline. Data in IndexedDB. Spec: `phases/phase-1-local-app.md`

- [x] **M10** App shell: routes, desktop sidebar, phone bottom nav, business + market packs, onboarding (3 questions) · M · T1
- [x] **M11** Catalogue / business data CRUD (items, prices, categories, available toggle) · S · T1
- [x] **M12** Counter calculator: amount entry, cash in one tap, given/change, optional "who", sales log · S · T1
- [x] **M13** Customers + khata (credit): limits, entries, payments, balances, WhatsApp/copy reminder · M · T1
- [x] **M14** Manual orders + queue: new order (source, customer, items, delivery/pickup, payment), statuses, order detail · M · T1
- [x] **M15** Stock: items, on hand, target (par), to order; quick-update parser ("used 2 kg chicken"); night count mode · M · T1
- [x] **M16** Today dashboard (sales split, waiting, low stock, credit given/collected) + closing cash count · S · T1
  - [Delivery notes and verification](../../docs/m16-delivery.md).
- [x] **M17** Exports (CSV, XLSX, PDF) + JSON backup/restore · S · T1
  - [Implementation and verification notes](../../docs/m17-delivery.md) (complete).
- [x] **M18** PWA: install, offline, update prompt, storage persistence request · S · T1
  - [Delivery notes and verification](../../docs/m18-delivery.md).

## Phase 2 — Customer links without a backend (T0/T1) → tag `v0.3.0`
Spec: `phases/phase-2-links-no-backend.md`

- [x] **M20** Public shop page + order link: menu or "type what you need", photo attach (preview only), pickup/delivery → "Send on WhatsApp" with a structured message · M · T0
  - [Implementation and verification notes](../../docs/m20-delivery.md) (complete).
- [x] **M21** Paste-to-order: paste a WhatsApp order message (from M20 or free text) → parsed draft order · S · T1
  - [Implementation and verification notes](../../docs/m21-delivery.md) (complete).
- [ ] **M22** QR posters and counter cards (printable PDF/PNG) for the shop link · S · T0
  - [Implementation and verification notes](../../docs/m22-delivery.md) (behind `qrPosters`; physical print/scan acceptance pending).
- [ ] **M23** Hand-off pattern everywhere: deep link + Copy + "I sent it" for reminders, receipts, win-back · S · T1
  - [Implementation notes](../../docs/m23-delivery.md) (source enabled by default; all local checks pass, with default-on Pages publication stopped by owner).
- [ ] **M24** Share target (Android PWA): share text/images into Mise → inbox to sort manually · S · T1
  - [Unassigned source recovery and explicit outlet review](../../docs/m24-local-inbox.md) keep signed-out shares local, preserve original bytes and allow unrelated work to sync before assignment. Installed Android acceptance and publication remain open.
  - [Implementation notes](../../docs/m24-delivery.md) (receiver, local Inbox, manual forms and image backups implemented behind `shareTarget`; installed Android acceptance and publication pending).

## Phase 3 — Backend and sync (T2) → tag `v0.4.0` = v1
Spec: `phases/phase-3-backend-sync.md`

- [ ] **M30** Supabase project, schema, row-level security, phone OTP + device PIN, outlet/roles · L · T2
  - [Git history privacy](../../docs/security-history.md) blocks new identifiers in commits, tags, refs and old filename aliases. Exact reviewed nonsecret exceptions preserve published history; credentials always block. Hosted and remaining M30 acceptance stay open.
  - [Original-owner connection recovery](../../docs/m30-owner-resume.md) restores the original verified sign-in after accepted upload and before first download, preserving the source, receipt, queue and complete images. Native selection/activation and interrupted completion are guarded; full M30 acceptance remains open.
  - [Implementation notes](../../docs/m30-delivery.md) (dedicated project, 45 migrations, PIN/screen/image services, private bucket, catalogue/customer/khata saves with device-generated related IDs, audited counter/credit/payment/undo, atomic stock, supplier/invoice, order, closing, complete manual hand-off, original Inbox capture/sorting commands and order/counter/khata/invoice financial review deployed; local snapshot/recovery and authenticated hosted upload staging/promotion prepared. Phone OTP, positive signed-owner HTTP upload/writes, app/outbox interfaces and staff/agent resources remain open).
  - [Complete order transactions](../../docs/m30-order-commands.md) retain shared lifecycle and linked financial identities; no sync controls are enabled.
  - [Reviewed day closing](../../docs/m30-closing-commands.md) retains the full Today calculation, linked surplus receipts and original-timezone same-day undo.
  - [Complete manual message transactions](../../docs/m30-handoff-commands.md) retain exact drafts, explicit Sent companions, canonical attempt generations and guarded corrections. Clone-local credential checks also run automatically before commits, pushes and builds.
  - [Original Inbox captures and manual sorting](../../docs/m30-inbox-commands.md) retain literal sources, immutable pending image metadata and complete reversible history without recording money or orders.
  - [Runtime phone sign-in and private configuration](../../docs/m30-auth-interface.md) add an opt-in device connection, OTP/session interface and saved local count review. Real OTP commissioning, initial upload activation and outbox integration remain open; M30 stays unticked.
  - [Same-database upload and change queue](../../docs/m30-outbox-boundary.md) retain concurrent local edits, worker images and financial intent identities through retries and confirmed cancellation. Remaining command adapters, canonical reconciliation and full upload controls stay gated; no sync interface is enabled.
  - [Local domain command adapters](../../docs/m30-domain-adapters.md) retain customer/khata, stock/count, supplier/invoice and closing intents in their original local transactions. Canonical reconciliation, unsupported write adapters and full upload controls remain open.
  - [Local order queue](../../docs/m30-order-outbox.md) adds complete order/financial commands, compound save-and-pay, source receipt guards and preserved local legacy undo. Canonical reconciliation, unsupported write adapters and full upload controls remain open.
  - [Local manual-message queue](../../docs/m30-handoff-outbox.md) keeps preparation, choices, complete Sent companions and supplier corrections in their original transactions. Canonical reconciliation, legacy direct writes and full upload controls remain open.
  - [Original Inbox source queue](../../docs/m30-inbox-outbox.md) adds typed manual/worker captures and reversible sorting with original IDs and full image hashes. Bytes remain local; missing Web Crypto retains the source for review. Unsupported writes, reconciliation and complete upload/image delivery controls remain open.
  - [Catalogue device intents and local queue](../../docs/m30-catalogue-outbox.md) preserve original outlet/item/category/audit identities and times, full-size atomic local paste and resumable per-item receipts. Hosted plans bind full normalized values and retire older unplanned RPCs. Canonical reconciliation, unsupported writes, full upload controls and actual OTP/owner HTTP acceptance remain open.
  - [Original upload-review recovery](../../docs/m30-upload-review.md) preserves the bound snapshot before the first acknowledgement, across tabs/reload and after lost responses. Durable review selection and merged chunk progress retain evidence; damaged/missing originals require read-only recovery. No sync control or hosted service is activated.
  - [Reminder wording, export preparation and backup recovery](../../docs/m30-settings-commands.md) add two typed command families with atomic local history and bound hosted completion. A prepared backup stays downloadable after audit/storage failure; cancelled connections allow a fresh review for an imported shop while retaining the old source/queue. Legacy supplier writes, full cloud controls and remaining acceptance gates stay open.
  - [Owner profile and market settings](../../docs/m30-profile-commands.md) retain atomic original local saves, owner-only hosted updates and separate contact/Auth phones without changing other outlets, assignments or permissions. Legacy supplier adapters, reconciliation, full cloud controls and remaining acceptance gates stay open.
  - [Original shop-link publications and undo](../../docs/m30-link-commands.md) retain the exact approved URL/code/edition, server-time losing-value history, original-time guarded undo and atomic local queue/audit recovery. Legacy supplier writes, canonical reconciliation, full cloud controls and remaining acceptance gates stay open.
  - [Original legacy supplier assertions](../../docs/m30-supplier-message-commands.md) now retain their standalone sent record, literal fields, physical time and audit before the existing correction, without inventing hand-off history. Canonical reconciliation, full cloud controls and remaining acceptance gates stay open.
  - [Canonical cursor groundwork](../../docs/m30-sync-snapshot.md) retains PostgreSQL snapshot visibility and full 64-bit precision through late commits. The cursor primitive is verified; feed delivery, active-member selection and no-echo canonical application remain open.
  - [Durable scoped download](../../docs/m30-sync-feed.md) adds atomic projected change capture, fixed snapshot windows, hashed byte fragments, cached-page revocation checks and signed runtime cursors. Canonical application, active-member selection, image delivery and full cloud controls remain open.
  - [Explicit outlet/operator recovery](../../docs/m30-operators.md) adds real local manager attribution, multi-outlet backup recovery, fresh authenticated metadata discovery and durable account/sign-out locks. Schema 13 preserves earlier queues/downloads; new-device join, canonical reconciliation and full cloud controls remain open.
  - [Verified original image downloads](../../docs/m30-sync-images.md) stage complete bytes in schema 14 with exact retries, offline hashes and native rollback guards. Private image access now requires a confirmed, non-anonymous phone account. Canonical application, legitimate join and full cloud controls remain open.
- [ ] **M31** Sync engine: local-first outbox, realtime pull, conflict rules · L · T2
  - [Saved customer and khata review](../../docs/m31-customer-review.md) compares original details, terms and opening balances with scoped current records. Deliberate choices preserve financial parents and complete source through lost replies, offline reloads and account changes. All 3,361 unit tests, 483 browser cases, 320 visual comparisons and both build paths pass. The reviewed migrations and exact JWT-verified function are deployed; all 68 application tables force RLS, 20 managed SQL-role cases roll back cleanly, and 32 actual anonymous probes are denied. M30/M31 remain open; cloud flags, workflows and Pages stay held.
  - [Saved stock review](../../docs/m31-stock-review.md) compares original stock actions with current quantities, units, count history and supplier selections. Explicit choices preserve the source through lost replies, offline reloads and account changes. All 2,964 unit tests, 479 browser cases, 305 visual comparisons and both build paths pass. The reviewed migration and exact JWT-verified bundle are deployed; all 66 application tables force RLS and 25 actual anonymous probes are denied. M30/M31, other conflict families and genuine hosted/physical acceptance remain open; cloud flags, workflows and Pages stay held.
  - [Saved stock metadata](../../docs/m31-stock-metadata.md) applies server-ordered description and archive choices over current stock without replacing quantity, unit, count history or original queue bytes. All 2,778 unit tests, 475 browser cases, 290 visual comparisons and both build paths pass. The reviewed migration and exact JWT-verified bundle are deployed; all 64 application tables force RLS and eighteen anonymous probes are denied. Physical counts and undo retain their review rules. M31, other conflict families and genuine hosted/physical acceptance stay open; cloud flags, workflows and Pages remain held.
  - [Saved invoice review](../../docs/m31-purchase-review.md) adds an original-currency comparison, explicit withdrawal/replacement and a token-free native journal. Original invoice identities, prices, images and undo clocks stay intact through lost replies, offline reload, account changes and stopped requests. All 2,756 unit tests, 472 browser cases, 290 visual comparisons and both build paths pass. The migration and exact JWT-verified function are deployed; all 64 application tables force RLS and fourteen anonymous probes are denied. M30/M31, other financial families and genuine hosted/physical acceptance remain open; cloud flags, workflows and Pages stay held.
  - [Original customer account identity](../../docs/m31-customer-account.md) retains contact and terms edits across a later shop currency change, using the existing scoped khata without creating financial records for contact-only work. All 2,699 unit tests, 468 browser cases and 278 visual comparisons pass; the reviewed migration and exact JWT-verified function are deployed. Ten anonymous probes are denied. M30/M31, other financial conflict families and broader hosted/physical acceptance remain open; cloud flags, workflows and Pages stay held.
  - [Original customer credit currency](../../docs/m31-customer-currency.md) binds opening balances and limits to original khata/entry images, preserving historical settings, genuine covered outcomes and offline backup. Contact-only sources cannot create a financial account without a unit. Local verification passes 2,689 unit tests, 466 browser cases and 278 visual comparisons; the exact JWT-verified function is deployed and nine unauthenticated requests are denied. Other financial conflicts and broader hosted/physical acceptance remain open; cloud flags, workflows and Pages stay held.
  - [Original invoice currency](../../docs/m31-purchase-currency.md) binds delivery and pending replay to immutable invoice units, preserving historical undo, genuine coverage, original images and offline backup. Local verification passes 2,669 unit tests, 462 browser cases and 278 visual comparisons. The exact reviewed JWT-verified function is deployed with eight unauthenticated requests denied. Other financial families and wider hosted/physical acceptance remain open; cloud flags, workflows and Pages stay held.
  - [Counter and khata financial review](../../docs/m31-money-review.md) adds explicit original-currency withdrawal/replacement, separate current credit consent and a durable token-free native review. Local verification passes 2,654 unit tests, 458 browser cases and 278 visual comparisons. The reviewed migration and JWT-verified commands source are applied; all 62 application tables enforce RLS and seven unauthenticated probes return 401. Other financial families and genuine hosted/physical acceptance remain open; cloud flags, workflows and Pages stay held.
  - [Original currency during pending replay](../../docs/m31-pending-currency.md) checks immutable queue units before canonical or full-scope recovery projections. Conflicts retain original money, images and cursor; covered historical money and valid same-currency replay remain usable. Financial resolution and full acceptance remain open; cloud flags and workflows stay off.
  - [Original counter and khata currency](../../docs/m31-money-currency.md) binds normal money delivery to immutable saved sale/entry units without changing commands. New mismatches and profile races retain work; historical payments/undo and actual receipts remain valid. Non-order resolution and full acceptance stay open; cloud flags and workflows remain off.
  - [Original order currency](../../docs/m31-order-currency.md) binds normal delivery to the original source currency outside unchanged commands. Mismatched units and commit-time profile races retain the order; historical cash and actual completed receipts remain valid. Other financial families and hosted acceptance stay open; cloud flags/workflows stay off.
  - [Saved order review interface](../../docs/m31-order-review-interface.md) compares actual current values and monetary effects, journals explicit choices without tokens and recovers genuine outcomes after lost replies/offline reload. Original source and later cash converge through actual native UI/SQL flows. Other financial families and full hosted acceptance remain open; cloud flags/workflows stay off.
  - [Order financial review protocol](../../docs/m31-order-resolution.md) adds current-value review and distinct server-authorized withdrawal/replacement outcomes, retaining original source and financial identities through lost responses and canonical convergence. Other financial families and full hosted acceptance remain open; cloud flags stay off.
  - [Rejected-action review evidence](../../docs/m31-action-reviews.md) retains an account-bound HTTP observation with the exact original financial command, source and accepted receipt prefix across offline reload. Confirmation requires a genuine later receipt; explicit financial resolution and full milestone acceptance remain open.
  - [Shares received before setup or joining](../../docs/m31-join-share.md) retain their original text/images through one manager phone verification and can be explicitly claimed offline before the first canonical application. Native browser convergence preserves the source and cash; physical, hosted and publication gates remain open.
  - [Existing-outlet scope recovery](../../docs/m31-scope-recovery.md) preserves the original shop, upload/join admission, commands and complete images through a freshly authorized full review. Lost activation resumes independently; portable backups remain unchanged. Cloud flags stay off and full M30/M31 acceptance remains open.
  - [Concurrent original domain intents](../../docs/m31-concurrent-intents.md) append original notes and Sent companions, apply nonfinancial order/supplier sets in server admission order and merge independent Inbox fields with full original images. Frozen-window projections retain later local action times without inventing server clocks or receipts. Financial/review conflicts, changed-scope recovery and genuine hosted acceptance remain open; workflows stay stopped.
  - [Pending domain actions and original image delivery](../../docs/m31-pending-intents.md) project every currently typed command family over fixed downloads without rewriting sources or receipts. Complete image uploads, guarded retries and separate upload-audit validation support native two-browser convergence. General concurrent revision merges, changed-scope recovery and genuine hosted acceptance remain open; workflows and Pages publication stay stopped.
  - [New-device join](../../docs/m31-join-runtime.md) adds explicit live outlet discovery, one phone verification, a durable original selection, resumable downloads/images and guarded atomic admission into automatic sync. Existing-shop scope recovery, remaining conflict families and genuine hosted acceptance stay open; no workflow or Pages publication is started.
  - [Automatic sync and status](../../docs/m31-sync-runtime.md) connects the original upload review, account-pinned delivery, canonical application, durable retries and opt-in header controls. Insert-only outlet event hints wake verified cursor pulls; original sources and receipts remain intact. Other conflict families, existing-shop scope recovery and genuine hosted acceptance remain open.
  - [Original-account command delivery](../../docs/m31-command-account.md) pins both transports to the original live phone account and connection before and after HTTP. Ephemeral receipt checks and native operator/source guards retain pending actions through account changes after SQL commit or inside a locked receipt transaction; exact retries avoid duplicate cash. Other pending merges, existing-shop scope recovery and genuine hosted acceptance remain open.
  - [Original owner-upload adoption](../../docs/m31-owner-upload-adoption.md) brings the original uploading device into the same canonical engine without replacing its fence, receipt, snapshot or queue. Actual promotion visibility, complete source hashes and native transaction guards preserve offline work; original-owner and joined-manager browsers converge. Other pending merges, changed-scope recovery and genuine hosted acceptance stay open.
  - [Canonical application and offline convergence](../../docs/m31-canonical-apply.md) preserve original cash/credit/stock intents, images and admission while atomically advancing a joined device's working projection and accepted cursor. Native browsers converge through SQL-backed HTTP handlers with no duplicate money, stock or echo. Other unconfirmed families, existing-shop scope recovery and genuine hosted acceptance remain open; M31 stays unticked.
  - [Canonical empty-device join](../../docs/m31-canonical-join.md) installs a complete scoped model, original images, accepted cursor and actual owner/manager selection atomically with a distinct join fence. Historical member references preserve financial parents without contact leakage or invented assignments. The current interface and remaining acceptance are tracked in the new-device join and automatic sync notes above.
  - [Durable local download staging](../../docs/m30-sync-staging.md) preserves the exact request, pages and verified records across offline reload, concurrent tabs and storage failure. Same-database schema 12 retains original uploads/outbox/images; portable backups remain unchanged. The current operator, canonical application and convergence status is tracked above.
  - [Original receipt coverage](../../docs/m31-receipt-coverage.md) distinguishes visible, later, unknown and unconfirmed commands using real transaction/snapshot proof. Schema 15 retains exact batches without changing original queue entries; the current join, application and convergence status is tracked above.
- [ ] **M32** Kitchen / pack / counter screen on a second device; Got it / Ready; 2-minute unacknowledged alarm · M · T2
- [ ] **M33** Order link writes real orders (no WhatsApp step needed); live tracking page for customers · M · T2
- [ ] **M34** Staff: members, staff links ("My shift", "I'm here"), on-duty board, manual check-in · M · T2
- [ ] **M35** Customer's own khata page (read-only + "Pay with bKash" deep link + "Ask for more time") · S · T2
- [ ] **M36** Live store (owner/manager) + All outlets + roles · M · T2
- [ ] **M37** Inbox: questions, failures, chats needing a person; notifications via web push · M · T2

## Phase 4 — Capture automation (T3/T4) → tag `v0.5.0`
Spec: `phases/phase-4-capture.md`

- [ ] **M40** OCR v1 on the device (Tesseract.js, eng + ben): invoices, lists, prescriptions → editable lines · M · T1
- [ ] **M41** Payment text parser (bKash/Nagad/bank SMS pasted or shared) → match to order or credit entry · S · T1
- [ ] **M42** Start service checklist + device health · S · T2
- [ ] **M43** Chrome extension v1: reads Foodpanda/Pathao order tabs via site recipes → orders; side panel; **unpacked zip published to `downloads/`** · L · T3
- [ ] **M44** Completeness check (portal vs queue every 20 minutes) + "nothing missed" banner · M · T3
- [ ] **M45** Android order phone v1: notification listener (WhatsApp, bKash, Nagad, missed calls) → backend; **debug-signed APK published to `downloads/`** · L · T3
- [ ] **M46** Staff group listener (via M45): check-ins, stock notes → suggestions · M · T3
- [ ] **M47** OCR v2 (optional): server vision model via an edge function, behind a flag and with cost limits · M · T4

## Phase 5 — AI operator (T4) → tag `v0.6.0`
Spec: `phases/phase-5-ai-operator.md`

- [ ] **M50** Audit log + undo for every action (prerequisite) · M · T2
- [ ] **M51** Permissions (Watch / Ask / Alone per task) + limits + "who's handling" presence · M · T2
- [ ] **M52** Remote MCP server (Streamable HTTP + OAuth, scoped agent keys) with core tools · L · T4
- [ ] **M53** Agent console page (`/app/agent`) for browser-only agents · S · T2
- [ ] **M54** Connect-an-agent settings (Claude/Codex instructions, start prompt, test cycle, heartbeat + 15-minute alert) · M · T4
- [ ] **M55** Built-in checks engine (the 12 "When → Mise" rules) feeding the task queue · M · T2

## Phase 6 — Advanced → tags `v0.7+`
Spec: `phases/phase-6-advanced.md`

- [ ] **M60** Online shop: COD confirm, courier booking (extension fills forms), parcel tracking, payout reconciliation, returns · L · T3
- [ ] **M61** Plan: need vs have per hour, prep lists, events calendar · M · T2
- [ ] **M62** Performance (role-based, from recorded taps) · S · T2
- [ ] **M63** Guests: identity merge, segments, win-back sender · M · T2
- [ ] **M64** Teach-a-website (extension point-and-click recipes) · L · T3
- [ ] **M65** More market packs + full Bangla UI option · M · T1
- [ ] **M66** Native shell (optional): only if PWA limits block something · L · T3

## Rollout cadence
- Merge to `main` → deploy to Pages within minutes.
- Phase complete → git tag + GitHub Release with notes and screenshots.
- Keep a running "What's new" page at `/app/whats-new` generated from CHANGELOG.
