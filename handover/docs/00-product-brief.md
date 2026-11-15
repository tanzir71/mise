# 00 · Product brief

## One line
Mise brings every order, chat and payment for a small business into one calm place. It keeps the kitchen or counter, stock, staff, credit and cash in step, and an AI operator (Claude or Codex) can take the shift when the owner is busy.

## Who it's for

| Business | Main jobs | Typical channels |
|---|---|---|
| Restaurant (reference) | Take orders from everywhere, keep the kitchen in sync, deliver, plan staff and prep | Foodpanda, Pathao Food, Messenger, WhatsApp, QR tables, phone calls |
| Online shop | Confirm cash-on-delivery (COD) orders, pack, book couriers, reconcile courier cash | Facebook shop, Instagram, Daraz, own storefront |
| Food stall | QR orders with token numbers, wallet payments, a quick close of the day | QR at the stall |
| Corner shop (grocery, pharmacy, hardware…) | Fast cash sales, credit (khata/baki) for trusted neighbours, orders by link or WhatsApp, delivery by the shop boy | Walk-ins, WhatsApp, calls, shop link |

Market packs (currency, wallets, delivery apps, couriers, language, holidays) make it reusable. Bangladesh is the default; Indonesia, India and Kenya are example packs. See `05-data-model.md` → Packs.

## The problems we solve
- **Orders are scattered** across apps and chats, and some get missed in a rush.
- **Kitchen and desk miscommunicate.** Nobody knows whether an order was seen.
- **Customers chase updates** ("where is my food?").
- **Stock, staffing and credit live in people's heads**, on paper, or in a notebook.
- **Owners can't see the whole store** unless they are standing in it.
- **Traditional POS tools assume APIs, hardware and typing.** Small shops have none of the three.

## Product principles
1. **Catch data where it already happens.** The browser extension reads delivery-app tabs. The Android order phone reads notifications. Customers order by QR or link. Staff check in by saying it in their group. Owners snap invoices, or share any screenshot into Mise.
2. **Every automated path has a manual one, one tap away.** "Copy message", "I sent it", "Log it by hand", "He told me he's here".
3. **No order left behind.** Kitchen acknowledgement timers, completeness checks against each portal, and phones that ring.
4. **Local-first and cheap.** Works offline. Uses the phone and PC the shop already has. No email.
5. **AI is an operator, not a gimmick.** It works through the same actions and permissions as staff, logs everything with undo, and steps back when a person types.
6. **Calm, minimal UI.** Monochrome, one accent, big tap targets. Bilingual where customers see it.

## Surfaces (eventually)
- **Web app (PWA):** desktop and phone, with full feature parity.
- **Kitchen / pack / counter screens:** the same PWA in a focused mode.
- **Customer pages:** storefront, QR menu, order link, tracking link, the customer's own khata.
- **Staff link:** "My shift" and "I'm here".
- **Browser extension (Chrome):** reads signed-in portals, fills courier forms, runs "Start service".
- **Android order-phone app:** notification listener for WhatsApp, bKash, Nagad and calls.
- **MCP server and Agent console:** for Claude, Codex or any MCP agent.

## What "done" looks like for v1 (end of Phase 3)
A shop can do all of the following:
- install the PWA on its phone and PC
- take counter sales, manual and link orders
- run a kitchen screen on a tablet that stays in sync
- send customers tracking links
- track stock and credit
- let staff check in from a link
- let the owner watch everything live from home

No native app or AI is needed yet.
