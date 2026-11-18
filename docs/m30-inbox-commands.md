# M30 · Original Inbox captures and manual sorting

The command family records original shared text, title, URL and image metadata,
then supports reviewed classification, archive and reopen. It preserves the local
rules: source text is inert, a link is never fetched, and sorting does not create
an order, payment, invoice or stock movement. Those manual forms retain their own
reviewed transactions. Original sources remain available until explicitly archived.

Device source/action/image IDs and original source creation times survive retries.
A share captured before onboarding retains that earlier creation time when claimed.
Source updates use the existing monotonic history clock; server admission time is
separate in the receipt. Source text and every image name stay literal, including
NUL and lone surrogates. A maximum-size capture retains every character. Old
reviewed revisions stop before a new sorting choice can overwrite them.

Original image positions, names, MIME types, sizes and SHA-256 values are immutable.
Capture saves pending metadata only. The four-image, 5 MB each and 10 MB aggregate
limits remain. Original bytes use the existing private image endpoint; metadata
cannot claim an upload succeeded. Image-upload confirmations do not replace or
advance the source sorting revision, and sorting preserves upload status.

The shared local capture/claim/sort mutations accept stable audit IDs and a minimal
verified member. Private forced-RLS tickets have sixty-second expiry and a
hundred-live-ticket quota per caller. Public wrappers remain invokers. Original
confirmed owners or assigned managers prepare; only service completion writes
after live identity, assignment, proof, scope, snapshot and reviewed-revision checks
under business-then-outlet locks. Capture IDs are insert-only. Item/image/audit and
original-actor receipt commit together, or all roll back.

Repeating a current sorting choice creates no new source revision or source audit.
The server retains a metadata-only `command.noop` audit and its replay receipt,
preserving the existing receipt foreign key. That log has no source-history
revision. Original receipts replay after later sorting choices without reverting
current data. Source races alone allow at most three preparations; a changed
reviewed revision requires retained-intent review.

PostgreSQL JSON extraction decodes strings even when requesting JSON output.
Source fields therefore travel as separately encoded literal JSON tokens in the
JSON-safe private plan. Audit comparison quotes complete raw value-string tokens
before JSONB structural comparison, preserving literal NUL versus its printed
escape without depending on object property order. SQL constructs stored snapshots
from authoritative source fields. UTF-16 length and ECMAScript whitespace checks
process bounded regex token runs, preserving the original limits without quadratic
scans. SQL never extracts whole source snapshots or business JSON.

`X-Mise-Inbox-Write` proves original-caller outlet access before a 256,000-byte,
twenty-second capture reader. Capture RPCs allow fifteen seconds and the client
120 seconds. Manual changes keep the ordinary 32,000-byte/five-second reader,
five-second RPCs and 45-second client boundary. All five admission headers are
mutually exclusive. Source strings, image facts and manual choices freeze before
asynchronous Auth. Client errors never echo database messages or details.

Native verification covers literal sources, all kinds, archive/reopen/no-op,
historical replay, all eight live revocations, scope isolation, quotas, proofs,
maximum source/image limits, Unicode counting, source races, private/raw access,
foreign identity collisions, payload tampering and complete rollback. The exact
deployment module checks original-JWT admission/preparation and service-only
completion. The fourteen-action hosted-role fixture includes image and link
captures, every kind, archive/reopen, two unchanged choices and historical replay;
it rolls back all fictional Auth/business/ticket rows.

All 25 migrations and `commands` v12 are deployed with JWT verification enabled.
The deployed module matches the checked bundle and its 54 source hashes. The
hosted fourteen-action proof passes: two sources, four pending images, twelve
source audits and two metadata-only no-op audits. All fictional Auth, business
and ticket rows roll back. All sixteen actual HTTP/CORS checks pass. All 47
application tables force RLS, with no anonymous table grants, raw client writes or
public security-definer functions; security and performance advisors report no
warnings or errors. See [redacted evidence](m30-inbox-hosted.json).

All 1,548 unit tests across 86 files, lint, strict typechecking, both production
base paths and all 298 browser checks pass. The browser suite uses two workers
with no retries, failures, skips, flaky results or global errors. Phone OTP, positive
signed-owner HTTP, app/upload/outbox integration and remaining staff/agent
resources remain open. No new layout or visual comparison is claimed. GitHub
workflows and Pages publication stay held. Actual deployment references,
credentials and private operational paths stay out of public evidence.
