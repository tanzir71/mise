# Phase 6 — Advanced → `v0.7+`

Pick these up in the order listed unless the owner reprioritises. Each depends on Phases 3–5.

## M60 · Online shop: confirm, ship, get paid · L
**Figma:** SM01–SM04 (`108:1068`, `108:1193`, `108:1315`, `108:1453`); desktop S01 `84:5`, S02 `85:270`, S03 `86:455`

**Build**
- **Pipeline:** New → To confirm → To pack → Book courier → With courier → Delivered / Returning.
- **COD confirm:**
  - risk from own history (returns ratio)
  - a confirm message through HandOff, or by the agent
  - ask for an advance (bKash) for risky buyers
- **Courier booking** via the extension:
  - recipes fill the bulk form for Pathao Courier, Steadfast and RedX
  - read back consignment IDs
  - fallback: "copy details" by-hand mode and a CSV in the courier's template
- **Reconciliation:** import a payout statement (CSV, or the extension reads it) → match parcel by parcel; mismatches get a claim message draft. Returns: restock or write off.
- **Products with variants:** available = on hand − held.

## M61 · Plan · M
**Figma:** M17 `103:400`, desktop `39:949`

**Build**
- Need versus have per slot, from the last 4 weeks of the same weekday plus events (market pack `calendar/events`).
- Ask the staff group to cover (HandOff); assign. Prep list per day sent to the kitchen screen.

## M62 · Performance · S
**Figma:** M34 `107:942`, desktop `75:2534`

**Build**
- Role-based metrics from recorded taps only: kitchen time to see orders, ready on time, confirms, on-time check-ins, delivery times.
- Staff see their own. Rush hours are marked for context.

## M63 · Guests and win-back · M
**Figma:** M21 `104:358`, M22 `104:507`, desktop `64:1671`

**Build**
- Merge identities by phone across channels. Segments: regulars, new, drifting, no contact.
- Win-back sender: one tap per guest via HandOff, with progress saved. Guests with no route get an "ask at next visit" flag.

## M64 · Teach a website · L
**Figma:** D07 `49:940`

**Build**
- Extension point-and-click: the owner clicks the order number, name and total once, and the extension builds a recipe.
- Test it on 3 sample pages; save it; it then reads every order.

## M65 · More markets and full Bangla UI · M
- Complete market packs (ID, IN, KE…) and a full Bangla UI translation (i18n keys across the app). Script-specific fonts.

## M66 · Native shell (only if needed) · L
- Wrap the PWA (e.g. Capacitor) only if a PWA limit blocks a must-have, such as background audio for kitchen alarms on iOS. Document the reason in `DECISIONS.md` first.
