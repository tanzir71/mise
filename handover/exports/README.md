# exports/

Visual exports from Figma for Codex to build against.

## Already included
- `brand/mise-mark.svg`, `mise-mark-mono-white.svg`, `mise-mark-maskable.svg`: the logo
- `brand/icons/`:
  - `favicon.ico` (16/32/48)
  - `mise-16…512.png`
  - `apple-touch-icon-180.png`
  - maskable PWA icons 192 and 512
- `brand/extension-icons/icon-16/32/48/128.png`: Chrome extension icons
- `brand/android-adaptive-foreground-432.png`: Android adaptive icon foreground (pair it with a `#141414` background)

## Downloaded by `scripts/export-figma.mjs` (listed in `manifest.json`)
| Folder | What | Scale |
|---|---|---|
| `phone/` | Every phone screen: manager app M01–M38, corner shop C00–C10, online shop SM01–SM04, setup | 2× |
| `desktop/` | Every desktop screen: Today, Orders, Kitchen, Stock, Plan, Team, Guests, Live store, All outlets, Operator, Connect agent, Agent console, Storefront, POS, Setup, … | 2× |
| `landing/bd/`, `landing/intl/` | Each landing section separately, plus the hero visual | 2× |
| `landing/full-page-*.png` | The whole landing page per region, for reference | 1× |
| `boards/` | Flow and system boards: agent integration, corner shop, parity matrix, capture, no order left behind | 1× |
| `icons/` | All 62 Mise icons as SVG (monochrome stroke icons; recolour with `currentColor`) | SVG |

Run it once:
```
FIGMA_TOKEN=<your Figma personal access token> node handover/scripts/export-figma.mjs
```
This takes about 2–4 minutes and writes `exports/INDEX.md`, which links each file back to its Figma frame. Re-running it skips files that already exist; add `--force` to refresh them.

## How Codex should use them
- **Landing:** the files in `phone/` and `desktop/` are the product screenshots. Convert them to WebP at build time and crop as the landing spec describes.
- **App:** match each milestone to the frames named in its phase spec.
- **Fonts:** not exported. Install them from npm: `geist` (Geist and Geist Mono) and `@fontsource/hind-siliguri`. Both are open-source (OFL).
