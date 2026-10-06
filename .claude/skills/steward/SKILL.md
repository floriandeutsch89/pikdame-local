---
name: steward
description: Repo conventions for shipping and driving a Pik Dame pull request to green - branch, version bump, CHANGELOG, data cleanup, push checks, screenshots, red CI (including the npm audit gate), merge conflicts and follow-ups after a merge. Use it whenever you open, update, watch or fix a PR in this repo, when CI is red, when the user says "PR", "pushen", "mergen", "neuer PR", "im gleichen PR" or asks to follow a PR.
---

# Shipping and stewarding a PR

CLAUDE.md "Workflow" is the rulebook; this is the procedure that applies
it without missing a step. Read CLAUDE.md first if you have not.

## Before the first commit

1. `git fetch origin main` and branch from **`origin/main`**, never from a
   stale local `main` (it can be dozens of commits behind).
2. If the change belongs to an open PR the user named ("im gleichen PR"),
   check its state first. **Merged PR → new branch from main.** Never push
   follow-ups onto a merged branch.

## Version and CHANGELOG

- Next version = `origin/main:package.json` + bump, **skipping numbers that
  open PRs already use** (look at open PR titles: `(... vX.Y.Z)`).
- Bump `package.json` and the two `"version"` lines at the top of
  `package-lock.json`. Use a script or sed, never a full regeneration.
- New `## [X.Y.Z] - YYYY-MM-DD` section at the top: headings English
  (Added/Changed/Fixed/Removed), bullets German, written for players.
- Follow-up commits in the same PR extend that section; don't add a
  second version.

## Before every push

Run these as **separate steps**, never `npm test ... && git push` chains.
A failing test must stop you; once a push went out with a red test
because the commands were chained.

```bash
rm -f data/*.json data/crash.log data/users.db data/users.db-shm data/users.db-wal
npm test                     # == CI; must be all pass
npm run -s docs:check && npm run -s csp:check && npm run -s secrets:check
git fetch origin main && git log --oneline HEAD..origin/main   # main moved? merge it first
git status --short           # stage ONLY your files, never `git add -A`
```

- If tests fail with "server on port … did not come up", check for a server
  of your own on `data/` first (`pgrep -af "node server.js"`). It holds
  `users.db`, and that is not a flaky test. The `ui-shots` skill avoids it.
- Commit with `-c user.email=… -c user.name=…` and the attribution lines.
- After the push: `git ls-remote origin <branch>` must equal `git rev-parse HEAD`.

## UI changes

Use the `ui-shots` skill: check portrait, landscape and desktop. Put
before/after screenshots in the PR (branch `pr-screenshots`, links by SHA).
Refresh them when a follow-up commit changes what they show.

## The PR

- Mirror `.github/pull_request_template.md` (What and why / Changes /
  Screenshots / Checklist). Delete sections that do not apply.
- Update the description when follow-up commits change scope. Reviewers
  read the description, not the commit list.
- The user squash-merges. Never merge yourself.

## Red CI

1. Read the failing job's log before touching code.
2. **`dependency-check` red** usually means a new npm advisory, not your
   diff. Run `npm audit` locally. If `npm audit fix` only touches
   `package-lock.json`, commit it into the current PR with a CHANGELOG
   "Fixed" line, since every other branch is blocked until it lands. A fix
   that needs a major bump: ask, majors are never automatic (CLAUDE.md §8).
3. A failing test is never "flaky" until you reproduced it locally with a
   clean `data/` and no stray server.
4. Never skip, disable or loosen a test to get green. When behaviour
   changed on purpose, update the assertion and say why in the commit.

## Merge conflicts

Merge `origin/main` into the branch (no rebase, no force-push). Resolve by
keeping both features, not by picking a side. Typical in this repo:
`renderResultOverlay` in `client.js`, `CHANGELOG.md` (keep both sections,
newest version on top), the version lines in `package*.json` (keep yours,
it is the higher one). Re-run the browser check afterwards; conflicts in
the result sheet often break layout in landscape.

## Watching a PR

When the user asks to follow a PR, subscribe to its activity and keep one
safety-net check-in while it only waits on CI. On merge: cancel the
check-in and say so in one line. Follow-up work after a merge goes on a
new branch from main.
