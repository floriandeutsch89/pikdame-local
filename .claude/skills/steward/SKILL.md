---
name: steward
description: Repo conventions for shipping and driving a Pik Dame pull request to green - branch, changelog fragment (no version bump), data cleanup, push checks, screenshots, red CI (including the npm audit gate), stacked PRs, keeping a branch up to date, merge conflicts and follow-ups after a merge. Use it whenever you open, update, watch or fix a PR in this repo, when CI is red, when the user says "PR", "pushen", "mergen", "neuer PR", "im gleichen PR" or asks to follow a PR.
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
3. **Depends on an open PR?** Stack it: branch from that PR's branch and
   open the PR with that branch as base. Independent work always branches
   from main - never stack it just because another PR is open.

## Changelog fragment (never the version)

- **Only when the game changes**: `public/`, `server.js`, `game/`,
  `models/`, `docker/` or a dependency in the image. Docs, skills, tests or
  CI alone get **no fragment**.
- Add **one new file** `changes/<topic>.md` (unique, lowercase), format in
  `changes/README.md`: `### Added/Changed/Fixed/Removed`, bullets German,
  written for players. Optional first line `<!-- bump: patch|minor|major -->`;
  without it only Fixed/Security is a patch, the rest a minor.
- **Never touch** `package.json`/`package-lock.json` `version` or the
  `CHANGELOG.md` sections: the release PR (`release/next`, built by
  `release-pr.yml` on every merge) writes them. CI job `changelog-fragment`
  (`node scripts/check-changes.js`) enforces both; run it locally.
- Follow-up commits in the same PR extend that fragment. A stacked PR may
  extend its predecessor's fragment or add its own.
- Preview the release: `node scripts/release.js --dry-run`.
- Transition: PRs opened before fragments with a bump up to v2.71.0 stay as
  they are. If main has passed their number, convert them: section body
  into `changes/<topic>.md`, version lines and CHANGELOG.md back to main.

## Local PostgreSQL (npm test, ui-shots)

PostgreSQL is mandatory: the server refuses to start without it and every
test file takes its own schema of `PIKDAME_TEST_PG_URL`. In a sandbox with
PostgreSQL installed at `/usr/lib/postgresql/16/bin` but no running server
(initdb fails in the scratchpad: wrong owner), as root:

```bash
PG=/usr/lib/postgresql/16/bin; mkdir -p /tmp/pgfix && chown postgres /tmp/pgfix
setpriv --reuid=postgres --regid=postgres --init-groups $PG/initdb -D /tmp/pgfix/data -A trust -U postgres
setpriv --reuid=postgres --regid=postgres --init-groups $PG/pg_ctl -D /tmp/pgfix/data -l /tmp/pgfix/log \
  -o "-p 55432 -k /tmp/pgfix -c max_connections=400" start
$PG/psql -h 127.0.0.1 -p 55432 -U postgres -c 'CREATE DATABASE pikdame_test'
export PIKDAME_TEST_PG_URL=postgres://postgres@127.0.0.1:55432/pikdame_test
```

(`su postgres -c …` works too where allowed.) Already set up: only the
`pg_ctl … start` line and the `export`. `max_connections` is raised because
parallel test files each open pools.

## Before every push

Run these as **separate steps**, never `npm test ... && git push` chains.
A failing test must stop you; once a push went out with a red test
because the commands were chained. The same for any check: a printed
count (`git log HEAD..origin/main | wc -l`) never stops `&&`, and a push
went out 7 commits behind main that way (#382).

```bash
rm -f data/*.json data/crash.log
npm test                     # == CI; must be all pass (needs PIKDAME_TEST_PG_URL)
npm run -s docs:check && npm run -s secrets:check
git fetch origin main && git log --oneline HEAD..origin/main   # main moved? merge it first
git status --short           # stage ONLY your files, never `git add -A`
```

- If tests fail with "server on port … did not come up", check for a server
  of your own first (`pgrep -af "node server.js"`): it holds the port, and
  that is not a flaky test. Then check that PostgreSQL is reachable at
  `PIKDAME_TEST_PG_URL`.
- Commit with `-c user.email=… -c user.name=…` and the attribution lines.
- After the push: `git ls-remote origin <branch>` must equal `git rev-parse HEAD`.
- Moved or rewrote code with `\uXXXX` escapes or HTML entities? Check them in
  `git diff`: the write tools once turned them into literal characters.

## UI changes

Use the `ui-shots` skill: check portrait, landscape and desktop. Put
before/after screenshots in the PR (branch `pr-screenshots`, links by SHA).
Refresh them when a follow-up commit changes what they show.

## The PR

- Mirror `.github/pull_request_template.md` (What and why / Changes /
  Screenshots / Checklist). Delete sections that do not apply.
- Update the description when follow-up commits change scope. Reviewers
  read the description, not the commit list.
- Read the body back after creating or editing it: image links came out as
  escaped backtick/quote junk three times (#349, #355, #356). Markdown
  `![](…)` got mangled again in #367; `<img src="…" width="…">` came through.
- Creating the PR via the GitHub MCP tool swaps the closing lines for its own
  `_Generated by …_` footer (#370, #374, #377). Set the same body once more
  with `update_pull_request`; that keeps the lines as written. A REST
  `PATCH` (`gh api`) swaps it too. Fewer links get mangled less (compose
  before|after into one PNG); a link that keeps breaking came through as
  `github.com/<owner>/<repo>/blob/<sha>/<path>?raw=true` (#408).
- The user squash-merges. Never merge yourself.
- The squash commit on main carries every commit message of the PR, bodies
  included: what must stay out of the history (a surprise, a private
  detail) never goes into a commit message.

## Red CI

1. Read the failing job's log before touching code.
2. **`dependency-check` red** usually means a new npm advisory, not your
   diff. Run `npm audit` locally. If `npm audit fix` only touches
   `package-lock.json`, commit it into the current PR with a `### Fixed`
   line in the PR's fragment, since every other branch is blocked until it
   lands. A fix that needs a major bump: ask, majors are never automatic
   (CLAUDE.md §8). `npm outdated` red: bump the lockfile (`npm update
   <pkg>`), a `### Changed` line like in `changes/deps-*.md`. Locally, its
   "Latest" column only lists versions whose `engines.node` fits YOUR Node
   (jsdom 30 needs >= 22.22.2), so an old local Node shows a stale
   "Latest" - trust CI's.
3. **`changelog-fragment` red**: the message says which of three - a game
   change without a fragment, a malformed fragment (`file:line`), or an
   edit to the version / `CHANGELOG.md` sections (move it into the fragment).
4. A failing test is never "flaky" until you reproduced it locally with a
   clean `data/` and no stray server.
5. Never skip, disable or loosen a test to get green. When behaviour
   changed on purpose, update the assertion and say why in the commit.

## Up to date with main

`main` requires branches to be up to date before merging. When main moved
and the PR has **no conflicts**, update it on GitHub ("Update branch", or
the `update_pull_request_branch` API) - it adds a merge commit to the
branch, so `git pull` before the next local commit. With conflicts, merge
locally (below). Parallel PRs no longer collide on the version or
`CHANGELOG.md`; each brings its own fragment.

## Merge conflicts

Merge `origin/main` into the branch (no rebase, no force-push). Resolve by
keeping both features, not by picking a side. Typical in this repo:
`renderResultOverlay` in `client.js`. A conflict in `CHANGELOG.md` or a
`version` line means the branch edits them: move the entry into its
fragment and take main's side. Re-run the browser check afterwards;
conflicts in the result sheet often break layout in landscape. Stage the
resolution in its own step and check `git diff --cached --check` (it names
leftover conflict markers) before the merge commit - an `add && commit`
chained behind a failed edit once committed the markers.

When the predecessor of a **stacked** PR is squash-merged and its branch
deleted, GitHub retargets the stacked PR to main; merge `origin/main` into
it (the squash holds the same changes, so this is usually clean) and keep
its fragment.

## Watching a PR

When the user asks to follow a PR, subscribe to its activity and keep one
safety-net check-in while it only waits on CI. On merge: cancel the
check-in and say so in one line. Follow-up work after a merge goes on a
new branch from main.
