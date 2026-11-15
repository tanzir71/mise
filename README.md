# Mise

Every order, chat and payment, in one calm place.

Implementation follows the milestones in [the handover](handover/README.md). The landing site and refinement pass are live. The local app includes setup and business settings, catalogue editing/search/bulk paste, a cash-first counter with receipts, customer khata, manual orders and stock counts. Stock supports reviewed quick updates, night-count variances and supplier drafts. These tools work on one device without an account.

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

Regional pages: `/bd/` and `/intl/`. Device setup: `/setup/`. The app at `/app/` works locally after its first load, with data stored on this device. Native builds, accounts and backend sync arrive in later phases. Delivery evidence: [setup](docs/m10-delivery.md), [catalogue](docs/m11-delivery.md), [counter](docs/m12-delivery.md), [khata](docs/m13-delivery.md), [orders](docs/m14-delivery.md) and [stock](docs/m15-delivery.md).

`pnpm screenshots` and `pnpm quality:lighthouse` run against a production preview at port 4321. Set `PREVIEW_URL` when previewing a project base such as `http://127.0.0.1:4321/mise/`. Quality evidence lives in `docs/quality/` and `docs/screenshots/`.

The original requirements, exact regional copy and brand assets are preserved in `handover/`.
