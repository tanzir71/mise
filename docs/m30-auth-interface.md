# M30 · Runtime phone sign-in and private configuration

The default-off `cloudSetup` flag adds Settings › Sync setup to More. It accepts
the project's HTTPS URL and publishable key on the device, requests a phone code
only after an explicit tap and retains the normal local shop and backup fallback.
The interface does not turn on sync or claim that any record was uploaded.

The official Supabase JavaScript SDK is pinned to 2.119.0. Its Node requirement
raises the repository floor to 22.12+; local checks use Node 24.22.2. Disabled GitHub
workflow templates use Node 22 without enabling or dispatching any workflow.

Connection values never come from build environment variables. Actual project
identifiers, publishable/server keys, PIN peppers and operational records remain
outside source and static artifacts. A device connection accepts only a modern
publishable key, with no privileged key or legacy JWT. URL credentials, query
strings, paths and non-loopback plain HTTP are rejected. Errors do not echo input
or raw Auth responses. Only owner-app documents allow runtime HTTPS connections;
public shop and marketing policies retain their existing restricted connections.

The SDK owns persistence and refresh. Session storage is derived from a SHA-256
digest of the project, key, base path and shop; shop records and JSON backups contain
no Auth state. Fresh `getUser` verification requires the same account as the SDK
session, a confirmed phone and a non-anonymous identity. Editable user metadata
grants no role or authority. Server membership and outlet checks remain required
for every eventual upload or command.

Phone requests first check the Auth settings endpoint and stop when the phone
provider is disabled or phone autoconfirm is enabled. The explicit SMS flow has a
resend cooldown, fixed rate-limit errors, Bangla-digit code support and a bounded
saved challenge so reloading need not send another SMS. Resends retain the actual
requested number across reloads, including a number different from the shop profile.
Storage failure keeps a
temporary session without claiming it was saved. Cross-tab logout rereads storage
without restoring stale memory. Closing aborts outstanding requests and prevents
late verification from recreating credentials. Removal failures are reported and
can be retried. Sign-out retains local shop data and the connection settings.

The local review snapshots all 21 existing backup tables and original image counts
in the separate upload journal. It survives reload and does not contact Auth,
upload records, replace shop data or mark anything synced. Review work is scoped
to the current shop and ignores late results after navigation. Upload activation
still needs its full outbox boundary and acceptance checks.

M30 specifies no dedicated Auth/Sync frame. This interface adapts the supplied
M27 More and Desktop 14 Business data shells, shared cards, tokens, original icons
and 44px controls. The export check passed for all 270 assets. Fifteen visual
comparisons cover connection, code entry and verified local review at 360, 390,
768, 1024 and 1440px. Differences from those existing shell references remain
informational. Three inspected local captures are:

- `qa/screens/m30-auth-connection-phone-screen-390.png`
- `qa/screens/m30-auth-code-desktop-screen-1440.png`
- `qa/screens/m30-auth-verified-review-phone-screen-390.png`

Run `BASE_PATH=/mise/ pnpm qa:visual qa/configs/m30-auth.json` to regenerate the
local report at `qa/report.html`. The shared fixture intercepts all Auth responses
on `https://cloud.test`; its synthetic tokens are generated at test runtime and
never identify or access a real hosted account. No actual SMS, user creation or
positive hosted owner authorization is claimed by these browser checks.

The latest source/history/artifact scan compares nine private deployment values
in memory. It finds zero credentials, zero current deployment references and zero
coverage gaps; 22 old nonsecret identifier findings remain in published history.
The read-only hosted check confirms 47 forced-RLS application tables, no anonymous
table grants, no direct client writes, no public security-definer functions and no
public buckets. Security advisors report no warnings or errors. Phone, email and
anonymous providers remain disabled and signups are disabled. No hosted setting,
migration, Edge Function or secret changed in this increment.

[Redacted verification results](m30-auth-local.json) retain the final local checks.
M30 stays unticked. Production OTP commissioning, positive signed-owner HTTP,
upload/outbox activation and remaining staff/agent interfaces remain open. All
GitHub workflows are disabled by the owner; the last published Pages revision
remains `9ea1991f370fcdc0bb6bf6e2468baa9163d7b0bc`. There is no CI artifact or new
deployment to link while publication is stopped.
