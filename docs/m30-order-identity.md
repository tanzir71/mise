# M30 · Order transaction identities

Shared order commands now accept optional device-ID factories for orders, new
lines, notes, communication records and audits. Payment, cancellation, refund and
undo commands also retain every sale, credit entry, refund and companion-audit
identity through their nested domain calls. Existing local callers keep their
default ID generation. Stored original sale/refund IDs and audit references remain
intact when a reversal adds new history.

New order lines cannot reuse another line ID or a previous line from the order.
Editing an existing line retains its original ID without allocating a replacement.
Order commands accept the scoped shop/member context rather than requiring an
invented owner profile. Active membership, business and outlet-assignment checks
still run. Order-linked khata helpers use the existing minimal customer context.
No database schema, authentication configuration or hosted function changes in
this increment.

The new identity checks exercise exact repeated creation and settlement against
the same source and ID plan, all 200 Unicode/escaped lines through serialization,
all four business status flows, later-note preservation, manual communication,
cash/wallet/card and zero-total settlement, linked credit undo, cash cancellation
and partial refund, and the complete partly-collected credit return/refund/reversal
graph. Original charges and refund records keep their IDs while every new entry
and audit uses the supplied device identity. Existing independent money/ledger
model tests and IndexedDB transactions remain part of verification.

Local validation passes: all 1,279 unit checks across 78 files (including the 21
new identity checks), lint, strict TypeScript and all 90 Astro check files, and
production builds under both `/` and `/mise/`. All 298 browser checks pass without
retries, skips, flaky cases or global errors, including offline order/khata
transactions, cash/credit cancellation and refund correction, responsive axe
checks at 360–1440 px, and native PWA restart (367.52 seconds, two workers).

The fetched source/index/history and final built-output audit compared eight
private values in memory and found zero credentials, zero current deployment
references and zero coverage gaps. Its 21 historical matches are the previously
recorded nonsecret deployment references; no history rewrite is claimed. Local
commit/push/build guards remain enabled. Public evidence contains no actual
deployment reference, credential value or private operational path.

This is shared-domain preparation for the complete remote order transaction.
`POST /commands` does not yet accept order intents, and it does not establish
hosted order admission, atomic replay receipts, live authorization/undo-clock
checks, outbox delivery or two-browser convergence. Those remain required before
enabling sync or ticking M30/M31. No product layout or visual comparison is claimed.
GitHub Actions and Pages remain held by the owner; deployment credentials and
actual project/organization references remain outside current repository files.
