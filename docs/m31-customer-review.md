# Saved customer and khata actions

Status: protocol, source, current-state comparison, atomic SQL/HTTP completion,
native recovery and review interface are verified. The reviewed migrations and
exact JWT-verified backend function are deployed.
M30 and M31 remain open;
`cloudSetup` and `cloudSync` remain off.

Two devices can save a new khata for the same customer while offline. The existing
customer command path admits the first account and rejects the competing account
without overwriting either identity. Deliberate review must preserve that rule.
Changing a saved account ID to the winning account would silently change the
financial parent of opening balances and later queued payments.

The ordinary customer codec now has its own module. Its existing field order,
fingerprints, planned companion IDs and receipt rules remain unchanged. A reviewed
proposal changes only the primary command ID. The resolution receipt distinguishes
withdrawal from replacement and retains the original customer, account and opening
entry identities. Structural parsing alone does not authorize a resolution.

The read-only source extractor selects the original append-only audits. It reads
each action's immediate before/after snapshots, even when several actions share a
transaction and the final customer or account row includes later edits. The
selected audit supplies its recording time. An opening balance separately retains
its historical balance date; its ledger entry was created when it was recorded.

The source distinguishes the following effects:

- Creating a customer also creates the default, disabled, zero-limit account,
  including when the saved command has no explicit credit terms.
- An existing-customer save may update contact details alone, change terms on its
  existing account, or implicitly create a missing current-currency account.
- Khata settings use the primary audit for either creation or a terms update;
  unused planned companion IDs are not newly created records.
- Opening balances belong to a new account, preserve integer minor units and their
  original date, and cannot conceal a sale, refund, reversal or payment link.
- Archive and restore preserve the complete existing profile. Imported older
  profile values are retained without imposing today's edit-field limits on them.

Native extraction checks account and opening rows against their audits. A grouped
contact-only action may rely on an account created by an earlier action only when
that original creation audit is present. A missing implicit creation audit requires
source recovery instead of changing the action into a contact-only edit.

The independent source hash covers complete original changes, all normalized
commands and original Blob bytes. As in the existing review families, receipts are
normalized to an empty list for this stable source identity; the original receipt
prefix is validated separately before selecting the first unconfirmed action.
Native decision writes revalidate the live prefix and complete source
under their account and connection locks. The selective wire capsule cannot prove
the absence of a missing optional audit independently of that native source.

Source JSON stays opaque text. Compact encoding preserves Bengali text, NUL and
lone surrogate code units and rejects duplicate keys. The ordinary command retains
its existing 32,000-byte bound; the separate source and review-envelope bounds are
4,000,000 and 16,000,000 bytes. Oversized or damaged sources are rejected without
truncation or local writes.

An additional check compares real tentative customer replay with the recorded
effects. It rejects implicit account creation during an originally contact-only
edit, loss of an original account creation, resurrection of a missing existing
financial parent, another monetary unit or another national-phone interpretation.
Existing BDT terms can still be reviewed after the outlet switches to USD. Every
proposed business row must agree with its tentative audit; extra rows, duplicate
IDs and concealed substitutions are rejected. This check supplies no write
authority or permission to bypass a conflict.

Local verification covers real domain mutations, real IndexedDB saves and grouped
transactions, full Blob hashing, both positive and negative tentative replays,
altered source facts and the existing customer SQL/HTTP suite. The focused run
includes 106 passing completion and HTTP guard cases, with the normal two-worker
configuration and unchanged existing test deadlines. The exact deployment-module
fixture also passes. A million-character imported note is retained through actual
SQL completion and the separately bounded response envelope. Managed SQL and
function verification are recorded below; Auth provider settings, server secrets
and real Auth accounts are unchanged.

Current-state preparation uses two private tables with forced RLS and no direct
table or sequence grants. Authenticated owner/manager functions bind the original
member, command, account plan, source and live account. The formatter independently
checks the original command and source hashes before constructing the comparison.
The client recomputes its proposed values through the ordinary mutation logic.
Server admission clocks are excluded from user choices; the original opening
balance date remains explicit.

A changed profile, account, currency or balance invalidates the prepared proof.
Authorization is rechecked after member, identity, phone-verification or outlet
assignment changes. Ordinary comparisons expose only the current outlet's accounts
and balances. Shared-contact status reviews check every associated outlet, keep
other ledgers behind an opaque hash and expose only an unsettled-balance flag.
Phone conflicts expose availability without another contact's identity or name.
A genuine original command receipt is returned before stale/expired review checks.

The SQL implementation keeps the entire original command opaque, including when
checking its fixed envelope and companion IDs. Even field access on PostgreSQL
`json` can reject unrelated NUL/surrogate text. Parsing the whole command as `json`
or `jsonb` would lose valid saved actions. The independent 43-case PostgreSQL suite
checks actual role grants, tenant isolation, revocation, stale state, shared status,
literal text and original-outcome recovery. A managed SQL-role proof also checks
completion and caller denial without persisting fictional verification rows.

The service-only finalizer commits the ordinary replacement and its resolution in
one transaction. A failed resolution audit rolls back every customer, account,
opening entry and receipt write. Created-ID barriers cover actual emitted rows;
existing financial parents and unused planned slots are not reserved as creations.
Only the internal normalized record envelope increases to 16 MB for complete
imported audit images; the ordinary 32 KB command bound remains unchanged.

The internal schema-27 journal saves display facts and deliberate attempts before
HTTP, retains all original source bytes and stores no review token or credential.
Lost replies, offline reloads, concurrent tabs and original-account reselection
use genuine outcomes before another send. A canonical boundary prevents a later
pending action from recreating a withdrawn customer, khata or opening identity;
existing canonical parents remain usable. The 83 focused journal, transport,
native-database and boundary checks pass.

The interface uses the supplied Business data and Khata references and existing
app controls. It separates saved values, last checked online values and the
reviewed result. Terms-only history does not invent a historical customer name;
the current checked name is labelled separately. Long imported fields are fully
available on expansion, and copy has a selectable fallback. The complete original
source and JSON backup remain available.

Four SQL/HTTP browser checks cover withdrawal and replacement through a lost
reply, offline reload and two-browser convergence, a competing khata, and account
switching after atomic completion. Blocked phone checks expose no other customer's
name or notes. All five required widths pass overflow and axe checks. The 15 local
visual comparisons cover prepared, blocked and unconfirmed
states; differences against the supplied general reference screens are
informational because M31 has no dedicated review frame.

All 3,361 unit cases across 163 files and all 483 browser cases pass with the
normal two-worker setting, unchanged deadlines and complete original payloads.
Both `/` and `/mise/` production builds pass their private-value checks. The full
visual report contains 320 comparisons with no horizontal overflow. The font
proof renders and measures English and Bengali samples; the existing font assets
are unchanged and their measured advance differences are recorded.

Three captures from that full run are available for review:

- [Prepared comparison at 390 px](screenshots/m31-customer-review-prepared-390.png).
- [Blocked phone at 1440 px](screenshots/m31-customer-review-blocked-1440.png).
- [Unconfirmed recovery at 390 px](screenshots/m31-customer-review-unconfirmed-390.png).

The retrieved backend exactly matches the 104-source, 562,252-byte candidate.
All 68 application tables force RLS. The two private customer review tables and
their sequence have no direct anonymous, authenticated or service grants.
Authenticated callers can prepare their scoped review; only the service role can
execute either completion wrapper. There are no PUBLIC table grants, public
security-definer functions or public buckets.

Twenty managed SQL-role cases cover all ten action forms and both outcomes,
including caller denial, source retention and idempotency. Every fictional Auth
and shop row is rolled back. All 32 actual anonymous edge/RPC probes return 401,
with valid publishable-key controls returning 200. Security and performance
advisors report no warnings or errors. Auth provider settings, server secrets and
real Auth accounts are unchanged. The [verification record](m31-customer-review-local.json)
contains only source hashes, counts, status and static probe labels.

The final diff check removed one empty line at the end of the review component
and completion migration. Transformed JavaScript and all 467 generated Pages
files are byte-for-byte unchanged, and both base-path builds pass again. The
applied SQL differs from the committed migration only by that trailing LF; both
source hashes are retained in the verification record.

The full privacy guard checks source, staged files, complete reachable history
and generated output against ten actual private values, including project and
organization references. It finds no credentials or current deployment
references. The [22 previously recorded nonsecret historical findings](security-history.md)
remain disclosed; new findings block a push. GitHub secret scanning and push
protection are enabled, with no open secret alerts.

Full M30/M31 acceptance, genuine phone-provider commissioning, physical-device
checks and other conflict families remain open. Cloud flags remain off.
Private deployment values remain outside Git. Workflows and Pages publication
remain held.
