# Shared-device access — work in progress

The owner and shared-screen interfaces are implemented behind `deviceAccess`,
which defaults off. The reviewed pairing migration and exact device-access/PIN
function bundles are deployed. M30/M31 and the original phone-provider,
genuine signed-owner HTTP, physical-device and publication acceptance gates remain
open. GitHub workflows and Pages publication remain held.

The supplied pairing frame `66:1846` uses a six-digit code. A short code selects
an approval request; it never grants a device credential. The new screen creates
a random 32-byte secret and submits its hash. A live, confirmed owner or assigned
manager compares the complete verification shown on both devices before
approving. SQL then installs only that hash into the existing device table.
The screen retains its secret and presents it only for HTTPS authentication;
server tables, owner views and audits retain no recoverable device secret.
Setup links may carry runtime connection and pairing details, with no
device/session credential.

Invitations expire after ten minutes and retain the original identity, code and
expiry on retry. At most five distinct screens may request each invitation; only
one can be approved. Approvals and cancellation recover their actual existing
outcomes. Device revocation, current membership, outlet assignment, confirmed
phone and anonymous/ban/deletion checks remain enforced. Expiry is rechecked
after locks before a new approval. Codes and hashes never enter public audits.

Two new private tables force RLS and grant no direct client or service access.
Public wrappers use invoker security. Owner/assigned-manager calls manage their
outlet's devices and invitations; only owners can read global PIN configuration
for that business. Inactive or unassigned staff remain visible to the owner for
PIN removal. Device-side request, outcome and staff-directory RPCs are
service-only, behind the custom device-authenticated function.

The staff directory exposes only current eligible member IDs and literal names,
in ordered pages. It contains no contact details, Auth UUIDs, PIN verifiers,
prices or ledger data. Literal names are transported as JSON text so Bangla, NUL
and lone surrogate values remain inert and intact. An initial SQL/HTTP test
caught an implicit JSONB conversion losing that transport shape; the explicit
text projection fixes it.

The function accepts only fixed bounded actions: request approval, check the
original outcome, list eligible staff, check a current PIN session and sign out.
It authenticates the screen secret itself, matching the existing device PIN and
order-read endpoints. Its request and service-response deadlines remain five
seconds, including stalled response bodies. Errors are generic, responses are
uncached, redirects and cookies are excluded, and credentials never enter URLs.

The owner API client uses the existing original-phone-account transport, checks
the expected outlet/operator and binds results to their uninterrupted account
generation. It retains original request/event IDs through asynchronous Auth and
rejects a response that changes the screen name, mode, outlet or identity. PIN
changes use only the existing owner-only PIN function.

The screen transport uses fixed HTTPS endpoints and the original screen secret,
with no owner Auth, cookies, redirects or credentials in URLs. Responses have a
total deadline and size limit; current local generation and the original device,
outlet, member and session are checked. Backend errors remain generic. A retry
cannot silently replace the original source or widen kitchen permissions.

The separate native IndexedDB journal saves the original pairing ID, random
secret, code and private connection before any request. Complete-record comparison
and new revisions serialize competing tabs, reject changed bytes and retain a
tombstone when a pairing is forgotten. Writes resolve only after transaction
completion; quota failures preserve the earlier record. Reloads poll the original
request before resubmitting, including an approval whose first reply was lost.
No screen credential or session joins the shop's 21-table portable backup.

Each PIN attempt also has a durable ID before HTTP. Its four digits remain only
in the sign-in invocation and HTTPS request. If authentication succeeds but its reply
or local save fails, that attempt remains available for recovery. A service-only
reset closes the screen's sessions and retires outstanding attempts without
resetting guessing counters. It can retire an attempt before a delayed begin
reaches SQL. Exact reset retries return the original receipt without closing a
newer explicit sign-in. Device-secret authentication permits this cleanup even
after device revocation; it never restores access. Audit rows contain metadata
and the screen's system actor identity, with no PIN, verifier or secret.

The controller refuses normal work in a profile containing owner records,
unassigned shares, an owner connection or owner SDK sign-in. Read-only inspection
covers production database names scoped to an app path and sibling Mise paths;
it never imports the owner UI, creates its stores or deletes shop records. Owner
data appearing while authentication is in flight prevents a local staff grant.
Cleanup remains possible so that pending device access can be closed and removed.

## Owner and shared-screen interfaces

Owners and assigned managers use Settings → Shared screens to name a screen,
create a six-digit invitation and copy its setup link or scan its actual QR.
Approval requires comparing every verification group and explicitly checking
that they match. Revocation and invitation cancellation retain their original
request IDs through lost replies and reloads. Current SQL access, the original
phone account and selected outlet are checked before results can be accepted.
A server access denial removes the already-open administration controls.

Only owners can set or clear staff PINs. Digits remain in the invocation and
HTTPS body; the local retry record contains no PIN or Auth token. Former staff,
inactive members and members whose outlet assignment was removed remain visible
for PIN clearing. A rider role never becomes eligible for shared-screen login.

The standalone `/screen/` route loads before the owner app or database. Supplied
setup fragments are removed before route/network activity; they contain no
screen secret, PIN or session. Manual connection and six-digit code entry remain
available. Staff choose their name and enter their own four-digit PIN; the screen
never uses an owner Auth session. Interrupted successful sign-ins must close the
original attempt before another explicit sign-in. An optional PWA install action
uses the browser's actual installation capability.

A reserved shared-screen profile cannot open the owner workspace. Conversely,
existing owner data blocks pairing without deleting records or sign-in state.
Ordinary focus checks preserve an owner's unsaved form. Native notifications
contain only a profile-change signal, and unchanged polling receipts do not
rewrite the journal. M32 tickets, realtime display, alarms and offline tap queues
remain later work; the setup interface does not claim they are ready.

## Local evidence

The focused run covers 257 cases across 18 files: pairing/protocol/HTTP, original
account guards, owner administration, native screen storage/controller and
existing PIN/device/order regressions. The SQL tests load all 51 local migrations
and exercise actual roles. The HTTP path approves a screen, derives a real staff
PIN proof, reads its scoped session/orders and revokes the session on logout.
Actual pairing/cancellation/reset SQL audits also pass native cursor download,
canonical reconstruction and portable backup validation without private device
tables or secrets. These checks create no real Auth account or SMS.

Seven Chromium cases check actual native storage: full reload, competing
transactions, quota rejection, a stale network response, a scoped owner database
with an unassigned share, owner Auth isolation and route closure before a write.
Their intercepted harness
exists only in the test browser; it adds no diagnostic route to production.
The browser harness explicitly serves UTF-8 so Bengali code entry retains its
original digits. Eight additional rendered cases cover separate-profile owner
approval and staff login, owner PIN set/clear, current manager revocation, exact
retry after a lost owner response, lost successful PIN recovery, manager scope
denials, owner-profile preservation and a disabled reserved route. All 15 cases
pass against the Pages-base production build with two workers. The fixture uses
all local SQL migrations, actual Edge handlers and real PIN derivation; verified
Auth is explicitly synthetic. Staff issue no owner Auth requests and create no
owner workspace database. This does not establish real hosted-user acceptance.

All 3,818 unit cases across 187 files pass with the normal two-worker setting.
The full run takes 480.27 seconds; original bulk payloads and deadlines remain
unchanged. Strict TypeScript checks and 166 Astro files pass without diagnostics.
Lint and both production builds at `/` and `/mise/` pass their privacy checks
against ten private comparison values, with no credentials or deployment
identifiers found. The latest 13 handler/HTTP checks exercise the production
service adapter against named arguments from the actual PostgreSQL catalog.

All 270 exports are present. The supplied tablet pairing, tablet kitchen, phone
kitchen and business-settings images have been inspected. Visual comparisons use
`66:1846` for the pairing layout and `74:2354` for owner settings; the M30 PIN and
recovery content has no dedicated frame. Pixel differences are informational.
All 25 owner/setup/comparison/PIN/recovery captures pass at 360, 390, 768, 1024
and 1440 pixels, with zero axe violations and no horizontal overflow. The
visual fixture waits for the resolved native SQL receipt and compares its exact
verification with the rendered screen before the actual owner SQL approval.
Three actual captures use synthetic shop and connection data:

- [Owner screen settings at 1440 px](evidence/m30-device-access/owner-settings-1440.png).
- [Screen setup at 390 px](evidence/m30-device-access/screen-setup-390.png).
- [Interrupted sign-in recovery at 390 px](evidence/m30-device-access/screen-recovery-390.png).

The full report contains 365 comparisons with no horizontal overflow. All 501
Pages browser cases pass in 14.7 minutes with two workers, with no failed,
skipped or retried cases. The 15 focused screen cases also pass on the root-base
production build. The [verification record](m30-device-access-local.json) retains
the source hashes, counts, initial failures and final complete recheck.

Two initial full browser runs each passed 500 cases and exposed a setup race.
The concurrent-write case now waits for the owner's durable server receipts
before reconnecting the manager, preserving the intended admission order. The
two-profile offline-cash case now waits for both calculators to load before
disconnecting; its trace showed unfinished manager imports failing offline.
Each corrected case passes three repeated runs before the complete 501-case
recheck. Original data assertions, automatic delivery and deadlines remain
unchanged. These local checks do not complete the wider M30 acceptance gates.

## Hosted verification

The deployed `device-access` version 2 and PIN function versions 3 match the
reviewed compiled files exactly. The existing commands version 34 remains
unchanged and keeps JWT verification enabled. The device endpoints authenticate
their own screen credentials; owner PIN settings retain platform JWT checks.
The project has 51 migrations and 72 application tables, all forcing RLS, with
no anonymous/PUBLIC table grants, public security-definer functions or public
storage buckets. Security and performance advisors report no warnings or errors.

All 19 managed SQL role checks pass and roll back their synthetic Auth and shop
rows. They cover exact owner invitation retry, full comparison, manager/outlet
boundaries, private-table denial, staff discovery, original sign-out recovery,
live revocation and secret-free audits. These checks commission no phone provider
and do not establish genuine signed-owner HTTP acceptance.

All 24 hosted HTTP checks pass after a valid-key 200 control. OPTIONS returns
204 with the expected origin and authorization header. Initial checks caught two
session calls using private-helper argument names instead of the published RPC
names. Both calls now use `p_device_token` and `p_session_token`; the SQL-backed
integration exercises the production adapter and checks those names from the
catalog. No denial expectation, payload or deadline was weakened.

Actual project and organization identifiers and all credentials stay in ignored
private inputs or the server secret manager. Workflows, CI artifact publication
and Pages deployment remain held by the owner.
