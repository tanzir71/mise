# Live store and every owned outlet

The `liveStore` preview adds Live to Today and More, plus an owner-only All outlets page. It defaults off. The installation uses its own backend connection and verified phone sign-in from Sync setup; no extra provider, maintainer account, phone number or credential is needed.

Live shows recorded sales and net cash, active order lanes, original estimate and kitchen-alarm outlines, open tasks, table labels, on-duty people, low stock and the last hour's audit activity. All outlets includes every business actually owned by that verified account, complete totals, outlet cards, hourly sales, comparison and role descriptions. Currencies remain separate, including historical sales in an outlet's former currency. Reporting windows use each outlet's local day, Monday-based week or calendar month.

An owner can inspect another owned business without replacing the device's selected native operator. A manager can read only an outlet they are currently assigned to; All outlets is owner-only. The authenticated RPC checks the actual phone identity, active memberships and assignments for both the native anchor and viewed outlet. Caller roles and local profile labels grant no server access. Anonymous, unverified, banned, removed and unrelated identities are denied. Private projection helpers cannot be called by client roles.

The visible page checks the backend every five seconds, with reconnect and visibility wake-ups and a manual Refresh now control. It labels the last checked time. A transient connection failure can retain the marked read-only view in memory. An account, membership, backend or native operator change invalidates current data and open detail; late replies cannot restore it. No dashboard or customer ledger is persisted as an offline authority. Today on this device remains the manual local path.

Money comes from actual sales, refunds and credit entries using the existing Today rules. Recorded cash is not a counted drawer balance; no opening float, payout, payroll, AI activity or external channel health is invented. Tables are labels from active dine-in orders and approved table links, including links without an expiry date. They do not establish seating capacity or physical occupancy. Attendance uses current assignments and recorded check-ins; a missing record is only marked Not in when the configured usual shift is due. Across outlets, the count deduplicates member IDs, without guessing that separate business memberships identify one person.

Orders, tasks and table references open read-only details. Own-outlet orders can open the existing native order after another scope check. Other outlets remain read-only until the operator selects them. A blocked clipboard exposes the complete, focused selectable text inside the detail dialog. Customer messages, including Bangla, remain literal data; reading or copying a task changes no balance, deadline or permission. Inline task resolution belongs to M37.

The SQL is additive and has no new tables or provider requests. Two applied migrations are frozen:

- `20261123162105_live_store_reads.sql` supplies the guarded projection and public RPC.
- `20261123164153_live_store_link_lifetime.sql` preserves the established meaning of a null shop-link expiry: the approved link remains valid until revoked.

The final seven function bodies match the reviewed migrations. The private commissioning proof creates three owned businesses, three outlets and three Core sales, checks owner and manager projections against actual row access, verifies denied execution paths and unchanged money, then rolls everything back. All 109 application tables force row-level security. No Edge Function version, public endpoint, scheduler or workflow is enabled by this increment.

The reference frames are desktop Live `109:3694`, desktop All outlets `109:4289`, mobile Live `107:1280` and mobile All outlets `107:1508`. Original SVG bytes and dimensions are recorded in [the asset manifest](live-store-assets.json). Existing app chrome and shared primitives are reused. Mobile sections use accessible expandable controls; every interactive target is at least 44 px. Provider states and sample figures from the reference are replaced by recorded facts.

Verification and source hashes are in [the machine-readable record](live-store-verification.json). The local visual report is `qa/report.html`; its image differences are informational because the reference includes different sample data and browser/phone chrome. The committed captures use synthetic records only:

- [Live, desktop](screenshots/m36-live-1440.png)
- [Live, mobile](screenshots/m36-live-390.png)
- [All outlets, mobile](screenshots/m36-all-outlets-390.png)

M36 remains unchecked while public delivery, CI artifact upload and final hosted acceptance are held. M30/M31 hosted and recovery gates, M34 task permission enforcement and M35 public delivery also remain open. M37 Inbox and notifications is the next implementation step. Workflows remain manually disabled and Pages remains held; this preview is not a new public deployment.
