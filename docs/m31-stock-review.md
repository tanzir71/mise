# M31 · Saved stock review

A rejected offline stock action has an opt-in comparison of its saved values,
current online item and proposed result. The operator can withdraw that original
action or apply a distinct reviewed replacement. Physical counts retain their
original occurrence time; relative adjustments use the checked current quantity.
Undo keeps its actual parent movement and original 24-hour deadline. A reviewed
description edit preserves current quantity and physical-count history.

The comparison includes every item in a batch, with the remaining rows and
original notes available on demand. It retains original names, units, quantities,
metadata and command IDs. Saved and current supplier selections are shown using
their checked current names, explicitly labelled as current online records. A
supplier rename invalidates consent even when the quantity is unchanged. Missing
or archived suppliers can prevent replacement without preventing withdrawal.

The immutable source is derived from the original per-action audits, including
the immediate before and after values in a grouped queue entry. Native source
fingerprints still cover the entire original entry, command order, genuine receipt
prefix and complete image bytes. Literal source and metadata remain opaque through
PostgreSQL, preserving Bengali, escaped NUL and unpaired surrogates without JSONB
normalization. Existing 1,000-line batches and command limits remain supported.

Private forced-RLS tickets bind the original account, actor, source, exact checked
state and chosen result. Authenticated callers may prepare or read a review;
only the server may finalize it. Completion rechecks live access, item identity,
unit, revisions, undo eligibility and complete proposed records under the outlet
lock. The normal stock write, genuine receipts, immutable resolution audit and
reserved identities commit together. Withdrawal changes no quantity or count
history. A later quantity action dependent on a withdrawn movement needs its own
explicit review; metadata and unrelated items remain usable.

Native schema 26 adds the internal `stockReviews` journal. Portable backup stays
schema 10 with 21 tables. Comparisons, choices and attempts are durable before
HTTP; review tokens and Auth sessions never enter that journal or backup. Every
write rechecks the original phone account, connection, operator, source and
journal revision under native locks. Canonical application requires the exact
resolution proof before retiring an original local projection.

A stopped or lost reply remains unconfirmed until its actual outcome is read.
Offline reload preserves the source, choices, queue and complete images. The panel
offers stock, JSON backup and copy controls; clipboard refusal reveals selectable
original details. An account switch aborts the active review and retains its
source. Restoring the original account may confirm a genuinely acknowledged
outcome, without reviving or submitting an older choice.

Four focused browser cases pass against actual local PostgreSQL and HTTP:
withdrawal, replacement, supplier changes and account switching after SQL commit.
They cover changed consent, lost replies, offline reload, a downloaded JSON backup,
full image preservation and two-browser convergence. Local Auth, Realtime and
Storage are explicit fixtures; these checks do not establish hosted OTP acceptance.

All 270 supplied exports are present. M31 has no dedicated stock-review frame;
the interface follows the supplied M28 Business data and Desktop 04b stock-count
tokens, cards and controls. The focused visual configuration covers review,
unconfirmed choice and changed suppliers at 360, 390, 768, 1024 and 1440 px.
All 15 focused captures have complete metrics and no horizontal overflow.
Accessibility checks before screenshot-only navigation hiding found no serious
or critical violations. Inspected captures include the [390 px comparison](../qa/screens/m31-stock-review-phone-review-390.png),
[1440 px comparison](../qa/screens/m31-stock-review-desktop-review-1440.png),
[changed suppliers](../qa/screens/m31-stock-supplier-desktop-supplier-1440.png) and
[unconfirmed choice](../qa/screens/m31-stock-unconfirmed-phone-unconfirmed-390.png).
Pixel comparisons are informational. Generated screenshots and the
[visual report](../qa/report.html) stay ignored. The complete report passes all
305 comparisons with complete metrics and no overflow, including all 15 stock
review states. Fresh phone comparison, desktop supplier and unconfirmed-choice
captures were inspected after that run; public English and Bengali font proof
also passes.

Lint and strict TypeScript checks pass, including 149 Astro files without
diagnostics. All 2,964 unit and database checks across 151 files pass in 767.24
seconds with the normal two workers, original deadlines and full 1,000/5,000-row
inputs. An initial run hit two owner-recovery deadlines; all ten unchanged owner
checks passed in isolation. Another run was stopped during verified host CPU
saturation. The final complete run passes without source or test-limit changes.
All 479 browser cases pass in 17.9 minutes with two workers and no failed,
skipped or flaky cases. Both `/` and `/mise/` builds pass. All 1,207 checked source
and asset files and 467 generated files remained unchanged through the full run.
Before commit, one extra empty line at the end of the stock-review component was
removed after proving its generated JavaScript identical. A final Pages rebuild
reproduces all 467 tested files byte for byte; the other 1,206 source files and
the exact deployed backend bundle remain unchanged.

The reviewed migration is applied and the retrieved commands function exactly
matches the 96-source, 520,260-byte candidate with JWT verification enabled.
All 66 application tables force RLS. The two private review tables have no direct
client or service grants; their sequence and internal helpers are inaccessible
to clients. Authenticated callers may prepare/read their scoped review, while
both finalizer wrappers deny anonymous and authenticated execution and allow
only the service role. There are no anonymous/PUBLIC table grants, public
security-definer functions or public buckets. Security and performance advisors
report no warnings or errors. A valid publishable-key control returns 200;
all 25 actual anonymous edge and RPC probes return 401. Auth settings and server
secrets are unchanged. The [verification record](m31-stock-review-local.json)
contains only source hashes, counts, status and static probe labels.

M30/M31 remain unchecked. Genuine hosted phone-provider and physical-device
acceptance and other conflict families remain open. Cloud flags default off.
GitHub workflows and Pages publication remain held at the owner's request.
Actual Supabase project, organization and credential values remain in ignored
private inputs or the server secret manager.
