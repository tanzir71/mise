# 05 · Data model

All IDs are ULIDs. All timestamps are UTC ms (`createdAt`, `updatedAt`). Money is an integer in minor units (`amount`), plus the outlet's `currency`. Phones are E.164 strings.

## Core entities
| Entity | Key fields |
|---|---|
| **Business** | id, name, businessType (`restaurant`/`online_shop`/`food_stall`/`corner_shop`), marketCode (`BD`/`ID`/`IN`/`KE`/…), languages[], createdAt |
| **Outlet** | id, businessId, name, address, timezone, currency, openingHours, deliveryZones[] |
| **Member** | id, businessId, outletIds[], name, nameLocal, phone, role (`owner`/`manager`/`staff`/`kitchen`/`rider`/`agent`), checkInMethods[], permissions{}, pinHash, active |
| **Item** (catalogue) | id, outletId, name, nameLocal, categoryId, price, unit (`pc`/`kg`/`g`/`L`/`strip`/`hali`…), available, variants[] (name, price, stockItemId?), photo? |
| **Category** | id, outletId, name, sort |
| **Customer** | id, businessId, name, nickname, phone?, address?, notes, tags[], consent{savedAt, source}, firstSeenAt, lastOrderAt, ordersCount, spend |
| **Order** | id, outletId, number (human, e.g. `A-2041`, `T-07`), source (`counter`/`phone`/`walk_in`/`table`/`link`/`whatsapp`/`messenger`/`foodpanda`/`pathao`/`other`), customerId?, type (`delivery`/`pickup`/`dine_in`/`counter`), status, lines[], fees[], discount, total, payment{method, status, paidAt}, address?, scheduledFor?, handledBy[], notes[], trackingToken? |
| **OrderLine** | itemId?, name (free text allowed), qty, unit, unitPrice, lineTotal, note, substitution?{from, to, accepted} |
| **Sale** (counter) | id, outletId, expression (`75+150+20`), amount, method (`cash`/`bkash`/`nagad`/`card`/`credit`), given?, change?, customerId?, items[]?, createdBy |
| **Payment** | id, outletId, method, amount, reference (trxId), from (phone), receivedAt, matchedTo{type: order/creditEntry/sale, id}?, source (`manual`/`sms`/`notification`) |
| **CreditAccount** (khata) | id, customerId, outletId, limit, balance (derived), allowed, reminder{dayOfMonth, tone, channel}, notes |
| **CreditEntry** | id, accountId, type (`charge`/`payment`/`adjustment`/`reminder`), amount, saleId?/orderId?/paymentId?, note, createdBy, createdAt, disputed?{byCustomer, text, resolvedAt} |
| **StockItem** | id, outletId, name, unit, onHand, target (par), packSize?, supplierId?, lowAt?, lastCountedAt |
| **StockMove** | id, stockItemId, delta, reason (`used`/`received`/`count`/`waste`/`sale`), source (`quick_update`/`invoice`/`count`/`order`), note, createdBy |
| **Supplier** | id, outletId, name, phone, items[] |
| **Purchase** | id, supplierId, lines[], total, paid (`cash`/`bkash`/`due`), photoRef?, createdAt |
| **Shift** | id, outletId, date, slot (`lunch`/`dinner`/…), need, memberIds[] |
| **CheckIn** | id, memberId, outletId, at, type (`in`/`out`/`break`), method (`order_phone`/`link`/`group`/`manual`), recordedBy |
| **Capture** | id, outletId, kind (`screenshot`/`photo`/`text`/`notification`/`portal`), payloadRef, parsed{}, confidence, status (`new`/`applied`/`ignored`), resultRef? |
| **Task** (inbox) | id, outletId, kind (`question`/`failure`/`chat`/`check`), title, body, actions[], assignee (`human`/`agent`/memberId), status, dueAt |
| **Event** (audit) | id, outletId, actor{type: member/agent/system, id}, command, before, after, at, undoOf? |

## Order status by business pack
- **Restaurant:** `new → confirmed → kitchen_seen → cooking → ready → out → delivered` (+ `cancelled`)
- **Online shop:** `new → to_confirm → confirmed → packed → booked → with_courier → delivered | returning → returned`
- **Food stall:** `ordered → making → ready_called → collected`
- **Corner shop:** `requested → priced → accepted → packing → ready | delivering → done`

Labels come from the business pack (Figma "Mise / Business" variables), e.g. `flow/1..5`.

## Packs (`packages/core/packs`)
- **Business pack keys:**
  - `biz/type`, `noun/item`, `noun/catalogue`, `noun/customer`, `flow/1..5`, `fulfil/screen`, `fulfil/check`, `dispatch/who`, `money/settlement`, `stock/model`, `plan/name`
  - nav labels and the `metric/time` label
- **Market pack keys:**
  - `currency/symbol`, `money/grouping`, `lang/secondary`, `font/secondary`
  - `pay/wallets`, `pay/qr`, `delivery/aggregators`, `chat/apps`, `courier/parcel`, `marketplace`
  - `address/style`, `tax/name`, `week/weekend`, `phone/format`, `calendar/events`
- The full values for BD/ID/IN/KE and the four business types are in `handover/docs/packs.json`. Seed the packs from that file.

## Formats and parsers (unit-test all of these)
- **money:**
  - `formatMoney(112840_00, 'BDT') → "৳1,12,840"` (lakh grouping via `Intl.NumberFormat('en-IN')` + symbol)
  - Intl defaults for other currencies
- **phone:** `normalisePhone('01712345482','BD') → "+8801712345482"`; `waLink(phone, text)`.
- **calc:** `+ − × ÷ %`, decimals, `00`; errors return null (never throw to UI); the tape shows the expression.
- **quickUpdate:**
  - parses `used|got|received|wasted|count <qty> <unit> <item>` lists separated by commas or "and"
  - Bangla number words optional later
  - returns proposed moves for confirmation
- **orderMessage:** the WhatsApp text produced by the order link is human-readable AND machine-parseable (see the Phase 2 spec).
- **payments:** regexes per provider (bKash, Nagad, bank) with sample fixtures in `packages/core/fixtures/`. Unknown formats fall back to manual entry.
