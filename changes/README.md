# Changelog fragments

Every pull request that changes the game (`public/`, `server.js`, `game/`,
`models/`, `docker/`, dependencies) adds **one fragment** here instead of
bumping the version and editing `CHANGELOG.md`. The release PR collects all
fragments on `main` into the next version and deletes them. Docs, tests, CI
or skills alone need no fragment.

## Format

One file per pull request: `changes/<topic>.md`, a unique name in lowercase
letters, digits, `-`, `.` or `_` (e.g. `changes/tutorial-hints.md`).
The content is a [Keep a Changelog](https://keepachangelog.com/) body
**without** the `## [x.y.z]` version line:

```markdown
<!-- bump: patch -->
### Added
- Neue Spielhilfe: Hinweis bei wenigen Karten
  (eingerückte Zeilen gehören zum Punkt darüber)

### Fixed
- Der Dialog „Zum Startbildschirm?“ ist jetzt übersetzt
```

- Headings in English: `### Added`, `### Changed`, `### Fixed`, `### Removed`
  (`### Deprecated` and `### Security` also work).
- Bullets in German, written for players, each starting with `- `.
  Indented lines continue the bullet above (also nested bullets).
- One-line HTML comments are notes for reviewers and are not released.

## Version bump

- Only `Fixed` and/or `Security` → **patch**; anything else → **minor**.
- An optional **first line** `<!-- bump: patch|minor|major -->` overrides
  that for the fragment. **Major** only comes from this marker.
- The release takes the highest level of all fragments.

## Release

On every push to `main`, `.github/workflows/release-pr.yml` rebuilds the
branch `release/next` with `node scripts/release.js --apply` and opens or
updates the PR *Release vX.Y.Z*: version in `package.json` and
`package-lock.json`, the new `CHANGELOG.md` section (headings in the order
Added, Changed, Fixed, Removed, bullets in the order the fragments were
merged), fragments deleted. Merging it is the release (`release.yml` tags,
publishes and deploys).

```bash
node scripts/release.js --dry-run   # preview the next section and version
node scripts/check-changes.js       # the CI check for your branch vs origin/main
```
