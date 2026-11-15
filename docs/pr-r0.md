## What shipped

The owner's refinement handover and all supplied Figma exports are now tracked in the repository. All 270 indexed exports are present, including the 76 required landing files. `@figma` resolves directly to `handover/exports`; there is no duplicate asset directory in the landing app.

`pnpm check:exports` runs before the production build in CI and fails for missing or empty landing exports. A subprocess fixture proves the missing/empty-file failure and folder filter. The manual Figma export workflow is installed; it uses FIGMA_TOKEN only when explicitly run. Single-file API retries retain the configured export scale.

## Visual reference and rollout

References for the next UI work: `handover/exports/landing/Nav · BD.png`, `Hero · BD.png`, and the Intl equivalents. R0 establishes the required assets and checks; the existing drawn previews are replaced in R1 and the calm hero is rebuilt in R2. Per prompt 05, screenshot comparisons are used before the R7 visual harness is introduced.

## Validation

`pnpm check:exports`, lint, strict type checks, 10 unit/integration tests and the production build pass locally. CI repeats these and all browser checks under `/mise/`.

## Deployment

https://tanzir71.github.io/mise/bd/ · https://tanzir71.github.io/mise/intl/

After R2 is deployed, stop for the owner's required hero review before R3.
