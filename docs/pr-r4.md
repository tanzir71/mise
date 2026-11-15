## Milestone

R4 · Match each landing section (`handover/docs/09-refinement-appendix.md`). Implementation is ready; the required owner sign-off remains before merge.

## What shipped

The landing now follows the supplied section references: regular 40px headlines, 48px CTA, reference backgrounds and spacing, permissions without extra headers, a six-step timeline, two adjacent agent panels, horizontal before/after cards, a boxed capture matrix, compact check cards and basic tiles, a plain comparison table, a left-aligned CTA and a four-column footer. Removed both gradients and the extra decorations absent from the references. The approved nav/hero and complete exported product images are retained.

Secondary text on grey meets AA. The supplied copy remains the source, including its detail numbering; detail titles follow the updated written Regular rule. The existing Setup and downloads link is kept in the footer's region column. The picture test now reads its DOM attributes in one batch, preserving its assertions while avoiding hundreds of browser round trips.

## Screenshots and owner review

The owner approved the hero after R2. These three sections are prepared for the remaining R4 sign-off:

![Operations](https://raw.githubusercontent.com/tanzir71/mise/codex/r4-section-refinement/docs/screenshots/r4-bd-detail-first-1440.png)
![A day with Mise](https://raw.githubusercontent.com/tanzir71/mise/codex/r4-section-refinement/docs/screenshots/r4-bd-day-1440.png)
![Businesses](https://raw.githubusercontent.com/tanzir71/mise/codex/r4-section-refinement/docs/screenshots/r4-bd-businesses-1440.png)

| 390 px | 1440 px |
|---|---|
| ![Phone day](https://raw.githubusercontent.com/tanzir71/mise/codex/r4-section-refinement/docs/screenshots/r4-intl-day-390.png) | ![International businesses](https://raw.githubusercontent.com/tanzir71/mise/codex/r4-section-refinement/docs/screenshots/r4-intl-businesses-1440.png) |

[Full visual review, references and section measurements](https://github.com/tanzir71/mise/blob/codex/r4-section-refinement/docs/r4-visual-review.md). All 60 captures are committed. Each region's 14 section heights is within 7px of its supplied 1440px reference. Per prompt 05, screenshots precede R7's HTML/pixelmatch report and artifact.

References in `handover/exports/landing/`, for both `· BD.png` and `· Intl.png`: Nav, Hero, Feature index, Agent controls, Reads anything, Data capture, Checks built in, Operations in detail, A day with Mise, Businesses, The basics, Comparison, CTA and Footer.

## Flags

- [x] No new flags; this is refinement of existing static content.

## Test plan

- [x] Lint and strict type checks pass locally.
- [x] All 11 unit/integration tests and 46 browser checks passed locally. The 8 focused type/surface, accessibility and handoff checks passed again after final layout adjustments.
- [x] Existing responsive and equal-height card checks pass at 360, 390, 768, 1024 and 1440px; day-row keyboard scrolling passes at 360, 375, 390 and 414px.
- [x] Axe passes on both landing pages and setup, including phones. No gradients. Hero geometry and CLS checks pass.
- [x] Export, source and image-budget guards pass: 23 pictures, one inline icon, 88KB eager 2× AVIF per region.
- [x] Supplied Bengali/৳ imagery retained. No offline behavior introduced in this static milestone.

## Docs

- [x] CHANGELOG and DECISIONS updated.
- [ ] R4 roadmap checkbox stays open until owner sign-off. R5–R7 remain pending.
- [ ] Owner signs off on Operations in detail, A day with Mise and Businesses before merge, as R4 requires.

## Deployment

[Local Bangladesh preview](http://127.0.0.1:4321/bd/#detail) · [Local International preview](http://127.0.0.1:4321/intl/#detail)

After approval and merge: [Bangladesh](https://tanzir71.github.io/mise/bd/) · [International](https://tanzir71.github.io/mise/intl/). Public Pages currently contains the completed R3 deployment.
