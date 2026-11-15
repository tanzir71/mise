# 06 · Release process

## Branches and PRs
- `main` is always deployable and is what GitHub Pages serves.
- Branch per milestone: `m12-counter-calculator`. Split big milestones into PRs: `m14a-order-entry`, `m14b-queue`.
- PR title: `M12: Counter calculator (cash in one tap)`.
- The PR body follows `.github/pull_request_template.md`: what shipped, screenshots at 390 and 1440, the Figma frames matched, flags, a test plan, and the deployed URL after merge.
- Squash-merge. A conventional commit summary is fine (`feat(counter): …`).

## Versions and tags
- SemVer while pre-1.0: each phase bumps the minor version (`v0.1.0` landing … `v0.4.0` = v1 with backend).
- Patch tags (`v0.2.3`) for fixes or individual milestones if useful.
- At each phase end, create a GitHub Release whose notes are the CHANGELOG section and 3–6 screenshots.

## Feature flags
- `packages/core/flags.ts` exports typed flags with defaults.
- Override at runtime via `localStorage['mise.flags']` (JSON) or `?flags=a,b` for testing.
- Anything user-facing and unfinished defaults to **off**. Remove the flag within two milestones of shipping the feature to everyone.

## Environments
| Env | Where | Notes |
|---|---|---|
| Preview | PR artifact (download) | Built on every PR |
| Production | GitHub Pages from `main` | `BASE_PATH=/<repo>/` until a custom domain is set |
| Backend (Phase 3+) | Supabase project `mise-prod` (+ `mise-dev`) | Keys via GitHub Actions secrets → build env (public anon key only) |

## Data migrations
- **Dexie:** bump the version with an upgrade function for every schema change, and add a test with fixture data from the previous version.
- **Supabase:** SQL migrations in `supabase/migrations`, applied by CI on merge (Phase 3+). RLS policies are tested with pgTAP or SQL tests.

## QA checklist per release
- [ ] Fresh install and upgrade from the previous version (IndexedDB)
- [ ] Offline: create a sale, order and khata entry with the network off, reload, and confirm the data persists
- [ ] Phone layouts at 360 and 390; desktop at 1440
- [ ] Bangla text renders with Hind Siliguri, including ৳
- [ ] Deep links: `wa.me` opens; the Copy fallback works; "I sent it" records the action
- [ ] Export: CSV opens in Excel and Google Sheets; the JSON backup restores into a fresh profile
- [ ] Lighthouse targets met on landing; no console errors
