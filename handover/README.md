# Mise — handover for Codex

This folder is everything an engineering agent (Codex) needs to build **Mise**: first the marketing landing page on GitHub Pages, then the working app, shipped in small, usable increments.

Mise is an operations co-pilot for small businesses that sell through chats, delivery apps, counters and their own storefront: restaurants, online shops, food stalls and corner shops. Bangladesh first, reusable in any market.

## How to use this folder

1. Create an empty GitHub repo (suggested name: `mise`).
2. Copy this whole folder into the repo as `/handover`.
3. Copy `handover/AGENTS.md` to the repo root (Codex reads `AGENTS.md` automatically).
4. Copy `handover/templates/github` to the repo root and rename it to `.github`, and `handover/templates/vercel.json` to the root. Copy `handover/templates/CHANGELOG.md` to the root, and `handover/downloads-template/` to `/downloads`.
5. In the repo settings, set **Pages → Source: GitHub Actions**.
6. Start Codex with the prompt in `prompts/01-kickoff.md`.
7. After each milestone, continue with `prompts/02-next-milestone.md`.
8. **Refinement (added 15 Nov 2026):** export the Figma pages into `handover/exports/` (steps in `exports/README.md`), commit, then give Codex `prompts/05-refinement.md`. It does Phase R before M10.

## What's inside

| Path | What it is |
|---|---|
| `AGENTS.md` | Standing instructions for Codex: stack, commands, conventions, definition of done |
| `docs/00-product-brief.md` | What Mise is, who it's for, the product principles |
| `docs/01-design-system.md` | Visual rules, tokens, components, accessibility |
| `docs/02-landing-spec.md` | Landing page sections, region switching, SEO, performance |
| `docs/03-roadmap.md` | **The rollout order**: every milestone scored by effort and dependencies, with a checklist |
| `docs/04-architecture.md` | Monorepo layout, local-first data, later sync, integrations, security |
| `docs/05-data-model.md` | Entities and fields, money and phone formats |
| `docs/06-release-process.md` | Branches, PRs, versions, feature flags, deploys |
| `docs/07-figma-map.md` | Links to every Figma frame by feature |
| `docs/08-distribution.md` | Unsigned device builds in the repo, `downloads/` manifest, setup page |
| `docs/09-refinement-appendix.md` | **Phase R**: what's wrong on the live site, the new calm hero, image-first rules, work items R0–R7, visual QA |
| `docs/packs.json` | Business and market packs (seed data) |
| `docs/phases/*.md` | Detailed milestone specs with acceptance criteria, phase by phase |
| `tokens/tokens.json`, `tokens/tokens.css` | Design tokens exported from Figma |
| `exports/` | Logo and app icons (included). Every screen, landing image, landing section, board and icon from Figma, exported by the owner or by `scripts/export-figma.mjs`. See `exports/README.md`, `INDEX.md` and `landing-assets.json` |
| `scripts/export-figma.mjs` | Figma exporter (Node 18+, needs `FIGMA_TOKEN`); `--check` lists missing exports without a token |
| `copy/landing.bd.json`, `copy/landing.intl.json` | Final landing copy for both regions |
| `templates/github/` | Pages deploy workflow, device-artifacts workflow, Figma export workflow, PR template, issue template |
| `downloads-template/` | Starter `downloads/` folder (manifest + README) for unsigned device builds |
| `prompts/` | Copy-paste prompts to drive Codex (`05-refinement.md` = Phase R), plus `04-deploy-own-vercel.md` for shop owners' agents |

## The rollout rule (short version)

Ship what works with the fewest moving parts first.

1. **Static** (no backend): the landing page.
2. **On one device** (browser storage): counter, khata (credit), manual orders, stock, exports. These are already useful to a real shop.
3. **Customer links without a backend**: order link that sends to WhatsApp, QR posters, reminder links.
4. **Backend and sync**: accounts, many devices, kitchen screen, tracking links, staff check-in, Live store.
5. **Capture automation**: share target, OCR, payment SMS, browser extension, Android order phone.
6. **AI operator**: MCP server, agent console, permissions and audit.
7. **Advanced**: couriers and COD reconciliation, planning, performance, win-back, more markets.

Every milestone is merged to `main` and deployed to GitHub Pages straight away. Unfinished work stays behind a feature flag. Details are in `docs/03-roadmap.md`.

## Source of truth

- Figma: https://www.figma.com/design/FVXWo2wVq4nPS3kdsR4TUv/Tools
- If this folder and Figma disagree on behaviour, this folder wins. If they disagree on visuals, Figma wins.
- Questions Codex can't answer from here go in `handover/QUESTIONS.md` (Codex creates it). Codex then continues with the most reasonable choice and notes it.
