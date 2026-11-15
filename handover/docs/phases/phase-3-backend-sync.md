# Phase 3 — Backend and sync (T2) → `v0.4.0` (v1)

Goal: many devices, staff and customers see the same live data. The app stays a static PWA on GitHub Pages; Supabase provides the database, auth, realtime and edge functions.

Prerequisite decisions to write in `DECISIONS.md` before starting:
- Supabase region
- SMS provider for phone OTP
- how the "No email" rule is enforced in Supabase auth settings

---

## M30 · Supabase foundation · L
**Build**
- Schema from `docs/05-data-model.md` as SQL migrations. Tenancy is by `business_id` and `outlet_id`.
- Row-level security for owner / manager / staff / agent / public tokens.
- **Auth:** phone OTP for owners and managers; device enrolment plus a 4-digit staff PIN for shared screens.
- **Migration from Phase 1:**
  - "Turn on sync" uploads the local DB (with a preview of counts)
  - the local copy stays the working copy; the outbox handles the rest
- An edge function `POST /commands`: validates, applies in a transaction, writes `events`.

**Accept**
- [ ] RLS tests prove a manager can't read another outlet and a public token reads only its own order or khata.
- [ ] The local → cloud upload of a 5,000-record DB finishes in under 60 seconds on 3G throttle and can be resumed.

## M31 · Sync engine · L
**Build**
- Outbox in Dexie, retried with backoff. Realtime subscriptions per outlet, plus a cursor pull on reconnect.
- Conflict rules from `04-architecture.md`. A sync status chip in the header (Synced · Syncing · Offline, with a count of unsent).

**Accept**
- [ ] Two browsers editing offline then reconnecting converge, and no record is lost (e2e test).
- [ ] Offline writes show instantly and sync later.

## M32 · Kitchen / pack / counter screen · M
**Figma:** Kitchen PWA `65:1843`, setup `66:1846`, M36 `107:1222`

**Build**
- Focused screen mode (route `/app/screen/kitchen`), enrolled as a device:
  - big tickets, sound on new orders, screen wake lock
  - "Got it" then "Ready"
- **Unacknowledged alarm:** at 2 minutes (configurable), raise an Inbox task, notify via web push to desk devices, and highlight the order red in the queue.
- Offline tolerance: tickets cached; taps queued.

**Accept**
- [ ] A new order appears on the kitchen device within 2 seconds of creation on another device (realtime).
- [ ] The alarm fires if nothing is tapped, and stops when Got it is tapped.

## M33 · Real order link + live tracking · M
**Figma:** M01 `56:1496`, M02 `56:1601`, M03 `56:1704`, C09 `112:284`, M14 `102:448`

**Build**
- The order link from M20 now posts to `POST /public/orders`, with rate limits and a captcha-free honeypot. The WhatsApp path stays as a fallback when offline.
- **Tracking page** `/app/t/<token>`:
  - steps from the business pack, ETA, shop contact (message, call)
  - an honest delay notice when the order is late
- **Corner shop priced flow:**
  - the shop prices the order and the customer sees the prices
  - the customer accepts swaps
  - payment choice: cash, wallet deep link, or khata if allowed
- **QR table orders** automatically open their tracker.

**Accept**
- [ ] A customer can order, see prices, accept a swap and track to "done" without installing anything or creating an account.

## M34 · Staff, check-in, on-duty · M
**Figma:** M18 `103:644`, M19 `103:793`, M07 `59:59`, M05 `58:118`, Team `60:1558`, Members `72:2105`

**Build**
- Members CRUD with roles, permissions and check-in methods.
- **Staff link** `/app/me/<token>`: My shift, "I'm here" / "Leaving", in Bangla or English.
- **On-duty board:** who's in, since when, by which method; missing people get a reminder action (call / WhatsApp HandOff).
- **Manual check-in:** "He told me he's here" records method `manual`, plus who logged it.

**Accept**
- [ ] Check-ins from the link appear on the board in real time. Manual check-ins count the same.

## M35 · Customer's own khata page · S
**Figma:** C10 `112:375`

**Build**
- `/app/k/<token>`: balance, entries with who and when, "Pay with bKash/Nagad" (deep link + copy the number), "Ask for more time" (creates a task), and "Question this entry".

**Accept**
- [ ] The token reveals only that customer's khata at that shop. Revoking the token works.

## M36 · Live store, All outlets, roles · M
**Figma:** "D · Live store" `109:3694`, M37 `107:1280`, M38 `107:1508`

**Build**
- **Live (owner/manager):**
  - KPIs; order flow lanes with stuck/late outlines; needs attention
  - tables (restaurants); money now; people on duty; channels health; stock to watch
  - last hour activity (human / system / agent)
- **All outlets (owner):** totals, a card per outlet, a comparison table, and a "who sees what" panel.
- Role gating in the UI matches RLS.

**Accept**
- [ ] An owner with 3 outlets sees all three live; a manager sees only theirs.
- [ ] Live updates arrive without a refresh.

## M37 · Inbox and notifications · M
**Figma:** M20 `103:900`, M06 `58:201`

**Build**
- Tasks (questions, failures, chats needing a person) with inline actions (Allow / No / Reply myself; Copy message / Open app / I sent it).
- Web push to subscribed devices for urgent tasks: kitchen alarm, payment with no order.

**Accept**
- [ ] Urgent tasks notify within 5 seconds and can be resolved from the notification's target screen. Release `v0.4.0` (v1).
