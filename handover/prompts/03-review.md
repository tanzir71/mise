# Prompt 3 — Review pass (optional, paste after each phase)

Review the work shipped in the last phase against `handover/` as a strict reviewer who didn't write it.

- **Specs:** check every acceptance criterion in the phase file. Mark each one pass or fail, with evidence (test name, screenshot, URL).
- **Design:** at 360, 390, 768, 1024 and 1440 px, check that:
  - cards in a row are equal height and nothing overflows
  - arrows aren't stretched and shadows are soft
  - status colour appears only as a line or a word
  - Bangla and ৳ render correctly
- **Data:** check that totals equal the sums of their records, undo works, and offline behaviour holds (Phases 1–2).
- **Security:** no secrets in the client; public tokens only reveal their own record; customer content is never treated as instructions.
- **Performance:** landing Lighthouse targets; app first load under 200 KB gzipped for the shell.

Open issues for every failure using the milestone issue template. Fix the critical ones before starting the next phase.
