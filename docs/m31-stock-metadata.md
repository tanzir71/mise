# Saved stock descriptions and archive choices

M31 now distinguishes a saved description from a physical stock count. A
description-only `stock.update` has no movement ID. Its original on-hand value
is a snapshot, so reconnecting must retain the latest actual quantity rather
than turn that snapshot into a new physical count.

The last description admitted by the server wins. Name, local name, category,
aliases, target, pack size, low threshold and supplier are checked against the
current scoped item. Unit remains immutable. The audit records the actual
predecessor and resulting item, including the earlier description that lost.
Original command IDs, occurrence times and outbox bytes remain unchanged.

For example, two devices start at 20 kg. One saves a name offline; the other
renames the item and receives 3 kg. When the first device reconnects, its saved
name is applied to the current 23 kg. Only the real receipt creates a stock
movement. The receipt reports the actual later revision and quantity.

An explicit archive or restore is also an ordered set intent. Repeating the
current desired state records its real predecessor without a stock movement.
A saved description arriving after an archive leaves the item archived. Its
inactive name may match another active item; it receives no active-name key
and does not silently restore the item. Restore still checks active-name
uniqueness.

Physical counts, on-hand edits with a movement ID, count batches, relative
movement count barriers and the original undo rules retain their existing
checks. A future requested revision is rejected. Metadata cannot change
on-hand quantity, last-count history, unit or archive state. SQL independently
enforces these facts even if a proposed row and its audit are coherently altered.

The same pure replay supplies server admission, pending canonical projection
and outlet recovery. There is no new native schema, backup table, command
format or review journal. The private SQL finalizer rechecks live access after
the outlet lock and retains its original service-only grants.

The stock controls also include their visible quantity, target and supplier
values in their accessible names. This preserves the layout while allowing
speech input and assistive technology to identify the displayed controls.

Verification and current delivery status are recorded in the
[redacted evidence](m31-stock-metadata-local.json). HTTP/SQL, native IndexedDB
and compiled-browser tests preserve original queues, portable records and full
image hashes. Browser coverage uses the actual stock forms and explicit
Turn on sync control, then waits for automatic delivery. Interrupted-response
coverage retains the original edit through offline reload and recovers the
single accepted receipt. Auth, Realtime and Storage fixtures remain synthetic;
they do not establish genuine hosted phone sign-in or physical-device acceptance.

Lint and strict TypeScript checks pass, including 144 Astro files without
diagnostics. All 2,778 unit tests across 142 files pass with the normal two
workers, and production builds pass at both `/` and `/mise/`. Both builds pass
their generated-output credential checks. The 23 targeted browser cases pass,
including automatic metadata sync, interrupted-response recovery, archive/name
reuse and the existing stock flows. Accessibility and overflow checks cover
360, 390, 768, 1024 and 1440 px. All 475 cases in the full browser suite pass in
15 minutes, with no failures, skips or retries. All 290 visual comparisons have
complete metrics and no horizontal overflow; the public font proof also passes.
The clone-local report is `qa/report.html`. The fresh stock phone, stock desktop
and night-count captures were inspected, with no clipping or visible layout
regression. Their relative paths are included in the evidence record; generated
reports and captures remain ignored while GitHub workflows are stopped.

The reviewed migration and commands bundle are deployed. The retrieved source
matches the exact 488,678-byte, 92-source candidate and retains JWT verification.
All 64 application tables force RLS, with no anonymous/PUBLIC table grants,
public security-definer functions or public storage buckets. Stock preparation
is authenticated; completion remains server-only, with no direct client grants
on private stock tickets. Security and performance advisors have no warnings
or errors. An actual valid-key positive control returns 200, followed by all
18 anonymous probes returning 401, including stock metadata, admission,
preparation and completion. No Auth setting, server secret, real account or SMS
was changed or created by these checks.

M30/M31 remain unticked. Other financial and quantity conflict review,
genuine hosted acceptance and later milestones remain open. Cloud setup and
sync remain off by default. GitHub workflows and Pages publication remain
stopped. Actual deployment details and credentials stay in ignored private
inputs or the server secret manager.
