# Contributing

## Workflow

1. Branch off `main` (`feat/…`, `fix/…`, `perf/…`, `chore/…`).
2. Make the change **plus tests**.
3. `npm test` — everything green.
4. Bump the version in `package.json` and add a `CHANGELOG.md` entry
   (*documentation-only changes need no version bump*).
5. Open a PR. CI runs the suite; squash-merge when green. A release is tagged
   automatically from the version in `package.json`.

## Dependency updates (Dependabot)

Updates are not raised by hand. `.github/dependabot.yml` checks npm, the Docker
base images, the images used in the compose files and the GitHub Actions every
Monday at 03:00 UTC; `.github/workflows/dependabot-auto.yml` then does the two
things Dependabot cannot:

- it appends the SemVer bump and the German `CHANGELOG.md` line, because
  `release.yml` skips a version whose tag already exists — without the bump a
  merged update would produce no tag and no image;
- it enables auto-merge for **minor and patch** updates. **Major** updates
  (a new Node base image, a Postgres major) get a label, a reviewer and a
  comment listing what has to move with them; they never merge on their own.

npm updates are deliberately **grouped**: the CI job `dependency-check` runs
`npm outdated` and fails while any package is behind, so one pull request per
package would keep every pull request red.

### One-time setup

The workflow acts through a **GitHub App token**, not `GITHUB_TOKEN`: GitHub
does not start workflow runs for events created with `GITHUB_TOKEN`, so the
bump commit would never be tested and the merge would never trigger
`release.yml`. An App token also has no expiry date, unlike the personal
access token used before.

1. **Register the App** — *Settings → Developer settings → GitHub Apps → New
   GitHub App*, on the account that owns the repository:

   | Field | Value |
   | --- | --- |
   | GitHub App name | e.g. `pikdame-deps-bot` (must be unique across GitHub) |
   | Homepage URL | the repository URL — the form requires something here |
   | Callback URL | *empty* — the App never signs a user in |
   | Request user authorization (OAuth) during installation | off |
   | Enable Device Flow | off |
   | Setup URL | *empty* |
   | **Webhook → Active** | **off** — on by default and it demands a URL |
   | Where can this App be installed? | Only on this account |

2. **Repository permissions** — everything else stays *No access*:

   | Permission | Level | Why |
   | --- | --- | --- |
   | Metadata | Read-only | mandatory, selected automatically |
   | Contents | Read and write | push the bump commit onto the PR branch |
   | Pull requests | Read and write | enable auto-merge, request a reviewer, comment |
   | Issues | Read and write | the label API for pull requests lives under issues |
   | Workflows | Read and write | required to merge the `github-actions` update PRs, which change files under `.github/workflows/` |

   Do **not** grant *Administration*: the App has no business bypassing branch
   protection.

3. **Create it**, note the numeric **App ID** at the top of the page, then
   *Generate a private key* — a `.pem` file is downloaded. It is shown once.

4. **Install it**: *Install App* → this account → *Only select repositories* →
   this repository.

5. **Store the credentials as _Dependabot_ secrets** — *Settings → Secrets and
   variables → **Dependabot***, not Actions: workflow runs triggered by a
   Dependabot pull request cannot read Actions secrets.

   | Secret | Value |
   | --- | --- |
   | `DEPS_BOT_APP_ID` | the numeric App ID |
   | `DEPS_BOT_PRIVATE_KEY` | the **entire** `.pem` file including the `-----BEGIN`/`-----END` lines |

6. **Repository settings**: enable *Allow auto-merge* (*Settings → General →
   Pull Requests*), and protect `main` with **required status checks**
   (`test`, `dependency-check`, `docker-security`, `docker-smoke`) but
   **no required approvals** — without required checks GitHub merges an
   auto-merge pull request immediately, and required approvals would put the
   manual step back in.

7. **Create the labels** `dependencies`, `docker`, `github-actions` and
   `needs-review`; Dependabot silently ignores labels that do not exist.

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
