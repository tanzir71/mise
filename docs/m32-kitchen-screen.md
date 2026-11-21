# M32 shared preparation screen — in progress

The opt-in kitchen screen shows real preparation tickets on an enrolled second device. Got it and Ready are saved to native IndexedDB before delivery. Offline reload, a lost reply or a later staff sign-in retains the original ticket, tap IDs and staff session. A saved tap is labelled pending until the device receives its actual scoped receipt.

`kitchenScreen` stays off by default. M32 remains unchecked: configurable Inbox alarms, desk push, expired-session tap review and final hosted acceptance remain open. GitHub workflows and Pages publication stay stopped at the owner's request. This note is an implementation record, not a new published-site announcement.

## Ticket access and storage

The reader derives the business and outlet from the enrolled device and current PIN session. It returns preparation names, quantities, notes, substitutions, schedule, status and acknowledgement metadata. Customer contact, original-message, address, price and payment fields are not returned to the browser. The shared screen does not import owner Auth or the owner's working database.

The dedicated screen database upgrades from version 1 to 2 without replacing its original enrollment or revision. Tickets and taps live in a separate store keyed by enrolled device ID. Sign-out and removing an enrollment preserve earlier preparation work. Native writes compare both the complete original screen record and the complete cache; quota failure, an ended route or a stale tab cannot replace the retained source.

Each tap retains its original staff access metadata, complete visible ticket, revision, content hash, occurrence time and generated action/event IDs. Ready uses an actual or earlier queued Got it parent. Delivery follows that parent and never substitutes a different member or PIN session. A changed ticket remains available for explicit review. A matching status or feed cursor cannot confirm a tap.

## Realtime and reconnects

Order and acknowledgement changes append an IDs-only scoped cursor entry and publish a private Broadcast hint. The trigger acquires a transaction-level outlet fence before allocating its sequence. A later write in that outlet cannot commit a larger feed number while an earlier one remains invisible. Different outlets use independent fences. The lock ends with commit or rollback.

The `kitchen-live` Edge Function authenticates both original device/session secrets, derives the outlet, joins only that private topic and checks current access again before opening its stream. It checks access again before each signal and heartbeat. Revocation closes the stream; no broker payload or order body is forwarded.

The server's WebSocket upgrade carries the new service API key in a header. The URL, channel messages and browser never receive it. This uses the supported private Broadcast protocol without giving a kitchen device an owner JWT or relying on a legacy service-role JWT.

The browser receives only closed ready/wake/heartbeat/auth metadata through a POST stream. Every wake runs the ordinary scoped cursor reader. Pulls and tap delivery can progress independently, and a signal arriving during a pull schedules another pull. The stream rotates within 110 seconds, reconnects with backoff and heals through the saved cursor. A ten-second fallback and Check now remain available when realtime is disconnected.

## Interface and visual evidence

The supplied Kitchen tablet (`65:1843`) and kitchen phone (`107:1222`) exports guide the ticket grid, status words, large quantities and controls. The desktop grid has up to four equal-height cards per row; phone tabs show actual New, Cooking and Ready counts. New-ticket sound requires a user gesture. Wake lock reports failure and leaves the device sleep-setting fallback available. Copy ticket remains available for manual coordination.

`qa/configs/m32-kitchen.json` adds fifteen visual comparisons at 360, 390, 768, 1024 and 1440 px. Its board, offline and queued states use actual domain orders, PIN checks, PostgreSQL roles, WebSocket/HTTP transports and native storage with synthetic identities. Each capture also checks WCAG AA. Hardware bezels, fixture text and current clocks differ from the exports; unfinished batch/translation/pack-check controls are not fabricated.

Generate the local evidence with `pnpm qa:visual`. The report is `qa/report.html`; three representative captures are `qa/screens/m32-kitchen-board-tablet-1440.png`, `qa/screens/m32-kitchen-offline-phone-390.png` and `qa/screens/m32-kitchen-queued-phone-390.png`. No CI artifact link or new Pages URL is claimed while those services are held.

## Verification status

All 193 unit files (3,968 cases) pass across the verified runs, including outlet fences, original-source retention, delayed reads, live revocation and malformed signals. The complete inventory was reconciled after the initial whole-suite command ended without its final summary. Lint, strict types and the full Pages-path build pass; the generated source/output scan checks ten configured private values with no current credential or deployment-identifier findings.

All 509 Pages-path browser cases pass (20.9 minutes), including the eight new kitchen cases. They verify the complete local SQL-notify → private WebSocket → authenticated stream → scoped reader → native cache → UI path within two seconds, alongside offline reload and exact lost-reply recovery. The five required widths have no horizontal overflow or automated WCAG AA violations. The local broker implements the documented Broadcast wire protocol; this is not a claim of genuine provider sign-in or final hosted latency acceptance.

All 380 visual comparisons complete with no horizontal overflow, including fifteen kitchen captures and their automated WCAG AA checks. The full root-path build, sixteen root app browser cases and seven native storage cases pass; the final Pages-path build is restored. The native storage cases use an intercepted harness and exercise actual IndexedDB independently of the compiled site's base.

The managed database now has 54 migrations and 75 application tables, all with forced RLS. Anonymous/PUBLIC table grants, public definers, public buckets and direct client kitchen RPC grants remain absent. Both new functions are deployed at version 1 with their own device/session authentication. Retrieved source bytes exactly match the reviewed bundles; all nine existing functions retain their previous versions and JWT settings. Security and performance advisors each report one informational notice, with no warnings or errors.

All 23 hosted transport checks pass, including a valid enrolled-device read, actual private Broadcast → deployed relay → scoped reread, closed stream metadata, live revocation and revoked-device denial. The isolated committed fixture creates no Auth accounts; cleanup verifies zero remaining shops, devices, orders, kitchen-feed rows or sync-history rows. Another 29 managed role checks pass with their fictional Auth/shop rows fully rolled back. These prove the deployed transport and authorization boundaries, not genuine phone-provider or physical-device acceptance. The two-second acceptance remains established by the complete local browser path; final hosted latency acceptance is still open.

The [verification record](m32-kitchen-screen-verification.json) contains only source hashes, versions and closed check metadata. Actual project, organization, connection and credential values stay private. The existing preparation action backend is documented separately in `m32-kitchen-actions.md`; its action/receipt protocol is unchanged. M32 stays open and the flag stays off while alarms, push and expired-session recovery are completed.
