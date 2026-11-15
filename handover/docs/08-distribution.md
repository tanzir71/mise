# 08 · Distribution of device builds (unsigned, from the repo)

The owner wants every app deliverable to be downloadable straight from the GitHub repo and installed in developer mode. Nothing goes to the Play Store or the Chrome Web Store.

**Figma:**
- Setup page, desktop: "Setup · Download and install (desktop)" on page 08 (node `124:4616`)
- Setup page, phone: `124:4868`

## Deliverables
| Deliverable | File | Signing | Install method |
|---|---|---|---|
| Web app (PWA) | — (served at `/app/`) | n/a | Browser "Install app" |
| Kitchen screen | — (same PWA, `/app/screen/kitchen`) | n/a | Browser install on tablet |
| Chrome extension | `downloads/<ver>/mise-extension-<ver>.zip` | Unsigned (unpacked) | `chrome://extensions` › Developer mode › Load unpacked |
| Android order phone | `downloads/<ver>/mise-order-phone-<ver>.apk` | **Debug key only** (see below) | **Allow from unknown sources**, then install; or `adb install -r` |

**Why debug-signed, not "unsigned":**
- Android will not install an APK with no signature at all.
- Sign every build with the same debug keystore, `apps/order-phone/debug.keystore`. It is committed and not secret, with the standard debug alias and password documented in `apps/order-phone/README.md`.
- No release key and no Play signing. Because the key never changes, users can install updates over the old app without losing data.

## Repo layout
```
downloads/
├─ manifest.json            ← machine-readable list (read by the Setup page and the app's update check)
├─ latest/                  ← copies of the newest files (stable URLs)
│  ├─ mise-extension.zip
│  └─ mise-order-phone.apk
└─ 0.5.0/
   ├─ mise-extension-0.5.0.zip
   ├─ mise-order-phone-0.5.0.apk
   └─ SHA256SUMS.txt
```
`manifest.json`:
```json
{
  "updatedAt": "2026-11-15T08:00:00Z",
  "items": [
    {"id":"extension","name":"Chrome extension","version":"0.5.0","file":"0.5.0/mise-extension-0.5.0.zip","latest":"latest/mise-extension.zip","bytes":421888,"sha256":"…","minApp":"0.5.0"},
    {"id":"order-phone","name":"Android order phone","version":"0.5.0","file":"0.5.0/mise-order-phone-0.5.0.apk","latest":"latest/mise-order-phone.apk","bytes":8808038,"sha256":"…","minAndroid":"8.0","minApp":"0.5.0"}
  ]
}
```

Limits:
- Keep each binary under 50 MB (GitHub's warning size).
- Keep only the last 5 versions in `downloads/`. Older ones remain in git history and on GitHub Releases.

## Build and publish (CI)
- The workflow `templates/.github/workflows/artifacts.yml` runs on tags `ext-v*`, `phone-v*` and `v*`. It:
  1. builds the extension zip (`pnpm --filter extension build && zip`)
  2. builds the APK (`./gradlew assembleDebug` with the committed debug keystore)
  3. computes SHA-256 checksums and updates `downloads/manifest.json`, `downloads/latest/*` and `downloads/<ver>/*`
  4. commits to `main` as `mise-bot` with `[skip ci]` in the message, then triggers the Pages workflow (or the Pages build copies `downloads/` into `site/downloads/`)
  5. attaches the same files to the GitHub Release for that tag
- **The Pages build** copies `downloads/` → `site/downloads/`, so files are reachable at `https://<user>.github.io/<repo>/downloads/latest/mise-order-phone.apk`.

## Setup page (`/setup/` on the landing site, plus "Settings › Devices" in the app)
- Ship it in Phase 0 as M05, with the cards showing "Coming in a later version" until `manifest.json` lists the item.
- It reads `downloads/manifest.json` at runtime and shows each item's version, size, date, Download button, "View in repo" link and SHA-256.
- Step-by-step instructions as designed:
  - **Extension:** download → unzip → open `chrome://extensions` → Developer mode → Load unpacked (the folder with `manifest.json`) → pin → pair with the 6-digit code
  - **Android:**
    1. Download on the phone.
    2. **Allow from unknown sources.** On Android 8+, when the install is blocked, tap Settings → turn on "Allow from this source" for the browser (also at Settings › Apps › Special app access › Install unknown apps). On Android 7 and older, use Settings › Security › Unknown sources. Note that names vary by brand.
    3. Go back, open the file and tap Install. Play Protect may warn; tap More details › Install anyway.
    4. Grant notification access for the chosen apps.
    5. Turn battery optimisation off.
    6. Pair by QR.
  - Cable alternative: `adb install -r …`
  - Checksum commands: macOS/Linux `shasum -a 256`, Windows `certutil -hashfile … SHA256`
  - Updates and troubleshooting
- **App-side update check:** the extension and order phone compare their version with `manifest.json` daily and show "New version available" with a link to the Setup page. They do not self-update silently.

## Pairing devices
- Extension: a 6-digit code from Mise › Settings › Devices (expires in 10 minutes), exchanged for a device token.
- Android: a QR containing a one-time pairing token. The device token is stored in Android Keystore.
- Devices can be revoked from Settings › Devices.

## Self-hosting the web app on the owner's own Vercel (optional)
Owners can run their own copy of the web app (landing page + app) on their Vercel account, deployed by their AI agent.

**Figma:** the "Run your own copy on Vercel" section on the setup page (`124:4616`, anchor `#vercel`), plus a pointer card on the phone setup page (`124:4868`).

**What Codex must ship (in M05, with M00's build):**
- **`vercel.json` at the repo root:** copy it from `handover/templates/vercel.json`. It covers the install and build commands with `BASE_PATH=/`, output `site/`, SPA rewrite for `/app/*`, service-worker headers, and `downloads/` copied into the site.
- **A build that works with any base path:**
  - GitHub Pages: `/<repo>/`
  - Vercel and custom domains: `/`
  - never hard-code the repo name
- **`prompts/04-deploy-own-vercel.md` copied to `docs/deploy-own-vercel.md`** in the repo, and linked from `/setup/#vercel`. The setup page shows a "Copy prompt for your agent" button with the short version of the prompt.
- **A "Deploy to Vercel" button** for the manual path:
  `https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2F<owner>%2F<repo>&project-name=mise&repository-name=mise`
  - Add `&env=PUBLIC_SUPABASE_URL,PUBLIC_SUPABASE_ANON_KEY` once Phase 3 ships.
  - Verify the current parameter names against Vercel's docs when implementing.
- **A "Pair to a self-hosted copy" option** on the extension and Android pairing screens: enter the base URL, then the 6-digit code or QR, so devices talk to the owner's deployment.
- **From Phase 3:** a self-hosting checklist in the docs: create your own Supabase project → run `supabase db push` → set the two public env vars in Vercel.

**Accept**
- [ ] `vercel deploy --prod` from a clean fork serves `/`, `/app/` (deep links reload correctly) and `/setup/`.
- [ ] The PWA works offline on the Vercel URL.
- [ ] The setup page's "Copy prompt" copies the agent prompt; the Deploy button opens Vercel's clone flow for the right repo.
