# M37 · General urgent notification backend

This increment adds a separate server protocol for urgent Inbox tasks. Existing kitchen subscriptions keep their original purpose: they are not silently enrolled in other alerts. The native consent controls, service-worker presentation and notification-click interface still need integration. `ownerTasks` stays off, delivery defaults off, and full M37 acceptance remains open.

## Consent and original requests

An actual confirmed phone account can enable general urgent alerts only for its own active desk subscription and current owner or assigned-manager scope. A consent retains its original subscription, member, role and creation event. Only one active consent may use that subscription. A later role change needs a new deliberate choice.

`urgent-inbox-notifications` uses platform JWT verification and forwards the original phone JWT and publishable API key to SQL. It exposes configuration, registration, current metadata, exact original inspection, withdrawal and authenticated task-target reads. It never accepts a caller-selected message, endpoint, task contents or URL. Configuration returns the scoped context and public VAPID key.

Current metadata is separate from the immutable original registration receipt. Inspecting the original verifies its exact consent/subscription/event and cannot create a consent. That historical receipt remains inspectable after withdrawal or outlet removal. Withdrawal likewise remains available to the original phone account after assignment removal, with no renewed access to tasks.

Removing a browser capability detaches its live consent pointer while retaining the original identity and receipt. Restoring that old capability ID cannot silently reattach the consent. An already in-flight delivery may still record its genuine transport outcome. Permanently deleting the actual phone account removes its private consents, closures and deliveries while retaining the shop's public task and audit history.

An unknown original can be withdrawn before its delayed enable reaches SQL. Account-and-consent locks serialize both directions. The permanent personal closure retains its original event; retries do not consume another slot. New unknown closures have a serialized 1,000-per-account/server-day budget. Known cleanup remains available after that budget is used. No member/outlet event is invented for a consent that never existed. Inspect/read/withdraw cleanup stays available while delivery is disabled or VAPID configuration is absent.

## Actual task generations and delivery

Only actual open/waiting urgent manual tasks and observed-payment tasks enter this queue. Kitchen alarms retain their existing queue. An ordinary task is not made urgent by source text. Resolution or loss of urgency cancels pending delivery; reopening creates a new generation. Editing an already urgent task does not send another alert merely because its body or waiting status changes.

Recipient expansion uses the backend's private consent sequence as a fixed upper boundary and reads at most fifty recipients per generation per prepare pass. Remaining recipients retain their cursor; none are discarded to fit a page. A new consent cannot enter an expansion that already started. Due pending deliveries and expired leases each use a bounded indexed selection before merging.

Each claim rechecks actual task state and generation, original consent, browser capability, confirmed phone account, current member role and outlet assignment. Normal scope locks precede delivery locks. Consent changes use a business key-share lock before the outlet write lock, allowing the existing desk registration's event foreign keys to complete.

The worker uses ten-second leases, at most eight provider attempts, bounded backoff and no more than four concurrent sends. A provider call begins only inside the tick's four-second admission window. SQL transport requests have a 1.5-second deadline; push-provider requests have a 2.5-second deadline. An abandoned lease retains its original recipient and task generation. Delivery remains at least once after an unconfirmed provider call.

The reviewed, pinned Web Push library encrypts the closed payload. Each consent/task/generation has a stable separate provider topic, so a late old consent or generation cannot replace its newer alert. Payloads contain routing identifiers only—no customer text, money, browser encryption material, credentials or URL. Public audit records consent metadata and genuine transport outcomes without endpoint, keys or provider response bodies. A send already in flight remains transport history if its task resolves meanwhile; it never reopens the task.

The target endpoint requires the original consent/account, current outlet rights and an actual attempted delivery. It returns the actual current task and generation separately from the original notice. A historical alert cannot imply that a resolved or later-reopened task still has its old state. Existing native Inbox and payment review provide the manual resolution paths; the new click interface remains to be connected.

## Installation-owned configuration

Apply both urgent Inbox migrations to the installation's own backend and deploy the two functions. The empty private environment template provides `MISE_URGENT_INBOX_ENABLED=false` and `MISE_URGENT_INBOX_KEY`. Reuse that installation's configured service/publishable keys, exact allowed origins and private VAPID settings. Each installation supplies these values; no maintainer account, provider credential, phone number or OTP is required.

Configuration advertises readiness only after the private delivery settings are present and structurally valid. A public VAPID key by itself cannot make the service appear configured. Original inspection and withdrawal stay available while delivery is unavailable.

The scheduler uses the existing reviewed privileged Cron/Net/Vault dependency checks. A privileged installer stores a separate urgent worker key and backend origin in private Vault and configures their UUID references through `private.configure_urgent_inbox_dispatch`. The key must match the private function environment. Enabling creates only `mise-urgent-inbox`, with the fixed command `select private.dispatch_urgent_inbox_work()` and a one-second schedule. Disabling removes only that owned job. A competing job name is rejected.

Supabase supports sub-minute Cron intervals; see [the official quickstart](https://supabase.com/docs/guides/cron/quickstart). No job is installed or enabled by either migration. Cron metadata contains no origin, key or header. Net receives only a short-lived, body-bound HMAC and exact one-use SQL grant; the reusable key never enters its HTTP queue, even where platform defaults allow queued headers to be read. Disable/reconfiguration invalidates earlier grants. Errors and status remain generic and contain no decrypted configuration.

The local verification path models transactional Net/Cron behavior and uses an independent browser key to decrypt a real encrypted packet. Its timing budget includes one scheduling second. It is not hosted/browser/provider delivery acceptance. Full M37 still requires native consent/recovery, service-worker presentation, authenticated click resolution and genuine five-second commissioning on the end user's installed browser. Workflows, scheduling, CI uploads and publication remain held.

## Verification checkpoint

The full unit invocation passed 4,996 cases across 259 files. The final cleanup and readiness refinements then passed 166 focused checks, including all 79 urgent-notification cases and four cases added after the full invocation. Together they cover 5,000 unique cases; this is not a claim of one final-source 5,000-case invocation. Original large-data corpora, deadlines and the two-worker limit remain unchanged. Lint and strict types pass. Both production hosting paths build and pass 85 selected existing browser regressions each, including responsive and accessibility checks. No app layout changed in this backend increment.

The identical 91-check commissioning SQL passes locally and on the connected installation, with every synthetic identity/source/action rolled back. All 491 earlier function definitions remain identical; all 26 new function bodies match reviewed source. The managed schema has 86 migrations and 122 tables, all with forced RLS. The two new function versions match the tested bundles, and all 17 earlier Edge versions remain unchanged. Live checks confirm the worker's default-off response and the owner's rejection of unsigned access. Cron has zero jobs, the scheduler stays disabled, and no installation credentials or provider requests were created.

[The verification record](urgent-inbox-notifications-verification.json) retains source hashes, exact SQL/bundle proofs, failure corrections and the limits of this checkpoint. Full M37 and native notification integration remain open; CI uploads and public deployment remain held.
