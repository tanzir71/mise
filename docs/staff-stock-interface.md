# Stock on a shared screen

The default-off staff workspace now connects the supplied stock design to actual device/PIN-scoped quantity pages. Staff can review a typed or spoken stock note, enter a physical count, compare current quantities, and explicitly confirm a change. This uses the [native original-request journal](staff-stock-native.md) and [quantity backend](staff-stock-quantity.md); it does not grant owner purchasing or financial access. M34 remains unchecked.

## Quantity work and physical originals

The stock list shows actual on-hand, target and to-order quantities, with category, low-stock and name/alias filters. Refresh is explicit; additional pages retain their actual source references. The night count keeps entered quantities attached to the original loaded items and count time. Blank rows are skipped, additional pages preserve entries, and refresh is disabled while a count has entered values. All 1,000 supported count lines can be reviewed together.

Quick updates and individual used, received, waste and on-hand changes first save their complete original request. A separate current comparison is required before Confirm quantities. Preparing alone changes no quantity. The original request remains available if comparison, confirmation or the connection fails. Own undo uses the actual applied receipt and another current comparison.

Each saved request shows its original member/session, physical time, source and actual outcome. Check saved result recovers the original outcome without creating a second movement. Offline closure persists locally before contacting the backend. A later PIN for the same member can inspect and close their originals even after current work permissions are removed. A known read denial hides current quantities and preserves recovery.

## Complete text and manual handoff

Imported names, local names and units remain complete. Values over 4,096 characters have an explicit expansion control, and oversized item labels also show the item's actual ID. Search uses the full name/local name/aliases when a search term is entered. Nothing is shortened in the saved original, native audit or backend hash. A large imported category has a compact numbered filter and a separate control for its full text.

Copy complete original copies the exact saved request. If clipboard access fails, a selected readonly field exposes the whole note for manual copying. Copy note for manager and I told the manager provide the manual path; neither posts stock or money. At the native journal's 200-original capacity, retain the complete history and use this manual path or the [verified archive controls](staff-stock-archives.md). Those controls retain exact file fingerprints and keep own-original recovery and reviewed undo available.

## Installation and delivery

This increment adds no account, provider, credential, phone number or maintainer input. Each installation owns backend setup, pairing, member PINs, permitted origins and Update stock choices. Privileged credentials stay in its private backend. Existing `staffTeam` and `deviceAccess` preview flags remain off by default. Both stock HTTP services stay disabled and undeployed. Workflows, CI uploads and publication remain held by the owner's instruction.

The mobile presentation follows M16 (`103:213`); the count table follows Desktop 04b (`77:2732`). Exact exported Figma icons retain their intrinsic dimensions. Shared-screen navigation, current comparison, original recovery and manual handoff adapt those owner/manager references to the actual PIN authority. Owner-only navigation, supplier contacts, financial figures and unconfigured automation are omitted.

## Verification

The [verification record](staff-stock-interface-verification.json) binds the implementation and frozen quantity contract to one complete run of 5,228 passing unit tests across 272 files. Lint, strict types, all 204 Astro files, all 270 reference exports and both production builds pass. The selected browser regressions pass all 137 cases at both `/` and `/mise/`, including 13 new interface cases per path. The original large corpora and deadlines are unchanged.

The actual rendered editor, native journal, HTTP handlers and SQL preserve all 1,000 physical-count lines and million-character imported names/units. Lost committed replies recover the same receipt without a second movement. Offline closure, clipboard failure, known permission removal and later PINs after all work access is removed retain the complete original and post no invented stock or money. The new heavy UI cases use the existing 60-second case/transport budget; their outcome waits accommodate the complete native hashing and SQL work. Ordinary startup and browser deadlines stay unchanged.

The reproducible visual configuration is [m34-staff-stock.json](../qa/configs/m34-staff-stock.json). It uses real local SQL, pairing, PIN issuance, HTTP handlers and native storage. All 15 comparisons per hosting path pass accessibility, page-overflow and exact icon-geometry checks at 360, 390, 768, 1024 and 1440 px. Pixel differences remain informational because these owner/manager references are adapted to the shared PIN workspace described above. Key generated local captures are the [mobile quantities](../qa/screens/staff-stock-quantities-390.png), [desktop count](../qa/screens/staff-stock-count-physical-1440.png) and [mobile comparison](../qa/screens/staff-stock-review-comparison-390.png), with the [comparison report](../qa/report.html). These generated artifacts are ignored; CI upload and public deployment remain held, so this increment has no CI run or new live deployment to link.

No managed migration, deployed service, provider request or configuration input is added. Verified archives are supplied by the linked follow-up. The own-performance permission path, genuine installation commissioning and complete M34 acceptance remain open.
