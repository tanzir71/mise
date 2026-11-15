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

`pnpm build` produces `site/`. Set `BASE_PATH=/mise/` for GitHub Pages or `/` for a custom domain. Public configuration is listed in `.env.example`.

Production: https://tanzir71.github.io/mise/

The original requirements, exact regional copy and brand assets are preserved in `handover/`.
