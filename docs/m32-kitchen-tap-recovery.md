# M32 saved preparation taps — in progress

This note records the recovery delivery checkpoint. [Preparation after an explicit undo](m32-kitchen-undo.md) documents the subsequent distinction between historical proof and the current acknowledgement.

A fresh staff PIN can check what happened to a tap saved by an earlier PIN session on the same enrolled screen. A real accepted receipt keeps its original member, session, action ID, ticket and occurrence time. A pending lookup confirms nothing and never resends the earlier gesture as the new member.

The Saved taps panel keeps the complete original preparation ticket available to copy. Check confirmation performs a scoped lookup. Close saved tap explicitly journals a review request on the device before any HTTP write. Closing an unaccepted tap changes no order status, price or payment. A new Got it or Ready gesture must be made on the current ticket.

## Original identity and atomic recovery

The recovery endpoint authenticates both the enrolled device and the current PIN session. It verifies that the original session, member, business and outlet belong to that same physical device. Read access permits outcome lookup; closing also requires the corresponding preparation permission from the current session. A changed original body or another device's prepared request is rejected.

Acceptance, preparation and closure serialize on the original action's transaction advisory lock. If acceptance already committed, recovery returns its real receipt. Otherwise, explicit closure retains the complete original action and the reviewing member, removes every matching prepared plan and prevents another plan for that action ID. Finalization rereads its prepared plan under the same lock, so an older in-flight request cannot commit after closure. No accepted receipt is invented or removed.

The isolated screen database stays at version 2. Its kitchen-state wire format upgrades from version 1 to 2 only when review metadata is needed. Unchanged version 1 caches retain their original representation. Native writes compare the complete enrollment and complete cache; failed storage, stale tabs and changed PIN sessions retain the original work.

A lost close reply retries the saved review ID, reviewer and occurrence time under the same PIN session. After a different PIN signs in, the screen looks up that earlier intent without resending it as the new member. Another deliberate close retains both review intents. The actual server outcome ends the uncertainty. An accepted earlier Got it may parent a new Ready gesture without changing either member's identity.

## Interface and independent delivery

Saved taps are collapsed by default. Expanded review puts unconfirmed work first and shows twenty records at a time, with more history available explicitly. Original ticket details and Copy remain available offline. Check confirmation reports the actual server outcome; Close saved tap remains available offline when the current staff permission allows it.

Ticket pulls, normal delivery and saved-tap recovery have independent workers. Short native compare-and-swap writes merge their results. A held recovery response cannot hold up a newly committed order. Signing out pauses delivery immediately on the gesture, before asynchronous profile writes; a failed sign-out stays paused and can be retried. An older Ready receipt cannot hide a newer canonical owner undo.

The supplied Kitchen tablet (`65:1843`) and phone (`107:1222`) remain the visual references. Their exports contain no saved-tap recovery panel; the added panel follows their typography, monochrome surfaces and large controls. The review fixture in `qa/configs/m32-kitchen.json` exercises actual offline native storage at 360, 390, 768, 1024 and 1440 px, alongside automated WCAG AA checks.

## Verification and remaining delivery

The current focused checks pass: 42 SQL/domain action cases, 20 native recovery cases, 20 HTTP boundary cases and 18 actual kitchen browser cases. Browser cases cover the production PIN forms, older-session accepted receipts, deliberate closure without preparation or money changes, lost closure replies, a held recovery response, owner undo, offline reload and all five widths. The complete local SQL → private WebSocket → authenticated stream → scoped read → native UI path meets the two-second target, including while recovery is held.

All 4,004 unit cases in 194 files and all 519 Pages-path browser cases pass. The complete browser run took 18.6 minutes, with no skipped or failed cases. The eighteen kitchen cases include both ordinary tickets and expanded review at all five widths, with no horizontal overflow or automated WCAG AA violations.

All 385 visual comparisons complete with no horizontal overflow, including twenty kitchen captures and their automated WCAG AA checks. Five captures cover the new expanded saved-tap review. The local report is `qa/report.html`; the inspected representative screenshots are `qa/screens/m32-kitchen-review-phone-390.png`, `qa/screens/m32-kitchen-review-tablet-1440.png` and `qa/screens/m32-kitchen-board-tablet-1440.png`. Pixel differences are informational because the supplied frames do not include the new recovery panel. No CI artifact or new Pages publication is claimed while those services are held.

The full root-path build and all 33 selected browser cases pass: 26 exercise the compiled app and seven use an intercepted native IndexedDB harness independently of the compiled base. The complete Pages-path build is restored. The [verification record](m32-kitchen-tap-recovery-verification.json) retains source hashes, versions, closed check results and the remaining milestone gates. Normal commit/push guards stay enabled; a full history/artifact credential scan is required before pushing.

The deployed recovery endpoint is version 1 with its own device/current-PIN authentication. Its retrieved source exactly matches the reviewed bundle; all eleven earlier functions retain their versions and JWT settings. The managed database has 55 migrations and 76 application tables, all with forced RLS. Anonymous/PUBLIC table grants, public definers, public buckets and direct client kitchen RPC grants remain absent. The service role may call the recovery function but cannot read or write closure rows directly. Security and performance advisors report no warnings or errors.

All 24 hosted recovery checks pass, including an actual original acceptance, a different current reviewer, explicit closure, lost-reply retry, late prepared-request denial, expired original-session denial and recovery of its genuine earlier receipt. Another 29 managed role checks pass with their fictional Auth/shop rows rolled back. The committed synthetic device fixture creates no Auth accounts; exact cleanup verifies zero rows in fourteen affected areas, including closures, receipts, prepared plans and sync history. These checks cannot establish genuine phone-provider or physical-device acceptance.

M32 remains unchecked and `kitchenScreen` remains off by default. Configurable unacknowledged alarms, authoritative Inbox tasks, desk push and final milestone acceptance still need completion. GitHub workflows and Pages publication stay stopped at the owner's request. Actual Supabase project, organization, connection and credential values remain outside tracked files.
