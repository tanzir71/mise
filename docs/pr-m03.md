## What shipped

International landing copy renders through the same components as Bangladesh. The root router honours query override, saved choice, an optional country lookup (800ms abort), timezone/language, then international. Region switches remember the choice. Campaign parameters and hashes survive routing. Both regional pages have canonical and hreflang metadata; the root has usable links with JavaScript off.

No third-party geo provider is configured by default. PUBLIC_GEO_URL accepts a provider returning a two-letter country in country_code, countryCode or country.

## Validation

Lint, type checks, six unit checks and fourteen browser checks pass. Tests cover query/saved precedence, Dhaka and London contexts, manual override persistence, no-JavaScript navigation, exact regional copy and axe WCAG AA on both pages. The router is below 2KB gzipped.

## Deployment

https://tanzir71.github.io/mise/ · https://tanzir71.github.io/mise/bd/ · https://tanzir71.github.io/mise/intl/
