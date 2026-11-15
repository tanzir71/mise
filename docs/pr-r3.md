## Milestone

R3 · Product images in the sections (`handover/docs/09-refinement-appendix.md`). The owner approved the deployed R2 hero and instructed continuation.

## What shipped

The twelve detail exports now render at 680×500 on a 1440px page, alternating between the left and right columns. The text stays beside each export. Removed layout rules that shrank the pictures and prevented alternating placement.

The day section shows all six 179×388 visible screens on desktop, retaining the full 235.5×444.5 exports including shadows. On phones it becomes a keyboard-accessible scroll-snap row with 200px pictures, 16px gaps and 20px side padding. Business cards use all four complete 251×406 exports, aligned to their 350px visible screens in equal-height cards. Removed the extra number labels, divider and border that were absent from the reference.

All 23 supplied pictures per region keep their mapped alt text and AVIF/WebP/PNG variants. No extra screen panels, chips, frames or shadows were added. Broader section polish remains R4; mobile content folding remains R5.

## Screenshots

![Operations desktop](https://raw.githubusercontent.com/tanzir71/mise/codex/r3-product-images/docs/screenshots/r3-bd-operations-1440.png)
![Day desktop](https://raw.githubusercontent.com/tanzir71/mise/codex/r3-product-images/docs/screenshots/r3-bd-day-1440.png)
![Businesses desktop](https://raw.githubusercontent.com/tanzir71/mise/codex/r3-product-images/docs/screenshots/r3-bd-businesses-1440.png)

| 390 px | 1440 px |
|---|---|
| ![Day phone](https://raw.githubusercontent.com/tanzir71/mise/codex/r3-product-images/docs/screenshots/r3-bd-day-390.png) | ![International day](https://raw.githubusercontent.com/tanzir71/mise/codex/r3-product-images/docs/screenshots/r3-intl-day-1440.png) |

Reference files in `handover/exports/landing/`: `Operations in detail · BD.png`, `A day with Mise · BD.png`, `Businesses · BD.png` and the corresponding three `· Intl.png` references. Every `detail.01–12`, `day.01–06` and `businesses.01–04` mapping in `landing-assets.json` is used. Screenshots precede the R7 report harness, per prompt 05.

## Flags

- [x] No new flags.

## Test plan

- [x] Lint, strict type checks and 11 unit/integration tests pass locally.
- [x] All 44 browser checks pass, including both regions' twelve image dimensions/alternating positions, complete image decoding, four business exports and mobile keyboard scrolling at 360, 375, 390 and 414px.
- [x] Existing axe, equal-height cards, routing, setup and responsive checks pass through 1440px.
- [x] All 76 landing exports present. Marketing guard and image budgets pass: 23 pictures / 21 inline icons / 88KB eager 2× AVIF per region.
- [x] Supplied Bengali/৳ imagery retained. No new offline behavior in this static milestone.

## Docs

- [x] CHANGELOG and R3 roadmap checkbox updated.
- [x] Intrinsic shadow alignment and responsive layout choices recorded in DECISIONS.

## Live URL (after merge)

[Bangladesh](https://tanzir71.github.io/mise/bd/#detail) · [International](https://tanzir71.github.io/mise/intl/#detail)
