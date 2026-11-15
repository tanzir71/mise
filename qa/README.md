# Visual QA

Run `pnpm build`, then `pnpm qa:visual`. The command starts a production preview if one is not running. Set `BASE_PATH=/mise/` for a Pages build or `PREVIEW_URL` to use an existing preview at its complete base URL. A supplied preview URL must end in `/`.

Open `qa/report.html`. It contains 64 comparisons: each regional section at 1440 and 390px, plus the complete desktop setup page, its six main regions and the focused phone guide. Filter by page/viewport, open images or switch to actual pixels. Captures are in `qa/screens/`; reference views and difference images travel with the report. Generated files are ignored by Git. CI uploads them as `visual-qa` and links the artifact in the run summary.

References come from `sectionReferences` in `handover/exports/landing-assets.json`. Desktop setup has one full-frame export, so its individual comparisons use explicitly listed reference regions in `qa/configs/landing.json`. The full frame is included too. Phone landing sections have desktop references; their responsive reflow is intentionally different. The setup phone reference includes browser/OS UI supplied by the real device, not by the webpage.

Pixelmatch differences are informational. Reference views keep their aspect ratio and scale to the implementation capture's width. Both images are padded white to the taller height; extra content is counted rather than cropped away. The report shows original/reference/implementation dimensions and any reference region. Threshold is 0.1 and antialiasing is excluded. Missing references, unavailable pages and page overflow fail the command. A low percentage alone does not establish a visual match.

For every UI PR, link its Actions artifact and commit three key captures under `docs/screenshots/` for inline PR evidence. Keep reference exports unchanged.

## App milestones

Use the same runner with a milestone config:

```
pnpm qa:visual qa/configs/m10.json
```

A config has `title`, `widths`, and `pages`. Each page has a unique `id`, a base-relative `path`, and `sections`. Each section has an `id`, CSS `selector`, `reference` relative to `handover/exports`, optional `widths`, and optional `note`. References to app screens therefore use `screens/...png` directly, including 2× exports (the report normalises width without stretching). The default configuration's shared `sections` and `referenceGroup` are conveniences for landing pages.

Each page can define `actions` before capture. Supported types are `click`, `fill`, `select`, `press` and `wait`; all require `selector`, with `value` for input/key actions or `state` for waits. This supports real onboarding and navigation instead of a separate mockup route. A new browser context for each page/width makes first-run states repeatable. With no argument, the runner discovers every JSON config under `qa/configs/` and includes them in one report, so committed app configs automatically join CI.

```
{
  "title": "M10 app shell",
  "widths": [390, 1440],
  "pages": [{
    "id": "onboarding", "path": "app/",
    "sections": [{
      "id": "first-run", "selector": "#root",
      "reference": "screens/mobile/M33 · Owner — Getting started (onboarding on a phone).png"
    }]
  }]
}
```

Implementation references: [Pixelmatch API](https://github.com/mapbox/pixelmatch#api), [PNGJS](https://github.com/pngjs/pngjs), and the locally installed Sharp API/types.
