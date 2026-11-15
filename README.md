# Mise

Every order, chat and payment, in one calm place.

Implementation follows the milestones in [the handover](handover/README.md). Phase 0 ships the static landing site, regional pages, setup guide and the app's coming-soon screen. Later app features follow the roadmap.

## Development

Use Node 20+ and pnpm 10.

```sh
pnpm install
pnpm dev:landing
pnpm dev:web
pnpm build
pnpm test
pnpm e2e
pnpm lint
pnpm typecheck
```

Use Node 20.19 or newer. Before the first browser test, run `pnpm exec playwright install chromium`. Run both dev commands in separate terminals: the landing page is on port 4321 and the app on port 5173. For a combined production preview, run `pnpm build` then `pnpm preview`.

`pnpm build` produces `site/`. Set `BASE_PATH=/mise/` for GitHub Pages or `/` for a custom domain. Public configuration is listed in `.env.example`.

Production: https://tanzir71.github.io/mise/

Regional pages: `/bd/` and `/intl/`. Device setup: `/setup/`. The app at `/app/` is a coming-soon screen in this release. No native device builds, accounts, backend or offline app features ship in Phase 0.

`pnpm screenshots` and `pnpm quality:lighthouse` run against a production preview at port 4321. Set `PREVIEW_URL` when previewing a project base such as `http://127.0.0.1:4321/mise/`. Quality evidence lives in `docs/quality/` and `docs/screenshots/`.

The original requirements, exact regional copy and brand assets are preserved in `handover/`.
