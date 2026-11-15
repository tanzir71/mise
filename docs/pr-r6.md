## Milestone
R6 · Setup page and regional share images (`handover/docs/09-refinement-appendix.md`)

## What shipped
The setup page now follows the supplied four-card desktop download layout and five-step order-phone guide. The shared light header supports the setup navigation without altering the landing navigation. Native disclosures keep all device guides reachable on phones, including direct links to kitchen setup and Vercel instructions.

Actual manifest data controls downloads, versions, sizes, dates, minimum versions, repository links and SHA-256 copying. Empty and failed manifests remain honest and recoverable. Production has no device binaries yet; the sample screenshots use an intercepted test manifest only. The reference's browser frame and Android install dialog remain native browser/OS responsibilities.

Both regional OG images are 1200×630, using the complete exported hero phone on #EDEDEC. The current Regular type rules supersede the older setup reference's bold type. Existing Phase 0 availability notices, checksum utilities, browser guides and deployment prompt remain available.

## Screenshots
| 390 px | 1440 px |
|---|---|
| ![Published availability](https://raw.githubusercontent.com/tanzir71/mise/codex/r6-setup-and-og/docs/screenshots/r6-setup-live-390.png) | ![Desktop setup](https://raw.githubusercontent.com/tanzir71/mise/codex/r6-setup-and-og/docs/screenshots/r6-setup-live-hero.png) |
| ![Sample manifest only](https://raw.githubusercontent.com/tanzir71/mise/codex/r6-setup-and-og/docs/screenshots/r6-setup-sample-390.png) | ![Sample desktop](https://raw.githubusercontent.com/tanzir71/mise/codex/r6-setup-and-og/docs/screenshots/r6-setup-sample-1440.png) |

![BD share image](https://raw.githubusercontent.com/tanzir71/mise/codex/r6-setup-and-og/apps/landing/public/og-bd.png)

References: `Setup · Download and install (desktop).png`, `Setup · On the shop phone (mobile web).png`, `lp-bd-hero-phone.png`, `lp-intl-hero-phone.png`, mapped in `handover/exports/landing-assets.json`.

## Flags
No new flags. No device builds or backend added.

## Test plan
- [x] Lint, TypeScript/Astro checks, 11 unit tests.
- [x] 57 browser checks, including setup manifest recovery, copy/manual fallback, direct guide links, responsive layout and axe AA.
- [x] No overflow at 360, 390, 768, 1024 and 1440 px, including expanded checksum content.
- [x] Source/export/payload guards; 23 pictures per landing region, 88KB eager 2× AVIF.
- [x] Desktop and phone captures with empty and sample manifests; inspected against both references.
- [x] No registered-mark glyph in application/package source.
- Offline operation is outside Phase 0; unchanged.

## Docs
- [x] CHANGELOG, roadmap and DECISIONS updated.
- Screenshot evidence used before the R7 visual-report harness, as permitted by Prompt 05.

## Live URL (after merge)
https://tanzir71.github.io/mise/setup/
