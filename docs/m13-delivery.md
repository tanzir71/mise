# M13 · Customers and khata

Customers, credit limits, payments and reviewed reminders now work on one device, including offline. The counter's Baki action creates an atomic sale and khata charge. A limit exception requires an explicit Give anyway approval; another tab changing the balance invalidates that approval. Cash stays one tap away.

Customer details include a nickname, optional normalized phone, address, tags and notes. A paid-up profile can be archived and restored with its history. Opening balances are dated, new credit defaults off, and accounts retain their original currency when shop settings change. The list reports separate currency totals, unpaid debt age and monthly reminders. A customer profile shows the balance, limit, settings and actor/time history with ten-minute financial reversals.

WhatsApp receipts and reminders are previewed before opening another app. Copy and a selectable-text fallback remain available; only I sent it records completion. Calls similarly provide Copy number and I called. Start reminders presents one due account at a time, with Skip leaving it due. Wording and explicit payment instructions are editable. BD defaults to Bangla plus English; other markets default to English.

## Reference review

C02 (`110:301`), C04 (`111:101`) and C05 (`111:238`) supply the sheet, list and profile geometry. The implementation retains monochrome cards, 4px credit meters, modest type and supplied icon/toggle assets. Sheets attach to the bottom on phones and become 440px side drawers on desktop. Interactive targets are at least 44px. The desktop profile uses two columns in the existing 240px shell; phone notes follow history. Native browser/phone chrome and later customer-registration QR features are omitted. Totals, dates, history and message text come from saved records rather than reference examples.

- [Khata list, 390px](screenshots/m13-khata-390.png)
- [Customer profile, 390px](screenshots/m13-customer-390.png)
- [Credit sheet, 390px](screenshots/m13-credit-sheet-390.png)

## Validation and delivery

Local verification covers 164 unit tests, 100 browser tests and 89 visual comparisons. M13's 12 browser tests exercise offline sale/payment/reversal persistence, rapid repeated clicks, stale consent across tabs, phone normalization, archive/restore, counter-side customer creation, invalid limits, reminder sequencing, language/wording, currency retention, focus return and automated AA checks at 360, 390, 768, 1024 and 1440px. All money writes still use the independently tested core commands and atomic database transactions.

CI runs lint, type checking, unit/browser suites, export checks, both portable build paths and the complete visual report before Pages deployment. The report includes six M13 comparisons; difference percentages are informational, with the screenshots reviewed against the supplied frames. The owner's direct-to-main workflow applies.

Live app: [Mise](https://tanzir71.github.io/mise/app/). CI run and visual artifact will be recorded after the push completes.
