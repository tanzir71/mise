# Decisions

- 2026-11-15: Use the restaurant workspace as the repository root, with the supplied package copied to `handover/`. Exclude the duplicate `Claude outputs/` source from Git.
- 2026-11-15: Begin with the kickoff scope, M00–M05, before adding local app or backend features. Keep the app placeholder honest about availability.
- 2026-11-15: Figma MCP returned `Unknown tool` for design context. No screen exports or FIGMA_TOKEN are available. Use the HTML/CSS previews explicitly permitted by M02, label them as product previews, and retain a visual-fidelity follow-up.
- 2026-11-15: Do not choose a third-party geolocation service by default. Support a configurable endpoint; otherwise use timezone/language. This avoids a location request on an unconfigured installation.
- 2026-11-15: Contact and demo URLs are optional. Without owner-provided URLs, CTAs open a clear availability notice with a setup link, rather than an invented contact number.
- 2026-11-15: The copy files contain twelve detailed workflows, despite the section summary saying ten. Render all twelve from the copy to preserve its content and anchors.
- 2026-11-15: Native artifacts remain absent in Phase 0. The setup guide shows coming-soon states and the artifact workflow no-ops until later projects exist. Test fixtures never become production downloads.
- 2026-11-15: Verify portable builds under both `/` and `/mise/`. Vercel hosting is an optional owner flow; this task publishes only to the authorized GitHub Pages destination. PWA/offline verification belongs to M18, and the self-hosting prompt now says so.
- 2026-11-15: A local compression-enabled static preview represents production hosting for Lighthouse. No runtime framework or backend is introduced.
