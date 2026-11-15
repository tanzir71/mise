# Prompt 05 · Refinement pass (paste into Codex before M10)

```
Before any new milestone, do the refinement pass in handover/docs/09-refinement-appendix.md (Phase R in handover/docs/03-roadmap.md). The owner reviewed the live site: the hero is busy and every product screen was hand-drawn in HTML instead of using the Figma exports. Figma has been updated. The landing nav and hero are now calm and light, section headlines are 40 px Regular, and every screen and landing image has an export in handover/exports/.

Rules for this pass:
- Re-read AGENTS.md, then 09-refinement-appendix.md, 01-design-system.md ("Global visual rules" and the landing type values) and 02-landing-spec.md. They changed on 15 Nov 2026.
- First run: node handover/scripts/export-figma.mjs --check --only=landing
  If anything is missing, stop. Write it in handover/QUESTIONS.md and tell me which files are missing. Do not redraw, crop or fake images.
- Every app screen, phone, laptop and product panel on the landing and setup pages is an image from handover/exports/landing/lp-*.png, mapped in handover/exports/landing-assets.json. Delete all hand-drawn mockup markup and CSS, and add the CI guard.
- Match the Figma references in handover/exports/landing/ ("<Section> · BD.png" and "<Section> · Intl.png") at 1440 and 390. Use copy only from handover/copy/*.json.
- Work in order: R0, R1, R2, R3, R4, R5, R6, R7. One PR each, deployed to GitHub Pages after each merge. Each PR description includes the live URL, the qa/report.html artifact link (from R7 on; before that, paste screenshots), and a list of the reference files you matched.
- Stop after R2 so I can check the hero before you continue.

When Phase R is ticked and tagged v0.1.1, continue with prompts/02-next-milestone.md (M10). From then on, every milestone follows §6 of the appendix: compare against the exports/screens/… PNGs named in its spec and attach the visual QA report.
```
