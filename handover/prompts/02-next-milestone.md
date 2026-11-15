# Prompt 2 — Continue with the next milestone (paste into Codex each time)

Continue building Mise.

1. Open `handover/docs/03-roadmap.md` and find the **first unchecked milestone**. Read its spec in `handover/docs/phases/`, and re-read `AGENTS.md` if this is a new session.
2. Check its dependencies: every milestone it relies on must be checked. If one isn't, do that one first.
3. Implement the milestone on its own branch, in one or more small PRs (each under about 800 changed lines).
   - Put anything user-facing that isn't finished behind a flag in `packages/core/flags.ts`, default off.
   - Phases 1–2 must work fully offline on one device, with no backend.
   - Use the `<HandOff>` pattern (deep link + Copy + "I sent it") for every outbound message.
4. Meet the acceptance criteria and the definition of done in `AGENTS.md`. Match the Figma frames named in the spec at 390 and 1440 px.
5. Merge when CI is green. Confirm the Pages deploy. Update `CHANGELOG.md` and tick the roadmap.
6. At the end of a phase:
   - tag the version (`v0.2.0` after Phase 1, `v0.3.0` after Phase 2, …)
   - publish a GitHub Release
   - if the phase produced device builds, run the artifacts workflow so the unpacked extension zip and the debug-signed APK land in `downloads/` and show up on `/setup/`
7. Reply with:
   - what shipped
   - the live URL(s)
   - screenshots
   - new entries in `QUESTIONS.md` / `DECISIONS.md`
   - the next milestone you'll take

If something in the spec turns out to be impossible or much harder than expected, propose the smallest working alternative in `DECISIONS.md`, implement that, and move the remainder to a later milestone in the roadmap.
