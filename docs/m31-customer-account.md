# M31 · Original customer account identity

An offline contact edit named its existing BDT khata, but admission looked for
the current profile's USD account after a currency change. A SQL regression
reproduced a 409 instead of accepting the contact edit. A different current-unit
account could also prevent the original terms edit from reaching its own khata.

Customer updates now select the original device-named existing account within
the authorized customer, business and outlet. The planned preparation takes no
account row lock ahead of the existing business/outlet lock order. The inner
preparation rechecks authority and exact scope, and completion retains the
existing snapshot, live actor and immutable ID checks. Public callers cannot
override the account through the explicit-account argument reserved for settings.

The shared calculation clones its account context using the selected existing
khata's unit. Actual shop settings, commands and original source images stay
unchanged. Contact-only edits write one customer audit, with no account or ledger
mutation. Credit terms still require the original saved unit. A new account uses
the current profile and retains the prior source-currency guard; a different
winning account cannot replace the planned identity. Genuine completed receipts
remain recoverable before new admission checks.

The same calculation serves hosted proposals and pending canonical projection.
Tests cover a competing USD account, last-admitted contact ordering, cross-scope
IDs, manager revocation, immutable sources and native canonical application.
Two browser cases exercise offline contact/terms edits against another device's
later profile change through SQL-backed HTTP, original images and offline reload.
Auth, object storage and realtime in these browser fixtures are synthetic.

Lint and strict types pass, including 142 Astro files without diagnostics. The
first complete unit run passes 2,699 tests across 139 files. Both `/` and `/mise/`
production builds pass. All 12 focused browser flows and all 468 full-suite cases
pass without skips, failures or flakes. Full 1,000/5,000-record inputs, the normal
two workers and existing deadlines remain unchanged. The runtime source did not
change after successful unit/build verification; final edits affect delivery
notes and redacted evidence only.

The clone-local [visual report](../qa/report.html) contains 278 comparisons with
complete layout metrics and no horizontal overflow at 360, 390, 768, 1024 and
1440 px. Reviewed captures show the [customer profile](../qa/screens/m13-customer-screen-390.png),
[outlet recovery](../qa/screens/m31-recovery-phone-review-390.png) and
[desktop sync controls](../qa/screens/m31-sync-controls-desktop-screen-1440.png).
Inherited frames and tokens cover these existing views; M31 names no dedicated
customer-account frame. Serious/critical axe checks pass on customer/recovery
flows. Generated reports and screenshots remain ignored; no CI artifact or Pages
publication is claimed.

The reviewed migration is applied, and deployed commands v29 exactly matches its
90-source bundle with JWT verification enabled. The hosted project has 42
migrations, seven functions and 62 application tables under forced RLS. Anonymous
table grants, public security-definer helpers and public buckets remain absent.
Security and performance advisors have no warnings or errors. A genuine valid-key
positive control returns 200; all ten anonymous probes return 401, including a
valid contact-only update. No real Auth account, SMS, Auth setting or server secret
is changed by these checks. Full signed-owner HTTP/phone-provider acceptance stays
open. The [verification record](m31-customer-account-local.json) contains counts,
hashes and relative paths, without actual project or credential values.

No table schema or command, receipt or portable backup version changes. Cloud setup
and sync remain off by default. M30/M31, other financial conflict families and
genuine phone-provider/physical-device acceptance remain open. GitHub workflows
and Pages publication remain held by owner instruction.
