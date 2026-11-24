# M37 · Urgent alert browser groundwork

This groundwork checkpoint supplies the private consent journal, account-bound transport, recovery session and notification handler for general urgent Inbox alerts. The follow-up [controls and current targets](urgent-inbox-ui.md) now connect those modules to the app and built service worker. Existing kitchen consent never enrolls a browser in general alerts. `ownerTasks` remains off and full M37 acceptance stays open.

## Original consent and offline withdrawal

Schema 4 adds `urgentProfiles` and `urgentOperations` to the existing private desk database. Schema 1–3 profiles, pointers, kitchen choices and pending requests retain their existing formats and original identities. Root and repository hosting paths have separate databases. This cache does not enter ordinary shop backups and stores no phone token, backend URL, provider credential, push endpoint or browser encryption material.

Each urgent profile belongs to the original phone-account hash, backend-target hash, outlet and member. Each operation additionally retains the complete original native binding, selected-desk revision, base registration choice, consent ID, subscription ID and event ID. A fresh positive choice requires the actual native operator and setup, original confirmed base registration and the actual PushManager fingerprint. Current metadata alone is insufficient.

Enable saves the original action before any registration request. It stays locally off until the original verified receipt is committed under the native selection guard. The owner endpoint returns current metadata from registration; the browser separately inspects the exact original event before treating it as a mutation receipt. An absent inspection, metadata read, serialized receipt or result from another account cannot confirm that action.

Disable writes local mute and withdrawals for every possibly registered original in one IndexedDB transaction, including an original whose request never reached the server. It also saves an off choice while the first setup is still being prepared, before its positive intent reaches the journal. Offline withdrawal survives close and reopen. All older withdrawals must finish before a fresh registration is sent; failed cleanup stops that delivery pass. The server's permanent original closure fences a delayed registration. An old successful reply may update its own history but cannot override a newer Disable, consent, browser registration, account or selected outlet.

The journal admits at most 500 original setups per profile, reserving room for their withdrawals. It never evicts pending or completed originals to admit another positive choice. Storage failure rolls back the entire local choice and prevents registration HTTP. Original cleanup remains possible at the setup limit. A completed-history archive interface is not supplied by this increment.

Personal recovery methods can inspect and withdraw an original after assignment removal or while delivery configuration is absent. They do not select an old native outlet, grant access to a task or send a fresh positive consent. Phone-account continuity and the original backend target still guard every HTTP result. The existing native shop records and financial actions remain separate.

## Notification handler and current task reads

The new handler requires the actual native binding and setup, active original base registration, current PushManager fingerprint, confirmed explicit urgent consent, matching original journal receipt and no withdrawal. It checks again after browser presentation and before opening a window. Local No suppresses subsequent notices and closes only this handler's exact consent/task/generation tags. Existing kitchen handling is unchanged.

Notifications use a generic title and body. Routing contains only closed consent, subscription, business, outlet, task and generation identifiers. The click destination is a fixed same-origin Inbox path under the installed app base. Another app base or origin cannot receive navigation or refresh messages. A caller-supplied URL, source text or extra payload field is rejected.

The account-bound session can request the actual current task target after rechecking the original native/browser/consent scope. The backend separately requires current role and assignment, the original consent and an actual attempted delivery, and distinguishes current task generation from the original alert. At this groundwork checkpoint, app and service-worker wiring remained open. The [follow-up interface](urgent-inbox-ui.md) now connects them to the existing Inbox and payment-source review; default-off delivery and genuine commissioning remain unchanged.

## Installation-owned configuration and delivery limits

All connections, accounts, phone verification, provider configuration and private backend settings belong to each installation. The transport reads the end user's saved connection and the existing phone Auth account; it contains no maintainer deployment details or alternate privileged RPC. The [backend guide](urgent-inbox-notifications.md) describes the empty private server template and default-off delivery configuration. Manual Inbox and payment review remain available independently.

Focused groundwork checks cover original-event HTTP contracts against the production Edge handler, native IndexedDB reload and rollback, offline No, lost replies, removed assignment, competing tabs, storage limits, native selection changes, generic presentation and fixed-path navigation. These tests do not establish installed-browser/provider delivery timing. The [follow-up](urgent-inbox-ui.md) supplies the controls, recovery UI, event wiring, authenticated targets and their responsive verification. Genuine five-second commissioning remains required before full M37 acceptance. Workflows, scheduling, CI uploads and publication remain held.

## Verification checkpoint

The full unit invocation passed 5,060 cases across 262 files. Final post-response browser-capability and early-off checks then passed 65 focused cases, including five added regressions. Together they cover 5,065 unique cases; this is not a claim of one final-source 5,065-case invocation. The original large-data corpora, deadlines and two-worker limit are unchanged.

Lint and strict types pass, including all 200 Astro files without diagnostics. Both production hosting paths build and pass 92 selected browser regressions each, including real browser storage/reload, offline recovery, responsive layouts and accessibility checks. No UI layout or production service-worker event wiring changed, so no new visual comparisons or CI artifacts are claimed. Source, complete history and production artifacts pass the configured private-value checks with no credential or new deployment findings; the fixed older reviewed nonsecret findings remain unchanged.

The [verification record](urgent-inbox-native-verification.json) retains exact source hashes and the scope of these checks. No hosted schema/function changes, provider requests, scheduling or publication were performed.
