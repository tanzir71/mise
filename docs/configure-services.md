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

## Other integrations

As capture, courier, payment and AI integrations are delivered, their account choices, connections, limits and tests belong in the installation's setup/settings or private backend environment. Keep privileged credentials on that backend. An unconfigured optional integration stays off and explains how to configure it; it does not silently use the maintainer's account.

Use an integration's connection test after supplying its settings. If an external service is unavailable, keep the original work and use the provided manual fallback. Share only redacted diagnostics, never credentials, when reporting a problem.
