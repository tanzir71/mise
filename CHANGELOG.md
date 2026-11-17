# Changelog

All notable changes are documented here. Milestone completion is recorded after verification.

## [Unreleased]

### Added

- M30 preparation: scoped access, original-image transfers and catalogue availability changes with undo are prepared. Sign-in, sync and cloud interfaces remain unavailable while the full milestone is in progress.
- M24 interface (behind `shareTarget`): opt-in Android share manifest, bounded offline POST receiver, local Inbox with source-image previews and manual-add fallback, reversible sorting/archive, and editable order/payment/invoice/stock forms. The standard install remains unchanged while installed Android acceptance is pending.
- M24 storage foundation (behind `shareTarget`): local shared-text and image records, reversible manual classification/archive, atomic audit history, and byte-preserving JSON image backups. Schema 10 upgrades existing databases and imports schema-7/8/9 backups. Installed Android acceptance remains open.
- M23: a shared hand-off for receipts, reminders and calls, order quotes, supplier requests, summaries, shop links and customer messages. Reviewed text and explicit send progress resume offline; opening or copying leaves confirmation to the sender.
- M23 recovery: manual Copy remains available when storage or the clipboard fails, long messages keep every part, and customer requests retain form choices and photo reminders. Forget clears the customer’s local trail; backups retain owner message history.

- M22 (behind `qrPosters`): saved-link QR posters and counter cards, market scan copy, offline local fonts, PNG download/open and native PDF printing at A5 or counter-card size.
- M20: bounded public shop links, bilingual structured order messages, audited generation and ten-minute undo; Shop link settings with item selection, preview and copy/share fallbacks. The public customer page supports lists/menu choices, optional voice and photo preview, remembered details/last request, fulfilment/time and WhatsApp/Copy/manual completion, with a separate offline worker and a complete page budget below 60 KB.
- M21: paste English/Bangla customer requests into editable order drafts, with explicit count/unit suggestions, unsaved counter pricing, clipboard/manual fallbacks and owner-confirmed creation. Complete original requests survive order saves and JSON backup/restore; payment preferences never record money.

### Fixed

- Keep deployment credentials and project-specific operational details out of the repository; local lint now checks for accidentally committed secrets.
- M23 recovery: immediate customer-detail saves cancel their older debounce so storage failure cannot overwrite the latest Copy/manual-selection notice.

## [0.2.0] - 2026-11-16

### Added

- M10: business and market packs, three-question setup, phone navigation, desktop sidebar, local settings and an audited IndexedDB workspace.
- M11: catalogue editing, local item names, exact prices, categories, availability, search and reviewed bulk paste.
- M12: cash-first counter, calculator keypad, given/change, optional customer/items, manually confirmed wallet/card payments, receipts, QR and sales-log undo.
- M13: customers and khata, balances and limits, explicit over-limit choices, payments/corrections, history, and bilingual reminder/receipt handoffs.
- M14: manual orders, queue/board, customer lookup and usual orders, typed-item pricing and swaps, fulfilment/status history, warnings, payment, cancellation and refunds.
- M15: stock targets and pack-rounded needs, reviewed quick updates, night counts, movement corrections, suppliers and bilingual order drafts.
- M16: record-derived Today totals and payment splits, waiting orders, low stock, due reminders, reviewed cash closing, saved summaries and same-day undo.
- M17: six datasets in CSV, Excel and PDF with dates/columns and masked phone fields; complete twenty-table JSON backup, reviewed atomic restore and native file sharing with download fallbacks.
- M18: installable manifest and original Mise icons, install guidance, offline relaunch, explicit updates, native storage-protection requests and direct backup/restore access.

### Fixed

- Credit tanziro.com in both regional landing footers.
- Explicit app updates reload only the requesting tab after its worker takes control, preserving another tab’s open form.

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
