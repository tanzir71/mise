## Milestone
R7 · Visual QA harness (`handover/docs/09-refinement-appendix.md`)

## What shipped
`pnpm qa:visual` captures the production UI section by section at 1440 and 390px, then builds a portable `qa/report.html` with implementation, Figma and pixel-difference images. The current landing/setup config produces 64 comparisons. Filters and actual-pixel viewing make the report easier to inspect; dimension/content differences remain visible and the percentages are informational.

CI runs the harness and uploads `visual-qa` on PR/main builds. App milestones automatically join the same report by adding configs under `qa/configs/`; real page actions support onboarding and navigation. Missing exports, unavailable pages, duplicate capture IDs and page overflow fail the command. Extra image height is counted rather than cropped away.

Phase R verification is recorded in `docs/refinement-completion.md`. Mobile Lighthouse performance is 95 BD / 98 Intl; accessibility, best practices and SEO are 100. CLS is below 0.000225. Both 390px landing pages remain under 20,000px. The owner’s sign-off waiver is recorded; `v0.1.1` follows this PR’s merge and deployment.

## Visual QA artifact
CI artifact link will be added after this run uploads `visual-qa`. Download it and open `report.html`.

## Screenshots
![Reads anything at 1440px](https://raw.githubusercontent.com/tanzir71/mise/codex/r7-visual-qa/docs/screenshots/r7-bd-ocr-1440.png)
![Calm phone hero](https://raw.githubusercontent.com/tanzir71/mise/codex/r7-visual-qa/docs/screenshots/r7-bd-hero-390.png)
![Phone setup](https://raw.githubusercontent.com/tanzir71/mise/codex/r7-visual-qa/docs/screenshots/r7-setup-phone-390.png)

References: all 14 `sectionReferences` for both BD and Intl in `handover/exports/landing-assets.json`, plus `Setup · Download and install (desktop).png` and `Setup · On the shop phone (mobile web).png`. Intentional differences: phone reflow/disclosures, current Regular typography, AA secondary text, actual copy/manifest availability and native browser/OS chrome.

## Flags
No new flags; no product runtime change.

## Test plan
- [x] Lint and TypeScript/Astro checks.
- [x] 12 unit tests, including retina normalisation and preserved extra-height differences.
- [x] 57 browser checks on the unchanged production UI; CI repeats them.
- [x] 64 local visual comparisons; report file/image links checked.
- [x] Source/export/image payload guards and mobile Lighthouse targets.
- Offline behaviour is unchanged; app offline acceptance begins in M10.

## Docs
- [x] CHANGELOG, roadmap, DECISIONS, refinement checklist and PR template updated.
- [x] `qa/README.md` documents report use and app configs.

## Live URLs
https://tanzir71.github.io/mise/bd/ · https://tanzir71.github.io/mise/intl/ · https://tanzir71.github.io/mise/setup/
