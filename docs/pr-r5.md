## Milestone

R5 · Phone pass (`handover/docs/09-refinement-appendix.md`).

## What shipped

At 390px the landing page was about 30,200px tall. It now measures 19,845px for Bangladesh and 19,883px for International. Phone workflows show their image, eyebrow, title and lead, with steps and fallback text in a closed native “How it works” disclosure. Checks show six cards and a “Show all 12” disclosure. Basics and business cards use two columns, with compact phone spacing and complete, uncropped exports.

Desktop disclosures expand automatically at 768px and above. Choices persist during resizes within the phone range; crossing the breakpoint restores the appropriate layout. Without JavaScript the same content remains available through native summaries. Touch targets, including footer links and region controls, are at least 44×44px.

Fixed an Astro style-order issue where the icon-mask primitive could override rules hiding desktop-only arrows. No new product illustrations or panels were drawn.

## Screenshots

![Phone operation](https://raw.githubusercontent.com/tanzir71/mise/codex/r5-phone-layout/docs/screenshots/r5-bd-operations-390.png)
![Six checks and expansion](https://raw.githubusercontent.com/tanzir71/mise/codex/r5-phone-layout/docs/screenshots/r5-bd-checks-390.png)
![Two-column basics](https://raw.githubusercontent.com/tanzir71/mise/codex/r5-phone-layout/docs/screenshots/r5-bd-basics-390.png)

| 390 px | 1440 px |
|---|---|
| ![Expanded workflow](https://raw.githubusercontent.com/tanzir71/mise/codex/r5-phone-layout/docs/screenshots/r5-bd-operations-open-390.png) | ![Desktop operation](https://raw.githubusercontent.com/tanzir71/mise/codex/r5-phone-layout/docs/screenshots/r5-bd-operations-1440.png) |

Twenty captures cover both regions, closed/open disclosures and desktop layouts. The Bangladesh desktop Operations and Checks captures have identical SHA256 hashes to R4.

References: `Operations in detail · BD.png`, `Checks built in · BD.png`, `The basics · BD.png`, `Businesses · BD.png` and corresponding Intl files under `handover/exports/landing/`. Phone layouts reflow these desktop references using the R5 rules. Per prompt 05, screenshots precede R7's report harness.

## Flags

- [x] No new flags.

## Test plan

- [x] Lint, strict type checks, 11 unit/integration tests and all 56 browser checks pass locally.
- [x] Both regions: no horizontal overflow at 360, 375, 390 and 414px; page height below 20,000px at 390px; 44×44px visible controls.
- [x] Keyboard disclosure operation, all 12 checks on expansion, steps/fallback visibility, breakpoint changes and native behavior without JavaScript.
- [x] Axe on closed and expanded phone states, existing desktop/phone accessibility, equal-height cards, image/CLS, routing and setup checks.
- [x] Export/source/image guards pass. Each region retains 23 pictures, one inline icon and an 88KB eager 2× hero AVIF.
- [x] Supplied Bangla/৳ content remains intact. No offline behavior introduced in this static milestone.

## Docs

- [x] CHANGELOG, R5 roadmap checkbox and DECISIONS updated.

## Live URL (after merge)

[Bangladesh](https://tanzir71.github.io/mise/bd/) · [International](https://tanzir71.github.io/mise/intl/)
