# 01 · Design system

Tokens live in `handover/tokens/tokens.json` and `tokens.css`. They were exported from the Figma variables "Mise / Color", the text styles `v2/*` and the effect styles `v2/*`. Copy `tokens.css` into `packages/ui` and map Tailwind to the CSS variables.

## Principles
- **Colour:** monochrome with one ember accent per view.
  - Primary buttons are ink (`--ink`) with white text.
  - Ember (`--accent`) is for one highlight only: a live dot, the current day, or a single promo.
- **Status colour only as a line or a word,** never a filled surface.
  - Use a 6 px dot + word ("● Urgent"), a 3 px left bar on a card, or a coloured outline.
  - Tinted backgrounds (`*-50`) are allowed only for tiny badges in dense tables.
- **Equal-height cards** in a row: the tallest card sets the height, the others stretch. Footers and actions are pinned to the bottom.
- **Spacing:** 8pt grid. Control heights are 36 px (compact) and 44 px (touch). Card radius is 14–16 px on the app, 24 px on the landing page. Pills use 999 px.
- **Shadows:** `--shadow-raised` for cards when needed, `--shadow-soft` for floating chips and product shots. Avoid the heavier `overlay` shadow on marketing pages.
- **Accessibility:**
  - Meet WCAG 2.2 AA contrast, with a visible focus ring (2 px ink + 2 px white offset).
  - Hit targets are at least 44 px on touch.
  - Respect `prefers-reduced-motion`.

## Type
| Token | Font | Size / line height | Use |
|---|---|---|---|
| display | Geist SemiBold | 40/48, −2.5% | Page hero in the app |
| number-xl / l / m | Geist SemiBold | 48/52, 32/40, 24/32 | KPIs, calculator display |
| title | Geist SemiBold | 24/32 | Screen titles |
| heading | Geist SemiBold | 16/24 | Card titles |
| subheading | Geist Medium | 14/20 | |
| body / body-strong | Geist Regular / Medium | 14/20 | |
| small / small-strong | Geist | 12/16 | Lists, meta |
| caption | Geist | 11/16 | Helper text |
| bangla-* | Hind Siliguri | 14/24, 12/20, 20/32 | Bengali text |

Landing page only: hero headline 68–72 px, section headlines 56 px, sub-copy 20/29. All use Geist SemiBold at −2.5% tracking.

**Bengali:**
- Set `font-family: Geist, "Hind Siliguri", system-ui, sans-serif;` on all text, so Bengali runs (including ৳) fall back to Hind Siliguri automatically.
- Load Hind Siliguri 400/500/600 from a self-hosted copy.

## Layout
- **App, desktop:**
  - left sidebar 240 px: outlet switcher, nav (Today, Orders, Stock, Plan, Team, Guests, Capture), a capture health card at the bottom
  - content max width 1200 px
  - a top bar inside each page (title, segmented control, actions)
- **App, phone (390 wide reference):**
  - status bar, then a header (outlet switcher, agent presence pill, bell, title)
  - scrollable content
  - bottom nav: Today · Orders · Inbox · Stock · More (corner shop: Today · Counter · Orders · Khata · More)
  - detail and create screens replace the bottom nav with an action bar
- **Breakpoints:** 360, 390, 768, 1024, 1440.

## Core components (build in `packages/ui`)
- **Button:**
  - kinds: primary (ink), secondary (white + border), ghost
  - sizes: M (44) and S (36)
  - optional leading icon
- **Chip / pill:** filter chip (selected = ink fill), outline chip, tag.
- **Segmented control:** grey track with a white selected segment.
- **Status word:** dot + word, with tones positive, warning, negative, info, neutral.
- **Card:** white, 1 px border `--border`, radius 16, padding 16; optional left status bar.
- **List row:** 36 px icon tile or avatar, title + meta, right slot (value, status or button), chevron.
- **Stepper:** − value +.
- **Toggle:** 36×20.
- **Radio.**
- **Text field:** label above, 44 px, focus border ink 2 px.
- **Sheet:** bottom sheet on phones, side drawer on desktop.
- **KPI tile:** label, number, sub-text.
- **Calculator keypad:** 4×5 keys, 50–58 px tall. Operators sit on `--fill`, equals on ink, digits on white with a border.
- **Bottom nav, sidebar, agent presence pill** (dot + "Claude on"), **toast, empty state.**

## Icons
- 1.5 px stroke, 24 grid, monochrome, coloured via `currentColor`.
- The Figma names are listed in `07-figma-map.md`. Use Lucide equivalents with the same names where possible:
  - home, receipt, package, calendar, users, heart, wallet, capture/scan, chart, qr, store, camera
  - share, clipboard, message, bell, globe, check, x, minus, plus, search, sparkles
  - arrows, chevrons, phone, pin, clock, shield, refresh, link, mic, zap, copy, send, external, lock
  - filter, download, more, alert, check-circle, wifi-off, eye, pause, utensils, history, database, puzzle, layers

## Writing style
- Plain, short, friendly. Address the user as "you".
- Buttons are verbs: "Send to kitchen", "Copy message", "I sent it".
- Never blame the user. Errors say what happened and what to do next.
- Bangla in customer-facing messages is natural, not literal. Keep English product names (bKash, WhatsApp) in Latin script.
