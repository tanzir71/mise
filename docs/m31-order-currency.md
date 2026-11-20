# Original order currency

A queued order must retain the unit of its saved prices. Changing an outlet from
BDT to USD does not convert old minor-unit amounts into dollars. A reproduced
SQL/HTTP regression accepted exactly that reinterpretation before this change.

Delivery now reads the original order image in the immutable queue source. It
sends its three-letter currency in `X-Mise-Saved-Currency`, independently of the
unchanged normalized command body and hash. The assertion is derived before Auth
and remains fixed through retries. It never comes from the device's current
profile. Missing, conflicting or damaged source currency retains the original
action for review instead of borrowing a new unit.

The server first checks whether the exact original action already completed.
An actual receipt is returned even after settings change or the new assertion is
missing. For a new write, the proposed order and every linked sale, credit entry
or refund must match the saved currency. The same check runs on every preparation
retry. SQL's existing complete-context snapshot validation catches a profile
change between preparation and commit, so a retry cannot silently adopt the new
currency. No schema, grant, signing secret or command/receipt format changes.

Historical BDT orders can still receive BDT cash payments after the current outlet
switches to USD. New credit keeps the existing current-currency, balance and
consent checks. This boundary does not convert money or override other financial
source and expiry rules.

Both command transports preserve their existing abort/deadline behavior and
freeze the currency before asynchronous sign-in. The header is included in the
existing origin-controlled CORS policy and provides no additional access or body
allowance. Native source/account checks still surround receipt acknowledgement.
The assertion is transient: no store, portable backup or saved command changes.

The native two-device story queues a BDT order offline, changes the owner's
currency through the real profile command, then reconnects. The original order
and source remain intact. Current-value review disables applying it in USD;
explicit withdrawal retains the genuine resolution and lets canonical sync
converge, with a manual new-order path. Source and original images survive reload.
Auth, Realtime and object Storage in this harness are explicit local fixtures.

Tests cover the reproduced regression, matching admission, missing/malformed
assertions, a preparation/commit race, historical cash, actual completed compound
payments, source corruption and both transports' Auth/cancellation boundaries.
Local validation and deployment evidence are in
[the delivery record](m31-order-currency-local.json). The visual report is
clone-local at `qa/report.html`, using M27 More and Desktop 14 tokens because M31
supplies no dedicated frame. Key captures are
`qa/screens/m31-currency-phone-review-360.png`,
`qa/screens/m31-currency-phone-review-390.png` and
`qa/screens/m31-currency-desktop-review-1440.png`.

Other financial families still need their corresponding currency/conflict
boundaries. Genuine hosted phone verification, physical-device and remaining
M30/M31 acceptance stay open. Cloud flags remain off, all GitHub workflows remain
disabled and Pages publication stays held. Deployment values and credentials
remain in ignored private inputs and the server secret manager.
