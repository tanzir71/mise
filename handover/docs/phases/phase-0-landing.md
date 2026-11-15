# Phase 0 — Foundation and landing (T0) → `v0.1.0`

Goal: a fast, polished, region-aware landing page live on GitHub Pages, plus the monorepo the app will grow in.

---

## M00 · Repo, monorepo, CI, Pages skeleton · S
**Build**
- pnpm workspaces: `apps/landing`, `apps/web` (placeholder "Coming soon" page at `/app/`), `packages/ui`, `packages/core`.
- TypeScript strict, ESLint, Prettier, Vitest, Playwright.
- Root scripts as listed in `AGENTS.md`. `pnpm build` produces `site/` with the landing page at `/` and the app at `/app/`.
- Copy `handover/templates/.github` to `.github`. Set `BASE_PATH` from the repo name in the workflow.
- `CHANGELOG.md`, `handover/DECISIONS.md`, `handover/QUESTIONS.md` (start empty).

**Accept**
- [ ] A push to `main` deploys; `https://<user>.github.io/<repo>/` and `/app/` load.
- [ ] CI runs lint, typecheck, test and e2e (a smoke test that loads both pages).
- [ ] A PR build uploads the artifact without deploying.

## M01 · Tokens and UI primitives · S
**Build**
- `packages/ui/tokens.css` (from `handover/tokens/tokens.css`). Tailwind theme mapped to the CSS variables.
- Self-host fonts: Geist (400/500/600), Geist Mono (400), Hind Siliguri (400/500/600).
- Primitives: Button, Chip, Card, Section, Eyebrow, StatusWord, Icon (Lucide).
- A component gallery page at `/app/_ui` (behind a flag).

**Accept**
- [ ] Bengali text and ৳ render in Hind Siliguri with no tofu boxes.
- [ ] Focus rings are visible. Contrast is AA for every text/background pair used.

## M02 · Landing: Bangladesh page · M
**Build**
- All sections in `docs/02-landing-spec.md`, in order, with copy from `copy/landing.bd.json`.
- Components take copy as props, so M03 needs no new components.
- Static product visuals: use exported screenshots if available. Otherwise build faithful HTML mocks of:
  - the hero composite
  - the 10 feature block panels
  - the 6 day-in-the-life phones
  - the 4 business phones
- Responsive at 360/390/768/1024/1440. Specific behaviours:
  - the feature index wraps
  - the capture matrix stacks on phones
  - the comparison table becomes stacked rows
  - the "day" phones scroll horizontally on phones

**Accept**
- [ ] Visually matches Figma `113:3` at 1440, within reason.
- [ ] Equal-height cards in every grid (OCR pairs, checks, businesses, basics).
- [ ] No text overflow at 360 px. Arrows are fixed-size and centred.
- [ ] All anchors from the feature index scroll to the right section.

## M03 · International page + region router · S
**Build**
- `/intl/` from `copy/landing.intl.json` using the same components.
- `/` router script per `02-landing-spec.md` (query → saved choice → geo endpoint with 800 ms timeout → timezone/language → intl).
- Region pill in the nav and footer switches and remembers. `hreflang` alternates + canonical.

**Accept**
- [ ] Simulated Bangladesh (timezone `Asia/Dhaka`) lands on `/bd/`; others on `/intl/`. The pill overrides it and is remembered.
- [ ] With JS disabled, `/` shows links to both pages.
- [ ] The router adds < 2 KB of JS and never delays first paint of the target page.

## M04 · Landing polish · S
**Build**
- OG images per region. Favicon and app icons come from `handover/exports/brand/` (already rendered).
- Lighthouse pass and fixes.
- Analytics: none by default. Leave a hook for privacy-friendly analytics, behind config.
- CTA links from env: `PUBLIC_APP_URL`, `PUBLIC_WHATSAPP_URL` (BD), `PUBLIC_DEMO_URL` (Intl).

**Accept**
- [ ] Lighthouse mobile ≥ 90 / 95 / 95 / 95 on both pages.
- [ ] CLS < 0.05; first-load JS ≤ 30 KB gzipped.
- [ ] Release `v0.1.0` created with screenshots.

## M05 · Setup and downloads page · S
**Figma:** Setup desktop `124:4616`, phone `124:4868`. **Spec:** `docs/08-distribution.md`

**Build**
- `/setup/` page on the landing site (linked from the footer and from the app's Settings › Devices), in the same visual style.
- `downloads/manifest.json` (empty `items` for now) and `downloads/README.md`. The Pages build copies `downloads/` into `site/downloads/`.
- At runtime the page reads the manifest. Items not yet listed show "Coming in a later version". The web app and kitchen screen cards link to `/app/`.
- Full instructions for the extension (Developer mode › Load unpacked), the Android APK (**Allow from unknown sources**, with both the Android 8+ per-app "Allow from this source" and the older Settings › Security › Unknown sources; Play Protect note; notification access; battery; pairing), adb, checksums, updates and troubleshooting.
- Copy `templates/.github/workflows/artifacts.yml` into the repo (it no-ops until `apps/extension` / `apps/order-phone` exist).
- **Run your own copy on Vercel** section (`#vercel`): AI-agent steps, a "Copy prompt for your agent" button (from `prompts/04-deploy-own-vercel.md`), a Deploy to Vercel button, and what you get. Copy `templates/vercel.json` to the repo root. See `docs/08-distribution.md` → Self-hosting.

**Accept**
- [ ] The page renders with an empty manifest and with a sample manifest fixture (2 items).
- [ ] Download links point to `downloads/latest/...`; SHA-256 values are shown and copyable.
- [ ] The phone layout matches `124:4868`.
- [ ] A clean fork deploys to Vercel with `vercel deploy --prod` using the included `vercel.json`, and `/`, `/app/` and `/setup/` work.
