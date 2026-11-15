# Phase R verification

R0–R6 are merged and deployed. R7 adds the reusable comparison harness and completes the refinement implementation. Tag `v0.1.1` after R7 passes CI, merges and deploys; then start M10.

The owner explicitly waived further sign-off prompts. This is recorded in the R4 PR and `handover/DECISIONS.md`.

| Check | Result |
|---|---|
| Export completeness | 76 required landing files, 270 indexed exports present |
| Product imagery | 23 Figma pictures per region; complete PNG bounds, AVIF/WebP/PNG, 1×/2× |
| Eager hero payload | 88KB AVIF at 2× per region |
| Marketing source guard | No drawn app/device/browser mockups |
| Phone width | No overflow at 360, 375, 390 and 414px |
| Page height at 390 | BD 19,845px; Intl 19,883px |
| Mobile Lighthouse performance | BD 95; Intl 98 |
| Mobile Lighthouse accessibility / best practices / SEO | 100 / 100 / 100 in both regions |
| Cumulative layout shift | 0.000225 or lower in both regions |
| Automated validation | Lint, TypeScript/Astro, 12 unit tests and 57 browser checks |
| Visual report | 64 comparisons; region/page filters, actual-pixel view, reference and diff images |
| Desktop landing differences | 1.43–4.93%, informational; not a visual acceptance score |

Lighthouse was measured on the local compressed static production build, using the default cold mobile profile. Recorded metrics: `docs/quality/lighthouse.json`.

Visual comparisons use the original section mappings. The setup desktop reference is also shown whole, alongside individual explicitly listed reference regions. At 390px, desktop landing references provide layout context rather than an exact phone baseline. Setup deliberately retains real manifest availability and Phase 0 notices, uses the current Regular type rules, and leaves browser/OS chrome to the device. These differences are stated in the report and R6 PR.

`qa/README.md` documents the harness and capture configuration for M10 onward. CI uploads a portable `visual-qa` artifact for each PR/main run. The PR template requires its link and three inline screenshots.
