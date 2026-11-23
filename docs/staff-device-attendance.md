# Paired-screen attendance backend

M34 remains in progress. This increment implements the backend and HTTP contract for own attendance on a shared browser screen. Browser controls, their durable native journal and task permission enforcement remain required. The `staffTeam` preview stays off; `staff-device` defaults off and is not deployed. Workflows, Pages publication and scheduling remain held.

Each installation owns its connection, enrolled devices, owner-configured staff PINs and private service environment. No maintainer provider account, credential or verification number is needed. The backend uses the existing PIN derivation and throttling; no PIN, verifier or service key enters a client receipt or attendance audit. Manual attendance remains available.

An outlet's explicit `order_phone` method enables only that member's attendance. Existing staff/kitchen work permissions retain their previous role restrictions. Riders, and kitchen members on counter screens, receive exactly `staff.check-in`; forged order or cash flags cannot widen that access. PIN settings still require the actual verified owner, and contact numbers never create Auth identities.

The transaction checks the actual device and PIN session, member, outlet assignment, PIN revision, linked Auth identity and current method. It shares the existing member lock with manual and link check-ins, rejects stale predecessors and invalid clocks/transitions, and records the real `order_phone` method and member recorder. Check-in, canonical audit and immutable receipt commit together. The own-member history reader includes actual manual recorder names and bounded pages, with no other member or contact data.

Admission and the decision after row locks use the actual current clock for both device and session expiry. A database statement that began before expiry cannot continue serving fresh attendance after that expiry. An additive migration fixes this case without changing earlier applied SQL; regression tests reproduce it on both local and managed PostgreSQL.

An exact earlier receipt survives a lost reply and can be inspected after a fresh PIN for the same member on the same device. A different device/member or modified source cannot claim it. Closing the original prevents a delayed submit from creating attendance. Fresh views and writes require live access; historical receipts do not grant it. Request and closure bounds retain earlier originals rather than evicting them.

The fixed HTTP adapter validates complete requests and responses, rejects caller-selected scopes, methods, recorders and limits, and redacts failures. Service credentials stay in private backend requests. Body bounds and deadlines cover both incoming work and the complete privileged response. Installer configuration starts empty, with `MISE_STAFF_DEVICE_ENABLED=false` and an optional per-device request budget.

The [verification record](staff-device-attendance-verification.json) contains exact source hashes and the check results. The full unit run passed 4,778 cases in 242 files; the final 37-case focused run covers the additive clock correction and includes its two new expiry cases. Lint and type checking pass, including 193 Astro files without diagnostics. Both production base paths build successfully, and all 59 affected browser cases pass on each path. The final build is restored to `/mise/`.

The local report contains 85 visual comparisons, with no accessibility or horizontal overflow failures. All 270 reference exports are present. The existing link/manual [visual checkpoint](staff-attendance.md) remains the design baseline; this increment changes no UI layout or assets. CI artifacts and public deployment remain held.

The private backend has 76 migrations and 108 application tables, all forcing row-level security. All ten final function bodies match source; 449 unrelated definitions retain their prior digest. Thirty-five rolled-back role and clock checks pass, with one actual check-in, no financial or provider effects and no remaining fixture data. The 17 existing Edge Functions are unchanged; neither `staff-device` nor `public` is deployed. Scheduling remains off.
