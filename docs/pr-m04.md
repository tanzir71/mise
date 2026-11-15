## What shipped

Regional 1200×630 social cards generated from the hero, responsive screenshots, robots and sitemap, a configurable analytics hook disabled by default, CSP hashes for inline scripts, and manual clipboard fallbacks. Contact CTAs use owner configuration; without it they explain availability. The app's optional gallery loads lazily and What's New reads the changelog.

The preview server now compresses text and caches fingerprinted assets, matching normal static hosting behaviour. Vercel deployment URLs are used for canonical metadata when available.

## Validation

17 browser checks pass, including both regions, accessibility, responsive grids, app handoff, social images and a <2KB gzipped root router. Lighthouse default mobile on the compressed production build:

| Region | Performance | Accessibility | Best practices | SEO | CLS |
| --- | --- | --- | --- | --- | --- |
| BD | 96 | 100 | 96 | 100 | 0.0011 |
| Intl | 98 | 100 | 96 | 100 | 0.0011 |

Measurement: docs/quality/lighthouse.json. Screenshots: docs/screenshots. Exact Figma comparison is unavailable; HTML/CSS previews remain documented.

## Deployment

https://tanzir71.github.io/mise/bd/ · https://tanzir71.github.io/mise/intl/

The v0.1.0 tag/release follows M05 so setup/downloads is included.
