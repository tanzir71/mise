# Saved physical counts and closing review

Saved closing review is implemented and its reviewed backend is deployed.
All 3,701 unit tests, 486 browser cases and 340 visual comparisons pass, along
with strict type checks, lint and both production build paths. Wider M30/M31
acceptance remains open. Cloud flags remain off; GitHub workflows and Pages
publication stay held.

The sync settings offer a saved closing review after a guarded command request
requires review. The comparison keeps the physical cash count, original count
time, day, currency, timezone, note and surplus choice. It shows the checked
current records and the proposed closing and cash effect before an explicit
withdrawal or replacement. Complete original text can be copied, with a selectable
text fallback, and the JSON backup remains available.

Closing totals include receipts recorded by the physical count time. A receipt
recorded later does not retroactively change that count. A receipt recorded
earlier on another offline device can arrive later and require review. For
example, an earlier cash receipt of ৳10 changes a saved ৳25.01 surplus to ৳15.01
when the owner explicitly reviews the count. The physical amount counted stays
the same.

An undo retains its original closing and linked surplus receipt. Delivery binds
it to the original closing creation event from the immutable queue audit. A
reviewed replacement has a new creation event even when it keeps the same closing
and cash IDs. The queued old undo cannot automatically target that replacement.
Both ordinary delivery and pending canonical replay retain it for review. Its
replacement control is disabled when the original parent changed; withdrawal
can resolve the saved intent without undoing the revised receipt. Ordinary undo
remains limited to the original closing day and timezone.

## Durable recovery and canonical evidence

Schema 28 adds a device-only closing journal. It retains the selected complete
source, original action position, comparison, revision, explicit choices and
actual outcome. Tokens, connection settings and Auth credentials are excluded.
The portable backup keeps its existing 21-table allowlist.

The deliberate choice is saved before HTTP. A retry first asks for the actual
existing server outcome, so a lost response does not create another closing or
cash receipt. Changed comparisons require another explicit choice. Native writes
recheck the original account, outlet, operator generation, full source and image
bytes, accepted receipt prefix and active transaction. Competing revisions cannot
both submit a decision. A newly selected operator can confirm an outcome only
after ordinary guarded delivery has genuinely acknowledged the exact source.

Canonical reconciliation validates the actual resolution, complete original
source, replacement hash, ordered resolution position and entire scoped before
and after contexts. Only identities actually created by the original action are
fenced. Withdrawn creations cannot reappear through another pending action;
existing closing and cash parents remain usable. Matching rows alone do not prove
the saved action is complete.

Ordinary commands keep their 32 KB boundary. Imported undo sources and contexts
retain their 16 MB boundaries, and the review transport supports 48 MB. The actual
SQL completion and canonical checks preserve a full million-character Bengali
note with NUL and an unpaired surrogate, plus a million-character creator name,
without reducing the original payloads or test deadlines.

The pending preparation migration uses distinct SQL argument names. A real
regression reproduced an earlier resolution hiding a new undo from the
availability check because a table column shadowed the candidate command
argument. The corrected lookup compares the candidate action's new identities.

## Verification

- The combined closing, queue, pending replay, customer and transport regression
  passed 598 cases before the final UI and SQL availability regression were added.
- The updated SQL completion suite passes all 84 cases, including complete
  canonical proof checks and the fresh-review availability regression.
- Three native browser/HTTP/PostgreSQL cases pass: withdrawal and replacement
  across a lost reply and offline reload, and a dependent undo retained after its
  earlier count is reviewed. All portable tables converge between both browsers;
  original commands, source changes, cash identities and image hashes remain.
- The comparison has no horizontal overflow or axe violations at 360, 390, 768,
  1024 and 1440 pixels in the browser cases. All 270 supplied exports are present.
- The complete visual report passes all 340 comparisons, including 20 across review,
  currency-blocked, unconfirmed and changed-parent states at all five widths.
  There is no page overflow or serious/critical axe finding.
- All 3,701 unit tests across 174 files pass with the normal two workers and
  unchanged payloads/deadlines. Strict types, 163 Astro files without diagnostics,
  lint and both `/` and `/mise/` production builds pass.
- All 486 browser cases pass without failed, skipped or flaky cases. The old
  schema-14 upgrade fixture now expects schema 28 and 42 stores, preserves all
  original data assertions, and checks that both new review stores start empty.
  All seven focused coverage/upgrade cases also pass.
- Twenty local SQL-role checks pass with complete rollback of fictional rows.
  They cover client/foreign/staff/anonymous/service denial, exact outcome-first
  recovery, a distinct later review, original-parent protection and complete
  source archives. The same 20 checks pass on the hosted database with no
  fictional Auth, shop, ticket or resolution rows left afterward.

Review screenshots: [saved and proposed count](screenshots/m31-closing-review-prepared-390.png),
[changed original parent](screenshots/m31-closing-review-parent-1440.png), and
[unconfirmed outcome](screenshots/m31-closing-review-unconfirmed-390.png).

M31 provides no dedicated closing-review frame. The interface reuses the supplied
phone Today frame `102:82`, desktop Today frame `38:474`, shared app controls and
existing review layout. Visual pixel comparisons against these source frames are
informational; they do not assert an exact design for a screen absent from the
handover.

The retrieved JWT-verified commands version 34 exactly matches the reviewed
110-source, 589,301-byte bundle. All three migration sources are recorded in the
[verification record](m31-closing-review-local.json). All 70 application tables
force RLS. The private closing review tables and sequence have no direct client
or service grants. Authenticated callers can prepare their scoped review; only
the service role can complete it. Public wrappers use invoker security. There
are no anonymous/PUBLIC table privileges, public security-definer functions or
public storage buckets.

All 40 actual anonymous edge/RPC probes return 401 after valid-key 200 controls.
An actual OPTIONS request returns 204 and allows the new closing-parent header,
confirming the deployed module's preflight behavior. Security and performance
advisors report no warnings or errors. The role checks preserve exact source
archives, recover genuine outcomes first and refuse to retarget the original
undo after a reviewed cash replacement.

The complete local report is `qa/report.html`; the three review captures above
are committed. Workflows and Pages publication remain held, so there is no new CI
run, uploaded CI artifact or Pages deployment for this increment.

Actual project and organization details and all credentials remain in ignored
private inputs or the server secret manager. Hosted role checks use fictional
rows inside a rolled-back subtransaction. Phone providers, OTP delivery, server
secrets and real Auth accounts were not changed. The original physical/provider
acceptance gates, genuine signed-user acceptance and later roadmap milestones
remain open.
