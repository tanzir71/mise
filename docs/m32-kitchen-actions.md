# Kitchen preparation backend — M32 in progress

Got it records that staff saw a particular ticket. Ready advances only an
already confirmed, fully priced order through its normal preparation stages.
Neither operation changes prices, payments, customer details, commercial
confirmation, cancellation or delivery.

This is a backend increment. M32 remains unchecked. The kitchen interface,
cached tickets, native offline queue, realtime delivery within two seconds,
two-minute Inbox alarm and web push to desk devices still need implementation
and verification. Device access and cloud flags remain off. Workflows and Pages
publication remain stopped; there is no new CI run or published site for this
increment. No kitchen screenshot is presented as a finished implementation.

## Original intent and authorization

Every tap retains its order/outlet, source revision, complete visible-content
hash, occurrence time and four planned identities. Ready also retains its
actual Got it receipt. A new line, changed quantity, note, swap, table, schedule
or cancellation requires fresh review. The hash preserves NUL and lone UTF-16
code units. Contact, payment and price edits retain the current private values
while an unchanged preparation intent is replayed over them.

The shared screen supplies only its enrolled-device secret, short staff-session
secret and closed action plan. It supplies no owner JWT, member authority,
permissions, full order or proposed financial record. The `kitchen-actions`
function performs its own authentication through service-only SQL admission.
Its fixed POST requests keep secrets out of URLs. Errors and successful replies
are uncached; errors never include provider details or private SQL context.

Private forced-RLS preparation tickets bind the original action, live device,
session, member, outlet and complete server snapshot. They expire after one
minute. Finalization locks and rechecks the current device, staff session,
member, PIN and outlet assignment before writing. Revocation, lost permission,
expired tickets and changed snapshots retain the original action for review or
retry. Counter preparation requires explicit acknowledgement/Ready grants;
existing counter users acquire no preparation permission by default.

SQL writes only status, status time, status-event ID, revision and update time.
It constructs the full before/after images for the existing owner audit feed.
Staff receive only the closed preparation receipt, containing IDs, status,
content hash and times. Customer text, original source messages, money, device
secrets and session secrets never enter that receipt. Private receipt lookup
returns the original committed result after a lost HTTP reply and refuses a
different action, device, session or member.

## Preparation rules

| Business | Required preparation stage | Ready result |
| --- | --- | --- |
| Restaurant | Confirmed, kitchen has it or cooking | Ready |
| Online shop | Confirmed | Packed |
| Food stall | Ordered or making | Ready · call out |
| Corner shop | Accepted or packing | Ready |

Got it may record an unpriced or pre-confirmation ticket, and may acknowledge a
cancelled ticket without reopening it. Optional preparation advancement still
requires complete pricing. A Ready attempt cannot silently approve an unresolved
swap, skip commercial confirmation, deliver an order or reverse a later stage.

The pure alarm calculation defaults to two minutes and starts scheduled work
when due. Only an acknowledgement matching current preparation content stops
that calculation. It is not a scheduled backend alarm, Inbox task or web-push
delivery; those required parts of M32 remain unfinished.

## Verification

Focused checks exercise the real TypeScript domain model, all migrations in
native PostgreSQL/WASM, the production HTTP handler and production RPC adapter.
The adapter uses actual PostgreSQL named arguments rather than a positional
callback. Coverage includes all four business packs, lost replies, cross-screen
receipt replay, changed snapshots, literal text, full existing source limits,
current financial-field preservation, unpriced tickets, revocation during a
request, malformed/over-sharing replies, deadlines and anonymous SQL denial.

The [verification record](m32-kitchen-actions-local.json) records 3,905 passing
unit cases across 190 files, strict TypeScript with 167 Astro files and no
diagnostics, passing lint, and successful production builds at `/` and `/mise/`.
All 501 Pages browser cases and 15 root shared-screen cases pass. The visual
report contains 365 comparisons at 360, 390, 768, 1024 and 1440 pixels, with no
horizontal overflow; all 25 shared-screen captures have no axe violations.
Pixel differences remain informational. The final 25 native SQL/HTTP cases and
29 managed-role checks pass against the schema with the index follow-up. The
original bulk limits, complete source payloads and deadlines remain unchanged.

The deployed kitchen function and compatible device-access function were
retrieved and match their reviewed bundles byte for byte. All 74 application
tables force RLS, with no anonymous/PUBLIC table grants, public definers, public
buckets or direct client access to the kitchen mutation RPCs. All 29 managed
SQL-role checks pass with fictional Auth/shop rows rolled back; all 13 hosted
HTTP checks pass after a valid publishable-key 200 control. The missing receipt
foreign-key index found during review is installed; advisors have no warnings
or errors. No Auth-provider configuration or server secret was changed.

Synthetic SQL fixtures do not establish genuine phone-provider, physical-device,
offline-screen, realtime or notification acceptance. The visual captures cover
existing landing/app regressions, rather than a new kitchen interface.
