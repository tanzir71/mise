# exports/

Pictures of the real design, exported from Figma, for Codex to build against and (on the landing page) to embed.

- **`INDEX.md`**: every file, its Figma node and its size.
- **`landing-assets.json`**: which `lp-*` image goes in which landing slot, with its display size and alt text.
- **`manifest.json`**: the same list in the format `scripts/export-figma.mjs` reads.

## Folders

| Folder | What | Scale | Used for |
|---|---|---|---|
| `landing/` | `lp-<region>-…` images: hero phone, 12 detail panels, 6 day phones, 4 business cards per region. | 2× | **Embedded** on the landing page. |
| `landing/` | `<Section> · BD.png`, `<Section> · Intl.png`: every landing section as a whole. | 1× | **Reference only**, for visual comparison. |
| `landing/` | `Setup · …`: the setup page (desktop 1×, phone 2×). | 1× / 2× | Reference for `/setup/`. |
| `screens/mobile/` | Phone app screens M01–M38, plus the parity board. | 2× | Reference for app milestones. |
| `screens/desktop/` | Desktop app screens (Today, Orders, Stock, Plan, Team, Guests, Live store, Kitchen, Storefront, POS, Settings…). | 1× | Reference for app milestones. |
| `screens/corner-shop/` | C00–C10 and the corner shop board. | 2× | Reference. |
| `screens/online-shop/` | S01–S05, SM01–SM04, storefront, POS. | 1× / 2× | Reference. |
| `screens/operator/` | Operator mode, connect an AI operator, agent console, templates. | 1× | Reference. |
| `system/` | Components sheet, brand, market packs. The 62 icons are SVG in `system/Mise icon/`. | 1× / SVG | Tokens and icons. |
| `flows/` | Capture and import behaviour boards. | 1× | Read with the phase specs. |
| `portfolio/` | Behance and Dribbble images. | — | Not used by the site. |
| `brand/` | Logo SVGs, favicon, PWA, extension and Android icons (already included). | — | Embedded. |

## How the owner exports (about 5 minutes, no token)

Every frame in the Figma file already has its export settings. For each page below:

1. Open the page in Figma.
2. Press **Ctrl + Shift + E** (Mac: **Cmd + Shift + E**). This opens **Export**, with every layer that has export settings on that page already listed.
3. Click **Export**.
4. Choose the folder in the table.

| Figma page | Export into |
|---|---|
| 08 · Landing pages | `handover/exports/landing/` |
| 04 · Mobile — owners & street vendors | `handover/exports/screens/mobile/` |
| 03 · Desktop — owners | `handover/exports/screens/desktop/` |
| 07 · Variation — Corner shop | `handover/exports/screens/corner-shop/` |
| 05 · Variation — Online shop | `handover/exports/screens/online-shop/` |
| 06 · Generalised core | `handover/exports/screens/operator/` |
| 01 · Brand & system | `handover/exports/system/` (Figma creates `Mise icon/` for the icons) |
| 02 · Import system | `handover/exports/flows/` |
| 09 · Portfolio | `handover/exports/portfolio/` |

Then commit the folder.

**Check that everything is there** (no token needed):

```
node handover/scripts/export-figma.mjs --check
```

## Or let a script do it (needs a Figma token)

This produces the same files with the same names:

```
FIGMA_TOKEN=<Figma personal access token> node handover/scripts/export-figma.mjs
```

- **Create a token:** Figma → Settings → Security → Personal access tokens, with read-only "File content".
- **In GitHub:** add it as the repo secret `FIGMA_TOKEN`, then run the **Figma export** workflow (`templates/github/workflows/figma-export.yml`). It commits the files for you.

## Rules for Codex

- **Landing and setup pages:** embed the `lp-*` images through Astro `<Picture>` (AVIF, WebP, PNG fallback).
  - Display each at its pixel size ÷ `exportScale`.
  - Never redraw a screen, phone, laptop or browser in HTML, CSS or SVG.
  - Never add a CSS frame, chip or shadow around these images: the panel, bezel and chip are already in the picture.
- **App:** these PNGs are the visual reference. Build real UI with tokens and components, and compare against the PNGs named in each milestone spec (see `docs/09-refinement-appendix.md` §6).
- **Missing file?** Run `--check`, write it in `handover/QUESTIONS.md` and ask the owner. Don't guess.
- **Fonts aren't exported.** Use the npm packages `geist` (Geist, Geist Mono) and `@fontsource/hind-siliguri`.
