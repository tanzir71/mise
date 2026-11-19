# M31 — Automatic send, download and status

The opt-in Sync setup connects the saved upload review, original-account command
delivery and canonical reader into one background cycle. Local changes remain
available offline. Reconnecting sends their original queued actions, downloads
the outlet's verified snapshot and images, and applies the canonical copy before
confirming the header's status. `cloudSync` remains off by default; enabling it
also enables the existing phone/connection setup interface.

The header shows Synced, Syncing, Offline, Paused, Sign in or Needs review, with
the number of unsent actions. Sync setup provides explicit upload/resume,
pause/resume, a fresh download check and a separate JSON-backup link. An existing
joined device retains its distinct admission instead of preparing an owner upload.

Schema 19 adds an internal `syncSessions` store. Original upload receipts, queues,
compressed source, staged pages and images remain intact. Portable backups still
contain the existing 21 tables at version 10. Session records contain fingerprints,
scope versions, retry deadlines and download pointers; actual connection values,
Auth UUIDs and tokens remain outside the shop data and build output.

Browser locks coordinate tabs, with durable leases and heartbeat renewal as a
fallback. Retry deadlines survive reload and use bounded exponential backoff
with jitter. Definitive account or scope failures require review; temporary Auth
and network failures remain retryable. Manual pause cancels transfers and pending
Realtime initialization. A successful HTTP request alone cannot report Synced:
the canonical writer and original active account must confirm the accepted cursor.

Newly acknowledged actions can require a newer snapshot window. The previous
window and its source pages remain saved. A local completion-write failure after
canonical application resumes the exact applied read instead of duplicating cash
or attempting to bootstrap again. New local edits still request a follow-up cycle;
receipt acknowledgements and timer ticks during a running cycle do not create
redundant work. Integrity checks preserve their exact hashes while avoiding a
Promise for every plain-data field in a large shop. Complete Blob bytes remain
asynchronously hashed.

Migration 37 publishes only INSERTs on `public.events`. Existing forced RLS and
the authenticated outlet policy continue to authorize reads. The migration refuses
an unrelated existing publication rather than changing its tables. Realtime
payloads only wake a cursor pull; they never mutate the working shop. The actual
installed client subscribes with the original phone token and outlet filter.
The subscription follows the [Supabase Postgres Changes guide](https://supabase.com/docs/guides/realtime/postgres-changes); [PostgreSQL publication options](https://www.postgresql.org/docs/current/sql-createpublication.html) restrict publication to inserts. An owner-only WebSocket CSP permission supports runtime connections; customer
and marketing pages retain their separate connection policy.

The hosted migration's exact source and version were verified after deployment:
all 58 application tables enforce RLS, with zero anonymous table grants, zero
public security-definer helpers and one private image bucket. Security advisors
reported no warnings or errors. Private project details and credentials remain in
ignored local configuration or the server secret manager.

The [redacted verification record](m31-sync-runtime-local.json) reports 2,354 unit tests across 127 files, 419 browser cases, 62 root-path cases and three final Pages sync cases, all passing. Lint and typecheck pass with 119 Astro files and no diagnostics. Both build paths pass; all 270 exports are present. Full visual QA produced 197 comparisons with zero horizontal overflows, followed by five final Sync comparisons. The actual synced controls pass serious/critical axe checks at 360, 390, 768, 1024 and 1440 px.

The local 5,000-record initial upload completed in 25.8 seconds with 400 ms latency and 50,000 bytes/second in each direction. Losing its real SQL promotion reply retained the exact review, receipt identity and image source; resume admitted one upload and a later offline cash sale converged without a duplicate.

Generated local review artifacts: `qa/report.html`, `qa/screens/m31-sync-controls-phone-screen-360.png`, `qa/screens/m31-sync-controls-desktop-screen-768.png` and `qa/screens/m31-sync-controls-desktop-screen-1440.png`. These are local outputs. The final five-width comparison is also retained under the ignored `.private/qa-sync-final/` directory.

The native integration service uses the real SQL migrations, scoped database roles,
HTTP handlers, installed Auth client and IndexedDB. Its Auth verifier, object
storage adapter and Realtime gateway are explicitly synthetic. These checks do
not prove genuine hosted phone OTP, Storage or Realtime acceptance.

M30/M31 remain open. Remaining work includes the other conflict/rebase families,
changed-scope bootstrap, user-facing new-device join, staff/agent resources and
genuine hosted acceptance. The five-width visual pass adapts the supplied M27
More and Desktop 14 Business data references because the handover has no dedicated
Sync frame. GitHub workflows remain disabled; no new CI artifact or Pages
deployment is claimed.

Pages remains on the previously deployed commit at [the live app](https://tanzir71.github.io/mise/app/). The owner has disabled all three workflows, so this increment has no new Pages deployment or uploaded CI artifact. To review the local build, open `/app/?flags=cloudSync`; connection settings are entered on the device. Enabling the flag does not commission a real phone provider.
