# 02 · Landing page spec

The landing page ships first, as the static Astro site `apps/landing`, deployed to GitHub Pages.

- **Figma frames:**
  - Bangladesh: https://www.figma.com/design/FVXWo2wVq4nPS3kdsR4TUv/Tools?node-id=113-3
  - International: https://www.figma.com/design/FVXWo2wVq4nPS3kdsR4TUv/Tools?node-id=120-2353
- **Copy:** `handover/copy/landing.bd.json` and `landing.intl.json`. Use them verbatim. Both pages render from **one set of components** fed by the copy file.

## Routes
| Path | Content |
|---|---|
| `/` | Region router. No visible content beyond a minimal fallback with links to both pages |
| `/bd/` | Bangladesh page (৳, bKash, Nagad, Foodpanda, Pathao, Steadfast; local names; some Bangla in examples) |
| `/intl/` | International page (generic partners; local currency where known) |
| `/app/` | The Mise web app (from Phase 1) |

Use `base` from env (`BASE_PATH`, e.g. `/mise/`) so it works under `https://<user>.github.io/<repo>/`. When a custom domain is added later, `BASE_PATH=/`.

## Region switching ("chosen by IP")
GitHub Pages has no server, so the choice happens in the browser and must never block the page.

1. If the URL has `?region=bd|intl`, use it and save it.
2. Else, if `localStorage['mise.region']` is set, use it.
3. Else, look up the country, trying in this order:
   - a. Fetch the country from a pluggable geolocation endpoint (`PUBLIC_GEO_URL` in the build env), with an 800 ms timeout. Verify the provider's current terms before choosing it, and keep it swappable. Later this moves to a Cloudflare Worker that reads the `CF-IPCountry` header.
   - b. Fallback: timezone `Asia/Dhaka`, or `navigator.languages` containing `bn` → Bangladesh.
   - c. Otherwise → International.
4. `location.replace('/bd/' | '/intl/')`, preserving the hash and UTM params.

Also required:
- **Region pill** in the nav and footer ("Bangladesh · English ▾" / "International · English ▾"). Switching saves the choice and navigates.
- **SEO:** `hreflang` alternates (`en-BD` → `/bd/`, `en` → `/intl/`, `x-default` → `/`). Each page has a canonical tag pointing at itself.
- `/` includes `<noscript>` links to both pages.

## Sections (in order)
Section IDs are used for in-page anchors from the feature index.

1. **Nav** (black): logo; links (Product, AI operator, Reads anything, Businesses, Pricing → `#cta` for now); region pill; Sign in (→ `/app/`); "Start free" (→ `/app/`). On phones: hamburger with a full-screen sheet.
2. **Hero** (`#top`, black):
   - eyebrow chip "New: let Claude or Codex run a shift →"
   - headline, lead, two CTAs, trust line with partner names
   - right side: product composite (desktop Live store screenshot + phone Orders screenshot) with 4 floating chips
   - on phones: the visual goes below the copy and shows the phone only
3. **Feature index** (`#features`): 14 pills linking to sections 4–7. The first two (AI operator, Reads anything) are filled ink.
4. **01 · AI operator** (`#ai`):
   - headline + lead
   - permissions panel (6 rows with a Watch/Ask/Alone segmented control; on the landing page it's static, with optional click-to-toggle)
   - 4 benefits with icons
   - "A shift with an agent" timeline (6 steps, black panel)
   - failure ladder (4 steps with arrows)
   - "Connect Claude or Codex in two minutes" code panel
5. **02 · Reads anything** (`#ocr`, grey): 6 before → after cards in a 3×2 grid, equal heights.
6. **03 · Every way data gets in** (`#capture`, black):
   - 10-row matrix: source (icon, name, examples) → how Mise catches it → result pills
   - footer note about manual fallbacks
   - on phones each row becomes a stacked card
7. **04 · Checks built in** (`#checks`): 12 "When → Mise" cards, 3 per row, equal height, each with a category tag and an icon.
8. **05 · The whole operation, part by part** (`#detail`): 10 alternating feature blocks (07–16). Each block has:
   - a product screenshot panel (680×500, grey, radius 28) and a floating callout chip
   - an eyebrow number, a 40 px title, a lead
   - 3 numbered steps
   - an "If something goes wrong" fallback box
9. **A day with Mise** (`#day`, black): 6 phone screenshots with time + caption. Horizontal scroll on phones.
10. **Businesses** (`#businesses`): 4 equal-height cards (Restaurants, Online shops, Food stalls, Corner shops), each with a phone shot and 3 ticks.
11. **The basics** (`#basics`, grey): 12 equal-height tiles, 4 per row (2 on tablet, 1 on phone).
12. **Comparison** (`#compare`): table Mise vs Typical POS vs WhatsApp + notebook, 8 rows. On phones it becomes stacked rows.
13. **CTA** (`#cta`, black): headline, sub-line, "Start free" + secondary (BD: "Chat with us on WhatsApp" → `wa.me` link from env; Intl: "Book a demo" → link from env).
14. **Footer** (black): three link columns, region pill + note, ©.

## Visual assets
- **Product screenshots:** use the files in `handover/exports/phone/` and `exports/desktop/` (2× PNG). Convert them to WebP at build time, keep a PNG fallback, and place them in `apps/landing/src/assets/shots/`.
  - Section references for both regions are in `exports/landing/bd/` and `exports/landing/intl/`.
  - If `exports/phone/` is empty, run `FIGMA_TOKEN=… node handover/scripts/export-figma.mjs` once, or ask the owner to run it. Don't fall back to blurry crops.
- **Logo and icons:** `exports/brand/` (SVG logo, favicon, PWA and maskable icons) and `exports/icons/*.svg`.
- **Images:** lazy-load below the fold. Use `width`/`height` attributes to avoid layout shift.
- **Shadows:** `--shadow-soft` with a 1 px `--border` outline. Never a heavy drop shadow.
- **Arrows:** fixed-size 18 px icons, vertically centred. Never stretched.

## Quality bars
- Lighthouse on mobile: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95.
- Total JS on first load ≤ 30 KB gzipped: region router plus nav sheet. Everything else is static HTML/CSS.
- Fonts self-hosted with `font-display: swap`; preload Geist 400/600 only.
- No layout shift from fonts or images (CLS < 0.05).
- Text never overflows its container at 360 px. Test the longest strings.
- Cards in the same row are always equal height.
- Open Graph image per region (1200×630) built from the hero.
