# Decisions

- 2026-11-15: Use the restaurant workspace as the repository root, with the supplied package copied to `handover/`. Exclude the duplicate `Claude outputs/` source from Git.
- 2026-11-15: Begin with the kickoff scope, M00–M05, before adding local app or backend features. Keep the app placeholder honest about availability.
- 2026-11-15: Figma MCP returned `Unknown tool` for design context. No screen exports or FIGMA_TOKEN are available. Use the HTML/CSS previews explicitly permitted by M02, label them as product previews, and retain a visual-fidelity follow-up.
- 2026-11-15: Do not choose a third-party geolocation service by default. Support a configurable endpoint; otherwise use timezone/language. This avoids a location request on an unconfigured installation.
- 2026-11-15: Contact and demo URLs are optional. Without owner-provided URLs, CTAs open a clear availability notice with a setup link, rather than an invented contact number.
