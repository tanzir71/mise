# Phase 4 — Capture automation (T3/T4) → `v0.5.0`

Goal: data flows in without anyone typing. Order of work: on-device parsing first, then the browser extension, then the Android order phone. Each source keeps its manual fallback.

---

## M40 · OCR v1 on the device · M
**Figma:** M26 `106:484`, invoice capture `48:834`, C07 `111:519`

**Build**
- Tesseract.js in a web worker, with eng + ben traineddata lazy-loaded and cached.
- Flows:
  - supplier invoice → stock + purchase
  - handwritten list or prescription → draft order lines
  - screenshot → inbox
- Line-level confidence: low-confidence lines get a warning word ("Handwriting unclear, check"). Totals are checked against the sum.
- **Pharmacy safety:** prescriptions always require the seller to confirm each line. Mise never auto-sells.

**Accept**
- [ ] 15 fixture images: ≥ 80% of lines correct on clear printed invoices; everything editable before saving.

## M41 · Payment text parser · S
**Build**
- `payments.ts` regexes for bKash, Nagad and common bank SMS (fixtures in `packages/core/fixtures/payments/`).
- Pasted or shared payment text → Payment. Auto-match by amount and time window to an open order, sale or credit entry, or suggest the top 3 matches.

**Accept**
- [ ] 30 fixtures parse correctly. Unknown formats open manual entry, prefilled with the amount if found.

## M42 · Start service + device health · S
**Figma:** M30 `106:1011`, desktop `78:2928`, M11 `78:3328`

**Build**
- A checklist of enrolled devices and channels with live status.
- "Start service" sends a command to the extension (M43) to open its tab group, and asks the order phone (M45) to report.
- Fallback card: "Shop PC is off? Listen on this phone".

**Accept**
- [ ] Shows the true status of each device. Problems create tasks with fix actions.

## M43 · Chrome extension v1 · L
**Figma:** D06–D08 `48:834`, `49:940`, `51:1042`; Import system boards `43:42`, `47:185`

**Build**
- MV3 extension (`apps/extension`), side panel, sign-in with the Mise device token.
- **Site recipes** (JSON, versioned, fetched from the backend) for Foodpanda and Pathao Food vendor portals:
  - which URL patterns to watch
  - selectors for order ID, items, customer, totals, status
  - a parser
- Detected orders are posted as captures, then become orders (deduplicated by portal order ID).
- "Start service": opens a pinned tab group, checks each tab is signed in, and keeps it alive.

**Accept**
- [ ] With saved HTML fixtures of portal pages, recipes extract orders correctly (unit tests). A live test checklist is documented for the owner.
- [ ] If a recipe breaks (selectors fail), the extension raises a "recipe broken" task instead of failing silently.
- [ ] The unpacked zip is built by CI and committed to `downloads/` with `manifest.json` updated; it installs via Load unpacked following `/setup/`.

## M44 · Completeness check · M
**Build**
- Every 20 minutes the extension lists the portal's open orders and compares them with the queue.
- Missing orders → task + auto-add draft.
- "Nothing missed · checked 7:42 pm" banner on the queue and Live views.

**Accept**
- [ ] Simulated missing orders are flagged within one check interval.

## M45 · Android order phone v1 · L
**Figma:** M05 `58:118`, M11 `78:3328`

**Build**
- A Kotlin app (`apps/order-phone`):
  - onboarding asks for notification access for chosen apps only (WhatsApp, WhatsApp Business, bKash, Nagad, phone)
  - a foreground service; a battery-optimisation exemption prompt
- Posts normalised notifications to `POST /captures` with a device token. Offline queue.
- **Missed calls** → "Call back" task. **WhatsApp messages** → captures (order detection server-side, reusing `packages/core` parsers via the edge function).
- "I'm here" big button for staff check-in on the shared shop phone (M34 integration).

**Accept**
- [ ] On a test device: a bKash notification appears as a matched or suggested payment within 10 seconds.
- [ ] Survives a reboot; reports its health to Start service.
- [ ] A debug-signed APK (shared debug keystore) is built by CI and committed to `downloads/`. A newer build installs over the old one without data loss.

## M46 · Staff group listener · M
**Figma:** M23 `104:601`, desktop `70:1918`

**Build**
- From the order phone's WhatsApp group notifications, detect:
  - check-ins ("আমি এসেছি", "here", "in")
  - stock notes ("chicken প্রায় শেষ")
  - late notes
- These create suggestions that the manager confirms with one tap. Outbound posts (reminders) go through HandOff: drafted, a person sends.

**Accept**
- [ ] 40 fixture messages are classified with ≥ 90% precision. Nothing is applied without a confirmation, unless a rule says so.

## M47 · OCR v2 (optional, flagged) · M
**Build**
- An edge function calls a vision-capable model for hard images, with per-outlet monthly caps, a cost display and opt-in.
- Same output schema as M40.

**Accept**
- [ ] Behind a flag; caps enforced; falls back to v1 on error. Release `v0.5.0`.
