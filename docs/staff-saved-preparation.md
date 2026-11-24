# M34 · Personal preparation recovery

**My saved taps** is available from both shared attendance and preparation screens, independently of current order-read permission. It shows only the signed-in PIN member's original taps on that enrolled device and outlet, including earlier sessions. It does not open live orders, send Got it/Ready, grant attendance or expose another member's saved ticket.

Each installation configures its own backend connection, pairing, members and PINs. This path needs no maintainer account, credential, phone number, verification code or provider. The existing Team and kitchen previews remain off by default.

## Original history and offline closure

The dedicated native journal verifies the complete current enrollment and PIN session before reading or changing history. Every returned original is filtered by its recorded member and device/business/outlet scope. The cached board keeps its historical actor and permissions; it is never rewritten into a claim that the current member can prepare orders. Current native expiry, account separation, member changes and storage errors fail closed.

**Close saved tap** saves the explicit choice locally before any HTTP request, including offline. It preserves the exact action, source ticket, original member/session and gesture time. The pending-close fence prevents the preparation screen from delivering that original as fresh work. Native writes merge against the latest complete journal and enrollment, so a competing tab cannot erase another original or commit a reply after a PIN switch.

**Check confirmation** uses the current actual device and PIN authorization to inspect the original. Only a close choice made in that current PIN session can be sent as a closure. An earlier session's close is looked up without borrowing its actor or timestamp; a new choice requires another explicit tap. Lost replies remain recoverable. A genuine earlier acceptance stays accepted: closing history cannot undo preparation or post money. **Copy original ticket** verifies the current native member again and offers a selectable manual copy when the clipboard is unavailable.

## PIN entry after permissions change

The bounded sign-in directory includes a currently eligible member with an earlier session on that same device, business and outlet even when their current capability list is empty. This lets the member use their own fresh PIN to recover an offline original after sign-out. It grants no positive capability and does not list a never-signed-in zero-capability member on another device. Inactive members, removed assignments or PINs, revoked/expired devices and invalid linked identities remain excluded by the current eligibility checks. The existing PIN verifier, attempt budgets, expiry and authorization checks are unchanged.

The applied [directory migration](../supabase/migrations/20261124063518_staff_saved_preparation_directory.sql) changes only the private directory body. All 516 other application functions, the existing directory owner/volatility/search path/privileges, 122 forced-RLS application tables and 19 Edge versions are preserved. Sixty managed role checks pass in a rolled-back transaction; no fixture Auth users, businesses, devices, sessions, closures or check-ins remain. Cron remains empty and no provider request is made.

## Verification and delivery

The [verification record](staff-saved-preparation-verification.json) binds the source to all 5,103 unit tests in 265 files, a final 15-case recovery rerun, lint and strict types with zero diagnostics across 200 Astro files. Both production builds pass with readable generated HTML and assets. All 114 selected browser cases pass separately at `/` and `/mise/`, including zero-read recovery, later PIN sessions, member isolation, blocked clipboard access, native persistence and unchanged orders/payments. Original large-data workloads, deadlines and two-worker limits are unchanged.

All 90 visual comparisons pass accessibility and horizontal-overflow checks at 360, 390, 768, 1024 and 1440 px. The three reviewed synthetic captures show [the retained original](screenshots/m34-saved-original-390.png), [the offline close choice](screenshots/m34-saved-offline-close-390.png) and [the confirmed closure](screenshots/m34-saved-confirmed-close-390.png). Their hashes match the inspected images. The complete 272-file report archive stays local at `.private/m34-saved-visual/report.html`; regenerate it with `pnpm qa:visual qa/configs/m34-saved-preparation.json qa/configs/m34-preparation-permissions.json qa/configs/m32-kitchen.json qa/configs/m34-staff.json` after building.

The supplied kitchen phone/tablet frames guide the existing saved-original primitives; no exact recovery-only frame is provided. The visual report documents that adaptation instead of claiming pixel equality. GitHub CI artifact upload remains held.

The [ordinary preparation screen now retains known read denial](cached-preparation-access.md) across offline reloads without changing historical access. Only a fresh authorized read and an atomic native commit can restore its board. This dedicated personal reader remains independent and never sends preparation actions. Full M34, actual staff stock authorization and later own-performance work remain open. GitHub workflows, CI uploads, Pages publication, release tagging and provider commissioning remain held under the owner's delivery instructions. This increment does not mark those milestones complete.
