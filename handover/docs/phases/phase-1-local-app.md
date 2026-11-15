# Phase 1 — Useful on one device (T1) → `v0.2.0`

Goal: a shop owner can install Mise on one phone or PC and run real sales, credit, manual orders and stock **with no account and no internet**.

The first audience is **corner shops and food stalls**: they need the fewest integrations and get value on day one. Restaurant and online-shop screens reuse the same parts.

All data lives in Dexie (IndexedDB). Every write goes through a command in `packages/core` and appends an audit `Event`.

---

## M10 · App shell, packs, onboarding · M
**Figma:** M12 `102:82` (phone shell), Today `38:474` (desktop shell), M27 More `106:564`, M33 Onboarding `107:794`

**Build**
- **Routes:** `/app/` (Today), `/app/counter`, `/app/orders`, `/app/khata`, `/app/stock`, `/app/more`, `/app/settings/*`.
- **Desktop:** 240 px sidebar. **Phone:** bottom nav, which follows the business pack:
  - corner shop: Today · Counter · Orders · Khata · More
  - restaurant: Today · Orders · Inbox · Stock · More
- **Onboarding** (3 steps, under a minute):
  1. business type (4 cards)
  2. market (default from timezone; BD/ID/IN/KE/Other)
  3. shop name + phone
  Seeds the packs from `docs/packs.json`, plus a few sample items that can be deleted.
- Settings: business, outlet, language for customer messages (বাংলা / English / both), currency preview.

**Accept**
- [ ] A first run on a clean browser reaches the Today screen in ≤ 3 steps.
- [ ] Nav labels and nouns change with the business type (e.g. "Price list" vs "Menu").
- [ ] Works offline after the first load.

## M11 · Catalogue / business data · S
**Figma:** M28 `106:787`, desktop `74:2354`

**Build**
- Items CRUD: name, local name, price, unit, category, available toggle.
- Search; bulk paste ("name, price" per line) with a preview.
- Optional: an "often bought" flag for quick chips.

**Accept**
- [ ] 200 items stay fast (search < 50 ms).
- [ ] Turning an item off hides it from order entry.

## M12 · Counter calculator · S
**Figma:** C01 `110:162`, C03 `110:384`, C00 `110:5`

**Build**
- Keypad `C ⌫ % ÷ / 7 8 9 × / 4 5 6 − / 1 2 3 + / 00 0 . =`. The tape shows the expression; the large display shows the total.
- Optional "who" chips: Walk-in (default), recent customers, "+ Who?".
- Optional "Name items" opens item search to attach lines.
- "Say it" uses the Web Speech API where supported, and is hidden otherwise.
- **Cash first:**
  - a big primary button "Cash ৳245"
  - "Given" chips (smart denominations: next round notes) showing the change
  - secondary buttons: bKash, Baki
- **Baki** opens the khata sheet (M13). Disabled until M13 ships.
- After a sale: a success state with "Show receipt QR". In Phase 1 the QR encodes a text receipt + the shop link, if one is set; the real link arrives in Phase 3.
- Sales log with undo (last 10 minutes), and day totals by method.

**Accept**
- [x] Ten sales in under 60 seconds with keypad only (Playwright test).
- [x] Calculator maths is correct, including operator precedence and `%` (unit tests with ≥ 30 cases).
- [x] Cash is always one tap from the total. No modal is required for cash.

## M13 · Customers and khata (credit) · M
**Figma:** C02 `110:301`, C04 `111:101`, C05 `111:238`

**Build**
- Customer CRUD: name, nickname, phone (E.164), address, notes, tags.
- Credit account: allowed toggle, limit, reminder settings.
- **Put on khata:**
  - search or recent customers, each showing balance and limit bar
  - an over-limit warning: allowed with an explicit "Give anyway" confirmation
  - new person: type name + phone
  - "Send receipt on WhatsApp" toggle
- **Khata list:**
  - totals (due, collected this week, over 30 days)
  - filters (due this week, over 30 days, over limit, paid up)
  - sorted by age
- **Customer profile:**
  - balance and limit meter
  - Got paid (method), Remind, Call
  - history with who recorded each entry
  - notes
- **Reminders:** generate bilingual text from a template (`khata.ts`). Open `wa.me` with the text, with Copy and "I sent it" next to it. "Start reminders" steps through each due customer one at a time.

**Accept**
- [x] Balances always equal the sum of entries (property-based test).
- [x] Reminder text matches the template in BD (Bangla + English) and Intl (English).
- [x] Every khata action is recorded in history with the actor and time.

## M14 · Manual orders and queue · M
**Figma:** M15 `102:593`, M13 `102:288`, M14 `102:448`, D09 `53:1251`, C06 `111:366`, C07 `111:519`

**Build**
- **New order:**
  - source chips (Phone, Walk-in, Table, Paste chat, Other)
  - customer phone lookup with "use usual"
  - item tiles + search + free-text lines (for corner shops and pharmacies)
  - delivery / pickup / dine-in, address, time
  - payment (Cash on delivery default, bKash, Paid at counter, Khata)
- **Queue:**
  - chips by status, from the business pack flow
  - order cards showing age, source and "handled by" (local member name)
  - actions to advance status
- **Order detail:** timeline, lines, totals, payment, notes, change/cancel.
- **Price an order** (corner shop): a free-text order shows lines without prices; tap a line to enter its price on the mini keypad; mark out of stock; offer a swap; then send the price via WhatsApp (deep link + Copy).

**Accept**
- [x] An order can be created in ≤ 20 seconds with keyboard only on desktop and tap only on the phone.
- [x] Status changes are logged; undo works for the last change.
- [x] Orders older than a configurable threshold are highlighted, using a left bar, not a filled background.

## M15 · Stock · M
**Figma:** M16 `103:213`, Stock `39:476`, M10 `77:3291`

**Build**
- Stock items: name, unit, on hand, target (par), pack size, supplier.
- To order = max(0, target − on hand), rounded up to the pack size.
- **Quick update bar:**
  - parse input with `quickUpdate.ts`
  - show proposed changes ("Chicken 14 → 12 kg")
  - Save or edit
- Steppers to edit on hand inline. Filters: Low, To order.
- **Night count mode:** one item at a time, with big number entry and Skip / Next; differences are summarised at the end.
- **Draft supplier order:** a grouped list → WhatsApp text per supplier, with Copy and "Sent".

**Accept**
- [x] The parser handles ≥ 40 fixture phrases (English, with unit variants: kg, g, L, ml, pcs, hali, dozen, strip).
- [x] The count summary shows variances; applying them writes `count` moves.

## M16 · Today and closing · S
**Figma:** C00 `110:5`, M12 `102:82`

**Build**
- **Tiles:** sales today, number of sales/orders, credit given/collected, average time (if orders exist).
- **Payment split bar:** cash, wallets, credit. Waiting orders. Low stock. Due reminders.
- **Close the day:**
  - enter the counted cash (with denomination helper)
  - compare with recorded cash
  - if higher, offer "Add ৳X as walk-in sales"; if lower, record a shortfall note
  - produce a day summary (shareable text/PDF)

**Accept**
- [ ] Numbers on Today equal the sums of the underlying records (tests).
- [ ] The close-day flow works offline and can be undone the same day.

## M17 · Exports and backup · S
**Figma:** M29 `106:921`, desktop `82:3097`

**Build**
- Export Orders, Sales, Credit, Stock moves, Customers and Purchases.
- Formats: CSV, XLSX (SheetJS or similar), PDF (a simple table report).
- Ranges: today, week, month, custom.
- JSON backup (all tables + schema version) and restore with a preview. Share via the Web Share API where available.

**Accept**
- [ ] The CSV opens correctly in Excel (UTF-8 BOM) with Bengali text intact.
- [ ] Restore into a fresh browser reproduces identical totals.

## M18 · PWA · S
**Build**
- Manifest (name, icons, theme ink, start_url `/app/`, scope `/app/`) and a service worker with offline app shell.
- An update toast ("New version — reload"). Request `storage.persist()`. Show an install hint on Android/iOS.

**Accept**
- [ ] Installable on Android Chrome and desktop Chrome/Edge; launches offline.
- [ ] Lighthouse PWA checks pass. Release `v0.2.0`.
