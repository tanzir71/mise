# Configure services for your Mise installation

Your shop controls its hosting, backend and provider accounts. The Mise maintainer does not provide personal service accounts, API keys or verification numbers. Counter sales, orders, stock, khata and backups remain available locally while optional services are unconfigured.

The shop's installer configures the backend once. Owners and staff then use their own phone or enrolled screen; each staff member does not need a separate provider account.

Configure only the features available in your installed release. Backend configuration does not enable unfinished features or establish successful SMS or notification delivery by itself.

## Cloud connection

Use a Supabase project controlled by your installation. Deploy this repository's migrations and Edge Functions to that project, following the installed CLI's `--help` for its current commands. Configure the backend values listed in `supabase/functions/.env.example` in that project's secret manager. Set the exact origins for your deployed app. Generate fresh installation-specific signing keys and PIN peppers; never reuse the development installation's configuration.

In Mise's cloud setup, enter that project's HTTPS URL and publishable key on the device. These are connection settings, not an administrator credential. Never enter a secret/service key or provider password into the connection form. Keep actual connection values out of the repository and public build variables. Supabase distinguishes [publishable client keys from privileged server keys](https://supabase.com/docs/guides/getting-started/api-keys).

## Phone sign-in

The installer enables phone authentication and configures the shop's chosen SMS provider in its Supabase project. Provider credentials stay in the backend's protected settings. Enable phone verification; do not auto-confirm phone numbers. Keep email and anonymous sign-in disabled for this installation. Allow the intended owner/manager accounts to sign up or provision them according to the shop's access policy.

Follow [Supabase's phone-login setup](https://supabase.com/docs/guides/auth/phone-login) for the selected provider. The user enters their own phone number in Mise and explicitly requests a code. Mise checks whether phone sign-in is ready before requesting an SMS. If setup is incomplete, use the guide to finish it and continue local work in the meantime.

Provider billing and delivery settings belong to the installation's account. Test an actual code from the installation after configuring it; an automated local test does not establish real SMS delivery.

## Desk notifications and device setup

The installer configures the installation's own alarm signing key, VAPID keys and HTTPS contact page in its backend. Scheduler configuration and Vault references stay private. An owner chooses the outlet warning settings; each desk explicitly enables browser notifications. Staff screens are paired to that installation and signed in with a staff PIN.

Until notification setup is ready, the cached Inbox, visible warnings and manual controls remain the working path. Verify actual notification delivery on the intended device after opting in.

## Customer link reads

The installation's `public-read` function uses the existing backend server key and exact allowed origins. Optional private backend settings `MISE_PUBLIC_READS_PER_MINUTE` and `MISE_PUBLIC_LINK_READS_PER_MINUTE` control the installation-wide and per-link budgets. Empty values use 3,000 and 60 reads per server minute; valid configured values are integers from 1 to 60,000. Invalid values leave reads unavailable rather than silently weakening the limits. No additional provider account or secret is required. Deploy only the customer interfaces available in your release; configuring this endpoint does not enable unfinished tracking or khata pages.

The opt-in `customerLinks` preview adds controls to existing order and customer details. The record must already exist in the installation's backend, and the signed-in phone account must be its owner or assigned manager. Use Sync setup to configure that installation; no personal maintainer account is involved. The generated customer link includes the public API origin and a purpose-bound secret, with no API key or owner session. Treat the complete link as private to its customer. Copy it before leaving the page: its one-time secret is not saved locally. After reload or a lost reply, inspect and close the saved attempt before creating a replacement. Revoke unwanted links from the record's link list, including links issued on other devices.

Customer pages use only the shop contact explicitly published in the approved public shop link. Configure that number in the shop-link settings; the owner sign-in and customer's stored phone are never substituted for it. Public ordering and recorded shop estimates are separate opt-in previews. Swap consent, customer payment choices and customer task writes remain in development and are not enabled by this read preview.

## Public order submission

The `publicOrders` preview includes owner publication, customer submission, original-request recovery and automatic table tracking. Recorded arrival/ready ranges and server-observed delay notices are available in that preview; full M33 still needs shop price/swap acceptance and payment choices. Its separate `public` Edge Function stays disabled by default; do not enable it for general use merely because its migration is installed. When the complete flow is available, the installation deploys that function and explicitly sets `MISE_PUBLIC_ORDERS_ENABLED=true` in its own backend environment. It reuses `MISE_SERVICE_API_KEY` and `MISE_ALLOWED_ORIGINS`; no maintainer account or additional provider is required. Never put the server key in a customer link or browser configuration.

Optional backend settings `MISE_PUBLIC_ORDERS_PER_MINUTE` and `MISE_PUBLIC_SHOP_ORDERS_PER_MINUTE` default to 300 HTTP admissions and 30 new attempts per shop per server minute. Valid values are integers from 1 to 60,000; invalid configuration keeps ordering unavailable. Limits do not confirm payment, ownership of a customer's phone or successful provider delivery. The existing message path remains the manual fallback. See [the current ordering scope](https://github.com/tanzir71/mise/blob/main/docs/public-ordering-runtime.md).

In the opt-in preview, generate and sync the public shop snapshot, refresh access in Shop link settings and choose Publish ordering link. Table labels and link duration belong to the installation. Publishing confirms that snapshot and its capability; it does not configure the backend service. The original `/app/s/` WhatsApp page remains available, while the new `/app/o/` link includes the installation origin and public ordering capability in its fragment. The customer device saves its own original request before sending; after a lost reply, use Check original request or close the unfinished request before sending another. Disabling a shop link retains real existing orders and their individual trackers.

For a synced order, its owner or assigned manager can record a time range and an optional public note in the order detail. The first deadline remains visible after updates or withdrawal. Check or close an unconfirmed original before replacing it; reconnect with the original installation account after an offline reload. These controls use the same connection and phone sign-in, with no extra provider or credential. See [recorded estimates](https://github.com/tanzir71/mise/blob/main/docs/order-estimates.md).

## Other integrations

As capture, courier, payment and AI integrations are delivered, their account choices, connections, limits and tests belong in the installation's setup/settings or private backend environment. Keep privileged credentials on that backend. An unconfigured optional integration stays off and explains how to configure it; it does not silently use the maintainer's account.

Use an integration's connection test after supplying its settings. If an external service is unavailable, keep the original work and use the provided manual fallback. Share only redacted diagnostics, never credentials, when reporting a problem.
