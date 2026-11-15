## What shipped

Setup/downloads page with four device cards, an empty-manifest coming-soon state and validated runtime metadata for future extension/APK builds. Published entries expose stable latest URLs, versions, size/date, repo links, minimum versions and copyable SHA-256 values. Failed requests can be retried; clipboard failures expose selectable text.

The guide covers unpacked Chrome installation, Android unknown-source settings across versions, Play Protect, notification access, battery settings, pairing, adb, checksums, updates and troubleshooting. Self-hosting includes an agent prompt, manual fallback, Deploy to Vercel link and full guide. All future device features are clearly labelled. No native app or backend was added.

The artifact script computes real checksums, copies stable files and retains recent versions with checked cleanup paths. CI remains a no-op for absent device projects. The deployment guide correctly schedules PWA/offline functionality for Phase 1.

## Validation

- Lint, strict type checks and 9 unit/integration checks pass.
- All 30 browser checks pass with `/` and `/mise/` production builds.
- Empty and two-item manifests, malformed metadata, failed requests, clipboard fallback, long checksums, blocked storage and no-JavaScript routes covered.
- Responsive at 360/390/768/1024/1440. Axe WCAG AA reports no violations on both regions and setup, on desktop and phones.
- Social images are 1200×630. Lighthouse mobile evidence remains in docs/quality/lighthouse.json.
- Root build and Vercel config are verified; no deployment to an owner's Vercel account was requested or performed.

Screenshots: docs/screenshots/setup-390.png and setup-1440.png. Figma tools/exports remain unavailable; permitted HTML/CSS product previews are documented in handover/QUESTIONS.md.

## Deployment

https://tanzir71.github.io/mise/setup/

Completes Phase 0; v0.1.0 is tagged and released after the main deployment is verified.
