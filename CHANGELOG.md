# Changelog

All notable changes are documented here. Milestone completion is recorded after verification.

## [Unreleased]

### Refinement pass

- R0: supplied Figma exports and updated design requirements, a single `@figma` asset source, required-export checks in CI, and a manual Figma refresh workflow.
- R1: one Figma picture pipeline with AVIF / WebP / PNG at 1× and 2×, all drawn product previews removed, source and payload guards, and exported icons.
- R2: calm light navigation and hero for both regions, regular 56px desktop type, one exported phone, responsive reading order, and a light mobile menu with keyboard support.
- R3: full-size alternating detail images, six evenly spaced day screens with a phone scroll-snap row, and equal-height business cards aligned to the supplied exports.
- R4: regular section type, reference backgrounds and spacing, horizontal before/after cards, compact capture/check panels, a left-aligned CTA and a simpler footer; both gradients removed.
- R5: native phone disclosures for workflow steps and extra checks, two-column basics/business cards, compact phone spacing, 44px touch targets, and regional landing pages under 20,000px at 390px.
- R6: reference-based setup/downloads with four desktop device cards, a focused five-step phone guide, native guide disclosures, manifest-backed availability and checksum copying; new 1200×630 hero share images for both regions.

## [0.1.0] - 2026-11-15

### Added

- Original Mise handover, copy and brand assets.
- M00: pnpm monorepo, strict TypeScript, static Astro site and React app placeholder, portable build, CI and GitHub Pages deployment.
- M01: shared Astro and React primitives, Lucide icons, token-mapped Tailwind theme, self-hosted Geist / Geist Mono / Hind Siliguri, and an opt-in UI gallery.
- M02: complete Bangladesh product page using the supplied copy, twelve detailed workflows, responsive product previews, accessible mobile navigation, and About / Privacy pages.
- M03: international page from shared components, remembered region switcher, non-blocking region routing with configurable country lookup, and canonical / hreflang metadata.
- M04: regional social cards and screenshots, mobile Lighthouse targets, copy fallbacks, optional analytics hook (off), sitemap / robots, and a build-time content security policy.
- M05: setup and downloads guide, runtime manifest with validated checksums and stable download links, installation instructions, artifact publishing skeleton, and self-hosting guide / agent prompt.
