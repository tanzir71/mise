# Phase 2 — Customer links without a backend (T0/T1) → `v0.3.0`

Goal: neighbours and customers can order from the shop without hunting for a phone number, still with **no server**. The trick: the customer's order travels as a structured WhatsApp message to the shop's number, and the shop pastes or shares it into Mise.

---

## M20 · Public shop page and order link · M
**Figma:** C08 `112:196` (corner shop, "type what you need"), M04 `58:34` (menu style), storefront `88:3319`

**Build**
- **Static route `/app/s/#<payload>`:** the shop's public data travels in the URL hash, so no server is needed:
  - name, address, hours, phone, delivery note, optional short item list
  - compressed with lz-string and base64url
- **Settings → Shop link:**
  - generate the link
  - preview
  - copy and share
  - "Regenerate after menu changes"
- **Customer page:**
  - "What do you need?" textarea (Bangla or English), plus a voice button if supported
  - "Add a photo" (preview only in this phase, with a note: "you'll be asked to send the photo in WhatsApp")
  - "Same as last time" (remembered on that phone in localStorage)
  - optional item chips
  - Pickup / Delivery, address, when
  - name and phone remembered on the device
- **"Send to shop"** opens `wa.me/<shopPhone>?text=<orderMessage>`.

**Order message format** (human-readable, machine-parseable, see `orderMessage.ts`):
```
🛒 Order for Rahman Store
Name: Sadia · 01712-345482
Delivery: Flat 2C, House 9 · Now
— Items —
2 Napa Extra
1 kg sugar
1 Fresh milk 1 L
(photo attached separately)
#mise v1 s=RS-7KQ2
```

**Accept**
- [ ] The link works offline once opened. The page weighs < 60 KB.
- [ ] The generated message parses back into the same draft (round-trip tests).

## M21 · Paste to order · S
**Build**
- On the orders screen, "Paste order": a textarea or clipboard read. It detects the `#mise v1` format, and otherwise tries a free-text parse into lines.
- The draft opens in Price an order (M14) for corner shops, or New order for others.

**Accept**
- [ ] 20 fixtures of real-style messages, including mixed Bangla/English, produce sensible drafts. Unknown lines are kept as free text.

## M22 · QR posters and counter cards · S
**Figma:** M09 `59:191` (QR poster A5, bilingual)

**Build**
- Generate QR codes for the shop link. Printable A5 poster and a counter card (PDF + PNG).
- Bilingual call to action from the market pack (`lang/scan-cta`).

**Accept**
- [ ] The printed QR scans from 1 m at A5. The PDF prints correctly from a phone.

## M23 · Hand-off pattern everywhere · S
**Build**
- A shared `<HandOff>` component: primary deep link button, "Copy message", "I sent it", "Didn't work".
- Each choice records an event, so reminders and win-back progress survive.
- Use it for receipts, khata reminders, supplier orders, priced-order messages and win-back.

**Accept**
- [ ] Every outbound message in the app uses `<HandOff>`. Progress resumes after a reload.

## M24 · Share target (Android PWA) · S
**Figma:** M25 `104:950`

**Build**
- Web Share Target in the manifest (`text`, `url`, `files` for images).
- Shared items land in an Inbox list: "What is this?" with chips (Order, Payment, Invoice/stock, Something else). Choosing one opens the matching manual form, prefilled with the text where possible.
- Images are stored locally (IndexedDB blobs, capped size) for later OCR (Phase 4).

**Accept**
- [ ] On Android Chrome with the installed PWA, sharing a WhatsApp message or screenshot to Mise creates an inbox item. Release `v0.3.0`.
