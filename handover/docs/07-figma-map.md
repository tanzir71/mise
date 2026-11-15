# 07 · Figma map

File: https://www.figma.com/design/FVXWo2wVq4nPS3kdsR4TUv/Tools

Link pattern: `https://www.figma.com/design/FVXWo2wVq4nPS3kdsR4TUv/Tools?node-id=<id with - instead of :>`

Every frame below has export settings in Figma. The PNGs live in `handover/exports/` (`screens/mobile`, `screens/desktop`, `screens/corner-shop`, `screens/online-shop`, `screens/operator`, `landing`). `handover/exports/INDEX.md` maps file names to node IDs. If the agent has the Figma MCP server, also use `get_design_context` / `get_screenshot` on these node IDs.

On 15 Nov 2026 a few frame names lost `:` `?` `/` so they work as file names (e.g. "Desktop 09 · Mise — Orders · live queue"). Node IDs did not change.

## Landing (page "08 · Landing pages")
| Frame | Node |
|---|---|
| Landing · Bangladesh | `113:3` |
| Landing · International | `120:2353` |
| Nav / Hero · Bangladesh (calm hero, 15 Nov 2026) | `113:4` / `116:927` |
| Nav / Hero · International | `120:2354` / `120:2371` |
| Landing images to embed (`lp-*`) | see `handover/exports/landing-assets.json` (node IDs included) |
| Setup · Download and install (desktop), incl. "Run your own copy on Vercel" | `124:4616` |
| Setup · On the shop phone | `124:4868` |

## Design system (page "01 · Brand & system")
- Icons: components `Mise icon/*` (e.g. home `29:11`, receipt `29:18`, package `29:25` … database `29:399`)
- Buttons `29:445` · Status `29:473` · Tag `29:492` · Browser chrome `29:605` · Sidebar `35:154` · Mark (logo) `30:476`

## Phase 1–2 (one device, links)
| Feature | Phone | Desktop |
|---|---|---|
| App shell / Today | M12 `102:82` | Today `38:474` |
| Orders queue | M13 `102:288` | D09 `53:1251` |
| Order detail + tracking link | M14 `102:448` | — |
| New order (manual) | M15 `102:593` | POS `89:3340` |
| Stock + quick update | M16 `103:213` | Stock `39:476` |
| Night count | M10 `77:3291` | Count mode `77:2732` |
| Business data | M28 `106:787` | `74:2354` |
| Exports | M29 `106:921` | `82:3097` |
| More hub | M27 `106:564` | — |
| Corner shop · Today | C00 `110:5` | — |
| Corner shop · Counter calculator | C01 `110:162` | — |
| Corner shop · Put on khata | C02 `110:301` | — |
| Corner shop · Receipt QR | C03 `110:384` | — |
| Corner shop · Khata list | C04 `111:101` | — |
| Corner shop · Customer profile | C05 `111:238` | — |
| Corner shop · Orders (link/WhatsApp/calls/photos) | C06 `111:366` | — |
| Corner shop · Price an order | C07 `111:519` | — |
| Customer · Shop link (type/say/snap) | C08 `112:196` | — |
| Customer · Priced order + swap | C09 `112:284` | — |
| Customer · My khata | C10 `112:375` | — |
| Corner shop board (flows, fallbacks) | — | `112:447` |
| Storefront | M35 `107:1073` | `88:3319`, settings `90:3511` |
| QR menu (guest) | M04 `58:34` | — |
| Share to Mise | M25 `104:950` | — |

## Phase 3 (backend, multi-device)
| Feature | Phone | Desktop |
|---|---|---|
| Kitchen screen | M36 `107:1222` | Kitchen PWA `65:1843`, setup `66:1846` |
| Guest tracking | M01 `56:1496`, M02 `56:1601`, M03 `56:1704` | — |
| Team / on duty | M18 `103:644`, member edit M19 `103:793` | Team `60:1558`, Members `72:2105` |
| Staff "My shift" link | M07 `59:59` | — |
| Shift board (order phone) | M05 `58:118` | — |
| Inbox / questions | M20 `103:900`, M06 `58:201` | — |
| Live store | M37 `107:1280` | "D · Live store" `109:3694` |
| All outlets | M38 `107:1508` | "D · All outlets" (next to Live store) |
| Start service | M30 `106:1011`, order phone check M11 `78:3328` | `78:2928` |
| Onboarding | M33 `107:794` | `81:3054` |

## Phase 4–6
| Feature | Node |
|---|---|
| Capture (sources/rules) | M24 `104:773`, desktop `51:1042` |
| Snap invoice | M26 `106:484`, desktop invoice capture `48:834` |
| Teach a website | desktop `49:940` |
| Staff group chat | M23 `104:601`, desktop `70:1918` |
| Operator mode | M31 `106:1153`, desktop `93:2` |
| Connect an AI operator | M32 `107:650`, desktop `98:262` |
| Agent integration board | `99:446` · Agent console `99:577` |
| Plan | M17 `103:400`, desktop `39:949` |
| Performance | M34 `107:942`, desktop `75:2534` |
| Guests + win-back | M21 `104:358`, M22 `104:507`, desktop `64:1671` |
| Online shop (phone) | SM01 `108:1068`, SM02 `108:1193`, SM03 `108:1315`, SM04 `108:1453` |
| Online shop (desktop) | page "05 · Variation — Online shop": S01 `84:5`, S02 `85:270`, S03 `86:455` |
| Parity matrix | `108:2374` |
| Import system boards | `31:2`, `43:42`, `45:127`, `47:185`, `57:273`, `69:267` |
