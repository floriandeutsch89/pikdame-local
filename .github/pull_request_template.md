## What and why

<!-- One or two sentences: what changes for players (or for the repo), and why. -->

## Changes

-

## Screenshots

<!-- Required for any UI change. Before = main, after = this branch.
     Layouts: phone portrait (393×852 or 402×874), phone landscape (874×402),
     desktop (≥1100 px wide). Delete this section for non-UI changes. -->

| | Before | After |
|---|---|---|
| Portrait | | |
| Landscape | | |
| Desktop | | |

## Checklist

- [ ] `git log --oneline origin/main..HEAD` shows only this PR's commits
- [ ] `npm test` passes
- [ ] SemVer bump in `package.json` (+ `package-lock.json`) and a CHANGELOG section (headings English, content German)
- [ ] New visible text has i18n entries (`I18N_STATIC` / `L(de, en)` / `I18N_SERVER_PATTERNS`)
- [ ] UI checked in the browser in all three layouts, not only via tests
- [ ] No new npm dependency (or explicitly approved)
- [ ] Compose changes applied to all three files under `docker/` (or n/a)
- [ ] Snapshot changes: transient fields skipped in `serialize()` and re-created in `deserialize()` (or n/a)
- [ ] Engine/bot changes: E2E bot games on all 4 difficulties; win-rate claims backed by `scripts/sim-bots.js` batches (or n/a)
