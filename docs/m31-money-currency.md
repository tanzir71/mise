# Original counter and khata currency

An offline counter sale must keep its saved monetary unit. A real SQL/HTTP
regression accepted a sale using the current USD profile without an assertion of
the original unit. Admission now rejects that new write instead of treating old
minor units as dollars.

The native outbox derives `X-Mise-Saved-Currency` from the immutable original sale
or credit-entry image. It checks the original related IDs, outlet, before/after
unit and financial companions. Payment reversals use their saved reversal image
and original target ID. Missing, duplicate or conflicting images fail before HTTP.
No value comes from the device's current profile. Nonfinancial khata communication
does not require a monetary assertion.

When a sale and its undo share one native transaction, the undo can use the
transaction's original image only with its actual earlier creation intent. A
missing before-image alone cannot invent that relationship.

Both existing transports freeze the unit and normalized body before Auth. The
command body, hash, related financial identities, receipt, queue, local schema and
portable backup remain unchanged. The assertion carries no connection value,
credential or additional permission and uses the existing CORS allowlist.

The server looks up actual completion first. An accepted action still returns its
genuine original receipt when the assertion is absent or the current profile has
changed. For new admission, every proposed sale and credit entry must match the
saved unit. This check repeats after every preparation retry. Existing SQL context
validation rolls back a profile change between preparation and commit; a retry
cannot refresh the assertion from current settings.

Historical BDT cash undo and BDT account payments/reversals remain BDT after a USD
profile change. Current account balances, credit consent, source matching, undo
expiry and live authorization checks still apply. This change performs no currency
conversion and changes no SQL schema, grants, Auth configuration or server secrets.

The native two-device checks use the actual offline counter UI, a real owner
profile command and scoped SQL/HTTP. A rejected counter action keeps its exact
source, working copy, images and durable 409 observation through offline reload;
the JSON backup link remains available. A separate original-account payment and
undo converge in BDT after the owner switches to USD. Auth, Realtime and object
Storage in these checks are explicit local fixtures, not hosted phone acceptance.
The saved-order review control appears only for an actual supported order
observation or existing order journal. A counter rejection no longer advertises
an order-only action; opening any order review still verifies its complete source
and current account independently.
Convergence asserts all shared business records and the exact privacy projection
for member references: managers receive neither the owner's contact nor live
authority from a historical owner reference.

[Local validation and deployment evidence](m31-money-currency-local.json) records
the final checks. Five-width captures use M27 More and Desktop 14 tokens because
M31 supplies no dedicated frame. Pixel differences are informational. Key images
are `qa/screens/m31-money-currency-phone-review-360.png`,
`qa/screens/m31-money-currency-phone-review-390.png` and
`qa/screens/m31-money-currency-desktop-review-1440.png`; `qa/report.html` stays
clone-local.

Explicit counter/khata conflict review and withdrawal/replacement outcomes remain
unfinished. Customer/account creation, stock, purchase and closing boundaries,
genuine hosted phone and physical-device acceptance, and remaining M30/M31
requirements stay open. M31 is
unchecked, cloud flags remain off, workflows remain disabled and Pages publication
stays held. Actual deployment details and credentials remain private.
