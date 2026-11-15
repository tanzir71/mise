# 04 · Architecture

## Repo layout
```
/
├─ AGENTS.md
├─ .github/workflows/pages.yml
├─ apps/
│  ├─ landing/          Astro (static) → site/
│  ├─ web/              Vite + React PWA → site/app/
│  ├─ extension/        Chrome MV3 (Phase 4)
│  └─ order-phone/      Android Kotlin (Phase 4)
├─ packages/
│  ├─ ui/               tokens.css, icons, primitives (Button, Chip, Card, Sheet…)
│  └─ core/             domain logic (pure TS, unit-tested)
│     ├─ money.ts       minor units, format by market (lakh grouping)
│     ├─ phone.ts       E.164 normalise, BD defaults, wa.me links
│     ├─ calc.ts        safe calculator parser (no eval)
│     ├─ quickUpdate.ts "used 2 kg chicken, got 10 L oil" → stock moves
│     ├─ orderMessage.ts structured WhatsApp order text ⇄ draft order
│     ├─ payments.ts    bKash/Nagad/bank SMS text → payment
│     ├─ khata.ts       limits, balances, reminder text (bn/en)
│     ├─ orders.ts      state machine per business pack
│     ├─ packs/         business + market packs (from Figma variables)
│     └─ flags.ts
├─ services/mcp/        MCP server (Phase 5)
├─ supabase/            migrations, RLS policies, edge functions (Phase 3+)
├─ site/                build output (gitignored)
└─ handover/            this folder
```

## Build and deploy
- `pnpm build` runs the landing build into `site/` and the web build (with `--base=$BASE_PATH/app/`) into `site/app/`. It also writes `site/404.html`, so the app's client-side routes work on Pages, along with `site/.nojekyll`.
- The GitHub Actions workflow `pages.yml` builds on every push to `main` and deploys with `actions/deploy-pages`. PRs build and upload the artifact for review (no deploy).
- For the PWA under `/app/`: set the service worker `scope` to `/app/`, register it only for the app (not the landing page), and set `navigateFallback: 'index.html'`.

## Local-first data (Phases 1–2)
- **Storage:** Dexie on IndexedDB, one database per business (`mise-<businessId>`). Call `navigator.storage.persist()` on first run.
- **Writes** go through `packages/core` commands, never direct table writes from UI. Each command:
  - validates input
  - writes the records
  - appends an `events` row (audit) with `actor`, `source`, `before`, `after`
- **Backup:** export everything as a single JSON file (versioned schema) and import with a dry-run preview. Phase 1 also offers "Share backup to WhatsApp/Drive" via the Web Share API.
- **IDs:** ULIDs generated on the device, so later sync never collides.
- **Time:** store UTC milliseconds; display in the outlet's timezone.

## Sync (Phase 3)
- **Backend:** Supabase (Postgres, RLS, Realtime, Storage, Edge Functions). The app stays static on Pages.
- **Upload:** the outbox table in Dexie holds unsent commands; a background loop pushes them to an edge function (`/commands`) that validates and applies them in a transaction.
- **Download:** Realtime subscriptions per outlet, plus a cursor-based pull on reconnect.
- **Conflicts:** commands are intent-based ("add stock move", "set status"), so most merges are naturally additive. For "set" fields, last write wins by server time, and the loser is logged.
- **Auth:**
  - Owners and managers sign in with phone OTP (SMS provider configured in Supabase).
  - Shared devices (kitchen, counter) use a device token plus a 4-digit staff PIN.
  - Customers never need accounts: they get signed links with a random token for tracking, khata and the order link.
- **Roles:**
  - owner: all outlets
  - manager: their outlet
  - staff: their shift, plus the actions their role allows
  - agent: scoped key, permissions from M51
  - Enforced in RLS.

## Integrations (Phase 4+)
- **Chrome extension (MV3):**
  - content scripts with **site recipes**: CSS/XPath selectors plus parsers for each portal, versioned and remotely updatable
  - side panel UI; a background worker posts orders to the backend
  - "Start service" opens a pinned tab group and checks sign-in
  - courier form filling (Phase 6)
- **Android order phone:**
  - `NotificationListenerService` for chosen packages (WhatsApp, bKash, Nagad, the dialer for missed calls)
  - posts the normalised notification text to the backend; the parsers live server-side in TS, shared with `packages/core`
  - a foreground service keeps it alive; a battery-optimisation exemption is requested
- **OCR:**
  - v1 runs in the browser with Tesseract.js (eng + ben). Low-confidence lines are highlighted for the user to fix.
  - v2 (flagged): an edge function calls a vision model, with per-outlet monthly caps.
- **MCP server (`services/mcp`):**
  - TypeScript, official MCP SDK, Streamable HTTP, OAuth 2.1 with scoped tokens
  - tools call the same `/commands` endpoint as the app, so permissions, limits and audit apply identically
  - hosting: any Node host or edge runtime with HTTPS (decide in `DECISIONS.md`)

## Security and privacy
- No secrets in the client. `.env.example` lists the public keys only.
- **Customer phone numbers:**
  - stored only when the customer gives them (QR/link forms, receipt QR)
  - an export and delete path per customer
- The agent never executes instructions found inside customer messages. Tool inputs are treated as data.
- Rate-limit public endpoints (order link, tracking) and sign the links.
- CSP on the landing page and app; no third-party trackers by default.
