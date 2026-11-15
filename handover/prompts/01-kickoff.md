# Prompt 1 — Kickoff (paste into Codex)

You are building **Mise** in this repository. Everything you need is in `/handover`.

1. Read `AGENTS.md` (repo root), then these, in order:
   - `handover/README.md`
   - `handover/docs/03-roadmap.md`
   - `handover/docs/02-landing-spec.md`
   - `handover/docs/01-design-system.md`
   - `handover/docs/phases/phase-0-landing.md`
2. Start Phase 0 at milestone **M00** and work through M00 → M05, in order.
3. Each milestone:
   - create a branch named after it
   - implement it to its acceptance criteria
   - make lint, typecheck, test and e2e pass
   - update `CHANGELOG.md`, tick it in `handover/docs/03-roadmap.md`, open a PR using the template, and merge it once CI is green
   - after the merge, confirm the GitHub Pages deploy and put the live URL in the PR
4. Use the copy in `handover/copy/landing.bd.json` and `landing.intl.json` exactly. Use the tokens in `handover/tokens/`.
5. Visual assets are in `handover/exports/`: logo and icons in `brand/`, screen PNGs in `phone/` and `desktop/`, landing section references in `landing/`, SVG icons in `icons/`.
   - If the PNG folders are empty, run `node handover/scripts/export-figma.mjs` with `FIGMA_TOKEN` set (ask the owner for the token if you don't have it).
   - Use HTML/CSS mocks only as a temporary stand-in, and note it in `handover/QUESTIONS.md`.
6. Don't stop to ask questions that can be decided later. Write them in `handover/QUESTIONS.md`, choose the most reasonable option, record it in `handover/DECISIONS.md`, and continue.
7. When Phase 0 is done, tag `v0.1.0`, create a GitHub Release with screenshots, and summarise:
   - what shipped
   - the live URLs (`/bd/`, `/intl/`, `/setup/`)
   - any open questions

Rules to keep in mind:
- No email anywhere.
- Static only in Phase 0 (no backend, no paid services).
- Equal-height cards. No text overflow at 360 px. Fixed-size arrows.
- Soft shadows only.
