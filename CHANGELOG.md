# Changelog

All notable changes are documented here. Milestone completion is recorded after verification.

## [Unreleased]

### Landing

- Added the owner's tanziro.com credit to the shared regional footer.

### App foundations

- M17 backup foundations: consistent versioned JSON snapshots of all nineteen local tables, a dry-run shop/count preview, runtime schema/reference checks and atomic replacement with a system audit record. Restore rejects a changed file or any browser write after review, and rolls back the original shop if import or audit storage fails. The export/restore interface and spreadsheet/report formats are still being implemented.

- M16 UI: enabled record-derived Today metrics, payment splits, real waiting/low-stock/reminder queues, offline cash counting with an editable denomination helper, reviewed walk-in overages, variance notes, saved day history, copy/share and a printable PDF summary. Same-day undo preserves later transactions; old-currency summaries keep their original amounts. Added phone/desktop Figma comparisons and responsive/accessibility checks.

- M16 foundations: record-derived Today totals, separate cash movement and sales, completed-order durations, waiting/stock/reminder queues, denomination counting, frozen closing reviews, explicit walk-in overage sales, attributable day summaries and same-day atomic undo. Schema 7 adds closing records while preserving all existing tables. The Today screen was staged while its Figma-based UI and delivery checks were prepared.
- M15 UI: stock item editing, inline counts and filters, reviewed/editable quick updates, night-count keypad and variance summary, supplier contacts and bilingual drafts with WhatsApp/Copy/Sent, movement history and correction. Counts and revisions work offline; optional speech fills a draft only. Added the three reference comparisons and responsive/axe flows for Stock, count, summary, editors, supplier handoff and history.
- M15 foundations: exact stock quantities and pack-rounded ordering, reviewed quick-update parsing, atomic night counts, movement history and 24-hour undo, supplier contacts and grouped bilingual drafts with explicit Sent records. Schema 6 adds stock storage without changing existing order/financial records. Stock remains staged until its reference-based screens pass delivery checks.
- M14: enabled manual orders, the phone queue and desktop board, local status recording and last-change undo, attributable notes/history, customer lookup and refreshed usual orders, typed-item pricing with a keypad, unavailable lines and manually agreed swaps, bilingual WhatsApp/copy handoffs, payment/khata settlement, cancellation and partial refund recording. Added waiting-time controls, scheduled/history views and stale-draft protection. Orders, prices and financial history work offline on this device.
- M14 settlement foundations: atomic order payments and khata charges, linked receipts, cancellation with credit returns, partial refunds and audited corrections. Preserve the age of unrelated debt, retain physical cash until an actual refund, and keep collected totals after customer archival. Schema 5 adds refund records; Orders remains staged pending its reference-based UI.
- Fixed explicit app updates during the first installed session. Reload now waits for the new worker to take control in the requesting tab; activating an update does not automatically navigate another tab away from its draft.
- M14 foundations: manual-order records, exact fractional-quantity pricing, unpriced/out-of-stock/swap gates, business-specific status transitions and undo, optimistic revisions, notes/contact audit records, warning settings, bilingual quotes and an additive database upgrade. Orders remain staged until settlement and UI delivery pass.
- M13 follow-up: count a customer once in the reminder heading when several currency accounts are due; keep each account's message and balance separate.
- M13: enabled customer editing, dated opening balances, khata lists/profiles, credit limits and explicit over-limit approval, counter credit sales, payments and audited reversals. Added sequential reminder/receipt/call handoffs with copy fallbacks, editable bilingual wording, archive/restore and separate currency accounts.
- M13 foundations: customer and credit-account commands, exact entry-derived balances, limit confirmations, atomic credit sales/payments/reversals, FIFO debt ageing, monthly reminder filters, bilingual/custom wording and an additive database upgrade. Khata UI remains behind a flag until its delivery checks pass.
- M12: enabled the cash-first counter, 4×5 keypad, round/manual given amounts, exact change, optional names/items, confirmed wallet/card recording, real receipt QR and copy fallback, sales log with ten-minute undo, and recorded sales on Today. Optional browser speech previews a calculation; the keypad stays available offline.
- M12 foundations: exact calculator arithmetic, audited cash/wallet/card sale commands, ten-minute undo, timezone-aware day totals, receipt text and an additive IndexedDB upgrade. Counter UI remains staged until its checks pass.
- M10 foundations: business/market packs, integer money and E.164 phone helpers, ULID setup commands, removable sample catalogue seeds, and transactional Dexie persistence with audit events.
- M10: enabled three-step onboarding, pack-aware phone navigation and 240px desktop sidebar, business/outlet/market settings, removable samples, offline shell caching and an explicit reload control for updates. Future counter/order/stock tools remain staged. Added app reference captures and direct-to-main delivery workflow per owner instruction.
- M11: catalogue item editing with local names, exact prices, units, categories, availability and often-bought flags; search and reviewed bulk paste, atomic audit events, offline persistence, responsive editors and supplied Figma toggle assets.

## [0.1.1] - 2026-11-15

### Refinement pass

- R0: supplied Figma exports and updated design requirements, a single `@figma` asset source, required-export checks in CI, and a manual Figma refresh workflow.
- R1: one Figma picture pipeline with AVIF / WebP / PNG at 1× and 2×, all drawn product previews removed, source and payload guards, and exported icons.
- R2: calm light navigation and hero for both regions, regular 56px desktop type, one exported phone, responsive reading order, and a light mobile menu with keyboard support.
- R3: full-size alternating detail images, six evenly spaced day screens with a phone scroll-snap row, and equal-height business cards aligned to the supplied exports.
- R4: regular section type, reference backgrounds and spacing, horizontal before/after cards, compact capture/check panels, a left-aligned CTA and a simpler footer; both gradients removed.
- R5: native phone disclosures for workflow steps and extra checks, two-column basics/business cards, compact phone spacing, 44px touch targets, and regional landing pages under 20,000px at 390px.
- R6: reference-based setup/downloads with four desktop device cards, a focused five-step phone guide, native guide disclosures, manifest-backed availability and checksum copying; new 1200×630 hero share images for both regions.
- R7: reusable section capture and Figma comparison reports with informational pixel differences, automatic config discovery for app milestones, CI artifact uploads and PR evidence requirements. Mobile Lighthouse: BD 95 / Intl 98 performance; accessibility, best practices and SEO 100.

## [0.1.0] - 2026-11-15

### Added

- Original Mise handover, copy and brand assets.
- M00: pnpm monorepo, strict TypeScript, static Astro site and React app placeholder, portable build, CI and GitHub Pages deployment.
- M01: shared Astro and React primitives, Lucide icons, token-mapped Tailwind theme, self-hosted Geist / Geist Mono / Hind Siliguri, and an opt-in UI gallery.
- M02: complete Bangladesh product page using the supplied copy, twelve detailed workflows, responsive product previews, accessible mobile navigation, and About / Privacy pages.
- M03: international page from shared components, remembered region switcher, non-blocking region routing with configurable country lookup, and canonical / hreflang metadata.
- M04: regional social cards and screenshots, mobile Lighthouse targets, copy fallbacks, optional analytics hook (off), sitemap / robots, and a build-time content security policy.
- M05: setup and downloads guide, runtime manifest with validated checksums and stable download links, installation instructions, artifact publishing skeleton, and self-hosting guide / agent prompt.
