# Original currency during pending replay

Rejecting a changed-currency command at the server is only one boundary. A native
database regression showed that a canonical download could still project a saved
BDT counter sale in USD and advance the accepted cursor. The new check refuses
that projection before any working-domain or cursor write.

Canonical application and full outlet-access recovery now index the detached,
immutable original queue. Each genuinely pending order or counter/khata command
gets its saved unit from its original row images and financial companions,
including the real earlier creation intent for a grouped sale/undo. The unit
comes from neither the current profile nor a previously materialized working
copy. Missing or contradictory source is an integrity failure.

The existing pure domain replay still calculates the proposed rows. Before those
rows can enter the working projection, the original unit must match every linked
order, sale, credit entry or refund. A mismatch retains the current working copy,
queue, images, operator/binding and accepted canonical base. Recovery cannot
produce an admissible review or substitute a currency conversion for the original
financial action. Downloaded evidence remains available for later review.

Actual coverage is checked first. Covered actions are not replayed or subjected to
a new unit assertion, and no receipt is invented. A canonical USD profile can
therefore retain genuine historical BDT cash. Pending historical cash undo,
original-account payments and notes on old BDT orders also remain valid when the
domain rules permit them. Grouped same-currency cash/undo still replays normally.

This is client-side reconciliation. Existing command bodies, hashes, receipts,
queue/source formats, schema 23 and portable backup schema 10 stay unchanged.
No new Supabase function, SQL migration, grant, Auth setting, secret or deployment
configuration is required. Credential guards remain enabled.

Native browser checks use real scoped SQL/HTTP, an actual owner profile command,
two devices and complete local images. They cover ordinary download refusal,
changed-epoch recovery refusal, offline reload and a downloadable original JSON
backup. Auth, Realtime and object Storage are explicit local fixtures; this does
not commission a hosted phone provider.
Convergence assertions wait for actual canonical coverage as well as local
receipt acknowledgement before checking the final working copy.
Recovery checks also wait for each original command's applied coverage before
the fixture sends a cross-device event. Offline reload checks wait for the real
service worker to control the page before disconnecting it. Existing data
assertions and deadlines remain unchanged.
The final focused browser check downloads and parses the original backup after
offline reload. The complete 455-case run covers the same production code; only
this stronger test ordering and verification notes changed afterward.

[Local validation](m31-pending-currency-local.json) records the final checks.
Five-width recovery captures use M27 More/Desktop 14 tokens because M31 names no
dedicated frame. Pixel differences are informational. Key screenshots are
`qa/screens/m31-pending-currency-phone-review-360.png`,
`qa/screens/m31-pending-currency-phone-review-390.png` and
`qa/screens/m31-pending-currency-desktop-review-1440.png`;
`qa/report.html` remains clone-local.

Explicit counter/khata financial review and resolution, the remaining financial
families, genuine hosted phone/physical acceptance and full M30/M31 requirements
remain open. M31 is unchecked and cloud flags stay off. Workflows remain disabled
and Pages publication stays held.
