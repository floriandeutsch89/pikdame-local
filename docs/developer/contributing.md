# Contributing

## Workflow

1. Branch off `main` (`feat/…`, `fix/…`, `perf/…`, `chore/…`).
2. Make the change **plus tests**.
3. `npm test` — everything green.
4. Bump the version in `package.json` and add a `CHANGELOG.md` entry
   (*documentation-only changes need no version bump*).
5. Open a PR. CI runs the suite; squash-merge when green. A release is tagged
   automatically from the version in `package.json`.

## House rules for the code

**Language.** Code, comments, commit messages and this documentation are in
**English**. The app's user-facing text is **German** (with English
translations in `public/i18n.js`); the changelog is German because it is read by
the people who play the game.

**Tests are not optional.** Every bug fix gets a regression test that fails
before the fix. Several subtle rule bugs were only caught by tests that play
thousands of complete bot games and assert invariants — that style is encouraged.

**Bot behaviour must be measured.** See {doc}`bots`. A change to how bots choose
moves does not ship on a hunch, however plausible. Measure it; if it does not
help, say so and keep the default.

**Never trust the client.** Anything arriving over the WebSocket is hostile until
validated. New control fields must be added to the sanitiser.

**No new dependencies without a reason.** The server has a minimal dependency
tree and the client has none at all. Keep it that way; it is a feature.

## Documentation

The docs live in `docs/` and are built with Sphinx + MyST (Markdown). Pages that
must never drift from the code — environment variables, the WebSocket protocol,
game constants — are **generated**:

```bash
npm run docs:gen      # regenerate docs/_generated/*.md
npm run docs:check    # fails if they are stale (CI runs this)
```

If you change an env var, a protocol message or a game constant, run
`npm run docs:gen` and commit the result — otherwise CI will fail.

To build the docs locally:

```bash
# One-time: create a venv and install dependencies
uv venv docs/.venv
uv pip install --python docs/.venv/Scripts/python.exe -r docs/requirements.txt sphinx-autobuild

# Live-reload server → http://127.0.0.1:8000
docs/.venv/Scripts/sphinx-autobuild.exe docs docs/_build/html

# Or a one-shot build → docs/_build/html/index.html
docs/.venv/Scripts/sphinx-build.exe -b html docs docs/_build/html
```

On Linux/macOS replace `Scripts/` with `bin/`.

## Reporting bugs

Open an issue with: what you did, what happened, what you expected. For game-rule
bugs, the exact card situation is gold — a screenshot of the table, or the
exported game JSON (there is a **Spielverlauf exportieren** button at game end),
makes it reproducible in a test.
