# M31 · Saved supplier invoice review

A rejected offline invoice now has an opt-in comparison of its saved currency,
prices, quantities, payment method and date with the current supplier, shop and
invoice. The operator can explicitly withdraw the original action or apply a
distinct reviewed replacement. Recording an invoice does not receive stock, make
a sale, change a khata or issue a refund. Supplier metadata retains its existing
last-write behavior.

Replacement preserves the invoice ID, every original priced line, payment method
and physical occurrence time. A new invoice cannot reinterpret its saved prices
under another shop currency. A reviewed record uses the checked current timezone,
displayed in the proposal; an existing invoice undo retains its original timezone
and currency. The original ten-minute undo deadline remains enforced by the actual
server clock. A fresh comparison with changed values requires another explicit
choice.

The source capsule contains the selected complete invoice image and, for grouped
undo, its actual earlier creation witness. Its fingerprint covers the entire
original queue row and original image bytes. Literal command and source text stay
opaque through PostgreSQL so Bengali, escaped NUL and unpaired surrogates cannot
be lost to JSON normalization. Independent server formatting verifies identities,
scope, complete financial facts, source and saved currency.

Private forced-RLS tickets bind the checked snapshot, original actor and account,
source and deliberate choice. Authenticated callers may prepare or read; only the
server may finish a withdrawal or replacement. Completion checks live access,
stable lock order, snapshot, reserved identities and real time. Replacement uses
normal invoice validation and returns its genuine typed receipt. Actual ordinary
or resolved outcomes take precedence over the device's last choice or nonce.

Native schema 25 adds only the internal `purchaseReviews` store. Portable backup
schema 10 and its 21-table allowlist stay unchanged. Token-free comparisons,
choices and attempts are durable before HTTP; server review tokens remain
ephemeral. Every journal write rechecks original phone account, operator,
connection, revision and complete source under native locks. Only a genuine
guarded receipt can acknowledge the original command. Canonical coverage requires
its exact resolution audit before retiring the original projection.

Stopping a request cannot assume that SQL rolled back. A stopped or lost reply
leaves the chosen action unconfirmed until its actual outcome is checked. Offline
reload retains the source, choices and complete images; a JSON backup remains one
tap away. Restoring the original sign-in after an offline reload is allowed to
finish verification, while an actual account switch aborts the active review and
retains the source. After normal guarded sync acknowledges an outcome under a
restored original account, historical confirmation may annotate that exact receipt
without reviving an older operator generation or resubmitting its choice.

The four focused browser cases pass against actual local PostgreSQL and HTTP
handlers. They cover withdrawal, same-currency replacement, changed timezone,
lost replies, offline reload, an actual downloaded JSON backup, full image hashes,
account replacement after SQL commit, stopping a committed request and convergence
between two browsers. Auth, Realtime and Storage in these local fixtures remain
explicitly synthetic; they do not establish hosted phone-provider acceptance.

All 270 supplied exports are present. M31 supplies no dedicated invoice-review
frame, so the interface follows M27 More and Desktop 14 Business data tokens and
controls. Twelve focused captures pass at 360, 390, 768, 1024 and 1440 px with no
horizontal overflow. Accessibility runs before screenshot-only navigation hiding;
pixel differences against these reference frames are informational. Reviewed
captures include the [360 px comparison](../qa/screens/m31-invoice-review-phone-review-360.png),
[currency mismatch](../qa/screens/m31-invoice-currency-phone-review-360.png) and
[unconfirmed choice](../qa/screens/m31-invoice-unconfirmed-desktop-review-1440.png).
Generated screenshots and the [visual report](../qa/report.html) stay ignored.

Lint and strict type checks pass, including 144 Astro files with no diagnostics.
All 221 focused unit/native/SQL/HTTP checks and all 16 focused browser regressions
pass with the normal two workers and unchanged limits and deadlines. These include
the complete 200-line invoice, exact original source protection, real server undo
expiry, native quota/account races and original store preservation on upgrade.
The candidate function matches all 92 source hashes and passes comparison with
the actual private deployment values without exposing those values in evidence.

The complete unit run passes all 2,756 tests across 141 files in 570.81 seconds,
with the normal two workers and unchanged limits and deadlines. All 1,178 checked
source and asset files remain unchanged during that run and both subsequent
production builds. Builds at `/` and `/mise/` pass, including comparisons against
ten private values with no credentials, private deployment details or coverage
gaps found in source or generated output. The complete browser suite passes all
472 cases in 23.8 minutes with the normal two workers, no failures, skips or
flakes. The complete visual report contains all 290 comparisons with complete
metrics and no overflow. Fresh invoice comparison, currency-mismatch and
unconfirmed-choice captures were inspected after that complete run.

Before commit, the new browser specification's 87 Windows line endings were
normalized to LF. Reconstructing CRLF reproduces its exact original source hash;
all other checked files and every app/backend source remain unchanged. Its four
browser cases pass again after that formatting-only correction.

The reviewed migration and commands function are deployed. The retrieved source
matches the exact 487,820-byte, 92-source bundle and retains JWT verification.
All 64 application tables force RLS; there are no anonymous/PUBLIC table grants,
public security-definer functions or public buckets. The two new review tables
have no direct anonymous, authenticated or service-role grants. Four scoped
read/admission wrappers are authenticated; only the server may finalize a review.
Security and performance advisors return no warnings or errors. A valid-key
positive control returns 200, followed by fourteen actual unauthenticated requests
returning 401, including both invoice review routes, admission and completion.
These checks create no account, send no SMS and change no Auth setting or secret.

The [redacted verification record](m31-purchase-review-local.json) includes only
counts, source hashes and relative artifact paths. An early verification wrapper
stopped before launching focused browsers; it was resumed from that stage under
PowerShell 7. The complete unit, browser and visual attempts passed without
relaxing a deadline, reducing an input or changing the worker count.

Cloud setup and sync remain off by default, and M30/M31 remain
unticked. Other financial conflict families, genuine hosted phone-provider and
physical-device acceptance, and remaining milestone requirements stay open.
GitHub workflows and Pages publication remain stopped. Actual deployment details
and all credentials stay in ignored private inputs or the server secret manager;
the existing commit, push and build guards stay enabled.
