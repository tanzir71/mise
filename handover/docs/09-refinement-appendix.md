# 09 · Refinement appendix: Phase R (do this before M10)

**Status: refinement implemented.** R0–R7 are checked in the roadmap. R7 must pass CI, merge and deploy before tagging `v0.1.1` and starting M10. The owner reviewed the original live site on 15 Nov 2026.

Live pages reviewed: `https://tanzir71.github.io/mise/bd/`, `/intl/`, `/setup/`.

## 1 · What's wrong on the live site, and why

| # | What the owner sees | Cause | Fixed by |
|---|---|---|---|
| 1 | **The hero is busy.** It has a dark full-bleed background and a 72 px SemiBold headline. It also has an eyebrow pill, four floating notification chips, a phone laid over a laptop, a bold partner strip and a mono caption. | The old Figma hero and the old landing type values in `01-design-system.md`. **Both have been changed** (see §2). | R2 |
| 2 | **Every product screen is hand-drawn in HTML.** `/bd/` has 507 inline SVGs and only 2 `<img>` tags (both the logo). The "screens" don't match the designs and look crude at every size. | `handover/exports/` was empty. The spec said to run the export script, nobody ran it, and the build fell back to redrawing. | R0, R1, R3 |
| 3 | **Headlines shout.** Section headlines are 56 px SemiBold and the CTA is 72 px. | The same old type values. | R4 |
| 4 | **Phone layout.** The hand-drawn previews overflow a 375 px screen by about 13 px. The page is about 36,400 px long on a phone (22,100 px on desktop). | Redrawn mockups, and every detail block fully expanded on phones. | R5 |
| 5 | **The setup page doesn't match Figma.** The headline "A home for Mise. On every device." was invented (Figma: "Install Mise on your devices") and the nav is dark. | Copy written from scratch instead of taken from Figma. | R6 |
| 6 | **"®" after the logo.** | It isn't in Figma, and the mark isn't registered. | R6 |
| 7 | **Two CSS gradients** on `/bd/`. | — | R4 |

## 2 · What changed in Figma on 15 Nov 2026

- **Nav and hero, both regions** (`113:4`, `116:927`, `120:2354`, `120:2371`), rebuilt to be calm:
  - light `#EDEDEC` background
  - a 56 px Regular headline, one short lead, two buttons and one quiet trust line
  - a single phone on the right
  - no pill, no chips, no laptop
- **Section headlines** are now 40 px Geist Regular. The CTA headline is 48 px Regular.
- **Setup page nav** (`124:4616`) is light, matching the landing nav.
- **Export settings everywhere.** Every app screen, board, landing section, landing image and icon now has export settings. The owner exports each page with Figma's **Export** (Ctrl/Cmd + Shift + E) into `handover/exports/…`. `scripts/export-figma.mjs` (with `FIGMA_TOKEN`) produces the same files. See `exports/README.md`.
- **Landing images** to embed are named `lp-<region>-…` and mapped to page slots in **`exports/landing-assets.json`**.
- **Renamed frames.** A few frames were renamed only to remove `:` `?` `/` from file names. Node IDs did not change.
- **Updated docs:** `01-design-system.md` (landing type values, plus new rules: calm hero, product screens are images, no ®) and `02-landing-spec.md` (nav, hero, assets).

## 3 · Ground rules for this pass and every milestone after it

1. **Figma wins on visuals.** The references are the PNGs in `handover/exports/`. `exports/INDEX.md` links each file to its node. If you have the Figma MCP server, also use `get_screenshot` / `get_design_context` on the node.
2. **Image-first on marketing pages.** Every app screen, phone, laptop, browser window and product panel on the landing and setup pages is an exported image from `exports/landing/lp-*.png`.
   - **Stays as HTML:** text, buttons, pills, tables, the permissions panel, the shift timeline, the failure ladder, the code panel, the before→after cards, the capture matrix, the check cards and the basics tiles. These are real UI in Figma, not screenshots.
   - **Not allowed:** any markup that imitates an app screen, phone, laptop or browser window. This includes CSS bezels or chips around an exported image.
3. **Copy comes from `handover/copy/*.json` only.** Never invent headlines. The hero copy was updated (the eyebrow and chips were removed, and there's a new lead and trust line).
4. **Don't invent layout.** Figma has desktop frames for the landing page. For smaller screens, stack the desktop layout in reading order. Never add decoration that isn't in Figma.
5. **Stop if exports are missing.**
   1. Run `node handover/scripts/export-figma.mjs --check --only=landing` (no token needed).
   2. If it fails, write it in `handover/QUESTIONS.md` and comment on the PR asking the owner to export.
   3. If the repo has a `FIGMA_TOKEN` secret, run the **Figma export** workflow instead.
   4. Never fake, crop or redraw a missing image.
6. **Display size comes from the file.** Show each export at its pixel size ÷ `exportScale` (from `landing-assets.json`). Soft shadows can make a PNG slightly larger than the node, so don't force the node size.

## 4 · Work items: one PR each, deploy after each

### R0 · Exports in the repo, checked in CI · S
- The owner commits the Figma exports to `handover/exports/` (folders listed in `exports/README.md`).
- Import landing images straight from there through a Vite/Astro alias (`@figma` → `handover/exports`), so there is one copy only. Don't duplicate them into `apps/landing`.
- Add `pnpm check:exports` = `node handover/scripts/export-figma.mjs --check --only=landing`. Run it in CI before `pnpm build`.
- Copy `handover/templates/github/workflows/figma-export.yml` to `.github/workflows/`. It's manual, and needs the repo secret `FIGMA_TOKEN`.
- **Accept when:** CI fails if any file listed under `landing/` in `exports/manifest.json` is missing.

### R1 · Image pipeline, and delete the hand-drawn mockups · M
- **One `<Shot>` component.** Usage: `<Shot region="bd" slot="detail.01" />`.
  - It reads `landing-assets.json` and renders Astro `<Picture>` with AVIF, WebP and a PNG fallback, at 1× and 2× of the display size.
  - It sets explicit `width`/`height`, alt text from the JSON, and `decoding="async"`.
  - `loading="lazy"` everywhere except the hero, which uses `loading="eager"` and `fetchpriority="high"`.
- **Delete every hand-drawn mockup** and its CSS. That includes `.product-preview`, `.phone-preview`, `.preview-shell`, `.preview-main`, `.phone-status`, and anything else that draws a phone, laptop, browser or app UI.
- **Add a CI guard:** a grep that fails the build if those class names come back.
- **Weight budgets:**
  - hero phone ≤ 90 KB (AVIF, 2×)
  - each detail image ≤ 140 KB
  - above-the-fold images on `/bd/` ≤ 150 KB in total
- **Accept when:**
  - inline `<svg>` on `/bd/` is icons only (≤ 120)
  - images are sharp on 2× screens
  - CLS < 0.05

### R2 · Rebuild the nav and hero · S
Match `exports/landing/Nav · BD.png` and `Hero · BD.png` (and the `· Intl` versions). Values at 1440 px:

**Nav**
- **Bar:** height 89 (padding 20 / 120), background `#EDEDEC`, no border.
- **Logo:** mark 28 px, then "mise" in Geist SemiBold 24, `#141414`, gap 8.
- **Links:** Geist Regular 15, `#6F6F6C`, gap 32.
- **Region pill:**
  - 38 tall, 1 px `#D4D4D2` border, radius full
  - text Geist Regular 14, `#6F6F6C`
  - globe 14 and chevron 12, both `#6F6F6C`
- **"Sign in":** Geist Regular 15, `#141414`.
- **"Start free":** ink pill `#141414`, white Geist Medium 16, padding 14 / 24.
- **Sticky:** same background. A 1 px `#E2E2DF` bottom border appears only after you scroll.

**Hero**
- **Section:** background `#EDEDEC`, padding 64 / 120 / 72 / 120. Two columns of 580 px with a 40 px gap, vertically centred.
- **Left column**, items 32 apart:
  - **Headline:** Geist Regular 56/62, tracking −1%, `#141414`, max-width 560. Line breaks as in the copy file, on desktop only.
  - **Lead:** Geist Regular 18/28, `#6F6F6C`, max-width 480 (`hero.lead`).
  - **Buttons**, gap 12:
    - primary: same ink pill as the nav
    - secondary: transparent, 1 px `#D4D4D2` border, `#141414` text, `zap` icon 16
  - **Trust line:** Geist Regular 14/22, `#8A8A87`, max-width 440 (`hero.trustLine`).
- **Right column:** only the image `lp-<region>-hero-phone`, centred.
- **Copy:** use `hero.lead`, `hero.trustLine` and `hero.visual`. The old `eyebrow`, `trustLabel` and `chips` are listed in `hero._deprecated`, kept only so the current build keeps working. Stop using them, then delete them and `_deprecated` from both copy files in this PR.
- **Remove all of these:**
  - the eyebrow pill
  - the four chips
  - the laptop
  - the bold partner strip
  - the "Product preview · rolling out in stages" caption
  - the dark background

**Responsive**
- **≥ 1024:** as above.
- **768–1023:** two columns; phone 260 wide; headline 48/54.
- **< 768:**
  - one column, padding 40 / 20 / 56
  - headline 40/46
  - phone 240 wide and centred, after the buttons; trust line last
  - nav becomes logo + "Start free" + a menu button that opens a light (`#EDEDEC`) full-screen sheet with links at 20/28 `#141414`

**Accept when:** side by side with `Hero · BD.png` at 1440, every element edge is within 8 px, and nothing has been added.

### R3 · Product images in the sections · M
- **Operations in detail:** each of the 12 blocks shows `detail.NN` at 680×500. The grey panel, the screen and the small callout chip are all *inside* the image, so don't add a CSS panel, chip, border or shadow around it. The text column stays as in Figma.
- **A day with Mise:**
  - 6 × `day.NN` at 179×388, with time and caption in HTML
  - on phones: a horizontal scroll-snap row, images 200 wide, gap 16, side padding 20, and the page itself never scrolls sideways
- **Businesses:** 4 × `businesses.NN` at 234×350, inside equal-height cards.
- **Accept when:**
  - all 23 images per region are in place (1 hero, 12 detail, 6 day, 4 businesses)
  - alt text comes from `landing-assets.json`
  - no screen is redrawn anywhere

### R4 · Match each section · M
For each `exports/landing/<Section> · BD.png` (and `· Intl`), compare at 1440 and fix type, spacing and colour:

- **Headlines:**
  - section headlines Geist Regular 40/46, −1%
  - CTA headline 48/55
  - one weight per line, everywhere
- **Section padding:** 120 / 120. The CTA is 120 / 80; the footer is 40 / 48.
- **Backgrounds**, exactly as in Figma:
  - `#EDEDEC`: Nav, Hero, Reads anything, The basics
  - `#FFFFFF`: Feature index, Agent controls, Checks built in, Operations in detail, Businesses, Comparison
  - `#141414`: Data capture, A day with Mise, CTA, Footer
- **On dark backgrounds:** text is white or `#A3A3A0`, never ember.
- **Effects:** remove both CSS gradients. Shadows use `--shadow-soft` only.
- **Deliverable:** `qa/report.html` (R7) with every section next to its reference.
- **Owner sign-off:** the owner signs off on the hero and three sections of their choice before R4 merges.
  - **Owner override, 15 Nov 2026:** the owner instructed “don't ask me for any sign off just continue.” Manual sign-off gates are waived; reference comparison, required checks, ordered merges and deployment still apply. Recorded in `handover/DECISIONS.md` and the R4 PR.

### R5 · Phone pass · M
- **At 360, 375, 390 and 414 px:** no horizontal overflow (`scrollWidth === innerWidth`), nothing clipped, tap targets ≥ 44 px.
- **Length budget:** `/bd/` ≤ 20,000 px tall at 390 (it's 36,400 now). To get there, below 768 px:
  - **Detail blocks:** show image, eyebrow, title and lead. Move the 3 steps and the "If something goes wrong" box into one native `<details>` titled "How it works", closed by default.
  - **Checks built in:** show 6 cards, then a `<details>` "Show all 12".
  - **The basics:** 2-column tiles.

### R6 · Setup page and small fixes · S
- **Setup page:** desktop and phone match `Setup · Download and install (desktop).png` and `Setup · On the shop phone (mobile web).png`.
  - headline "Install Mise on your devices"
  - all copy taken from Figma
  - the same light nav as the landing page
- **®:** remove it everywhere.
- **Open Graph images:** one per region, 1200×630, built from the new hero (`#EDEDEC`, headline left, `lp-<region>-hero-phone` right).

### R7 · Visual QA harness, so this can't happen again · S
- **`pnpm qa:visual`:**
  - Playwright captures `/bd/`, `/intl/` and `/setup/`, section by section (by section id), at 1440 and 390, into `qa/screens/`
  - it builds `qa/report.html`: each capture beside its Figma reference (`sectionReferences` in `landing-assets.json`), with a pixelmatch difference percentage (informational, not a CI failure)
- **Every PR that touches `apps/landing` or `apps/web`:** upload the report as a CI artifact, link it in the PR, and paste three key screenshots inline.
- **The app (M10+):** use the same harness against the `exports/screens/…` PNGs named in each milestone spec.

## 5 · Done when (the whole pass)

- [x] `pnpm check:exports` passes in CI. The Figma export workflow is installed.
- [x] No hand-drawn screen, device or browser markup; the CI grep guard is in place.
- [x] Nav and hero match `Nav/Hero · BD.png` and `Nav/Hero · Intl.png`. No pill, chips, laptop, dark hero or bold logo strip.
- [x] Every headline ≤ 56 px (hero) / 40 px (sections) / 48 px (CTA), Geist Regular, one weight per line. No gradients, no ®.
- [x] 23 images per region, sharp at 2×, served as AVIF/WebP with a PNG fallback, with alt text.
- [x] No horizontal overflow at 360–414 px. `/bd/` ≤ 20,000 px tall at 390.
- [x] Lighthouse on mobile: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95. CLS < 0.05.
- [x] `qa/report.html` produced and uploaded by R7 CI; the owner's sign-off waiver is recorded in the R4 PR and DECISIONS.
- [x] Phase R ticked in the roadmap and CHANGELOG updated. Release tag `v0.1.1` follows R7 merge and successful deployment.

## 6 · Rules carried into M10 and every later milestone

1. **List your reference files.** Before coding, open the PNGs from `exports/screens/…` for every frame the milestone spec names, and list them in the PR.
2. **Images are references only in the app.** The app is real UI, built with tokens and components. Take spacing, sizes and colours from the Figma frame (`get_design_context` when available).
3. **Every PR includes the visual QA report:** your screen at 390 and/or 1440 beside the export.
4. **Missing export? Ask.** If an export for a frame named in the spec is missing, run `--check` and ask the owner. Don't guess the design.
