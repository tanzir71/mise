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
  - [Implementation notes](../../docs/m24-delivery.md) (receiver, local Inbox, manual forms and image backups implemented behind `shareTarget`; installed Android acceptance and publication pending).

## Phase 3 — Backend and sync (T2) → tag `v0.4.0` = v1
Spec: `phases/phase-3-backend-sync.md`

- [ ] **M30** Supabase project, schema, row-level security, phone OTP + device PIN, outlet/roles · L · T2
  - [Implementation notes](../../docs/m30-delivery.md) (dedicated project, 29 migrations, PIN/screen/image services, private bucket, catalogue/customer/khata saves with device-generated related IDs, audited counter/credit/payment/undo, atomic stock, supplier/invoice, order, closing, complete manual hand-off and original Inbox capture/sorting commands deployed; local snapshot/recovery and authenticated hosted upload staging/promotion prepared. Phone OTP, positive signed-owner HTTP upload/writes, app/outbox interfaces and staff/agent resources remain open).
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
- [ ] **M31** Sync engine: local-first outbox, realtime pull, conflict rules · L · T2
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
