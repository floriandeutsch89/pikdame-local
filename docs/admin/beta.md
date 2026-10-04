# Beta preview for pull requests

Every push to a pull request is live on **beta.pikdame.online** a few minutes
later. You can try the change on the iPhone before it is merged. No extra
branch is needed: the pull request *is* the beta.

1. The **Beta** workflow builds the image from the pull request's head commit
   (amd64 only) and pushes it to GHCR as `pikdame-local:beta`.
2. It logs in to the server with a **second** deploy key, which can only run
   `pikdame-deploy beta`.
3. The server pulls and restarts `docker-compose.beta.yml`. It then checks that
   the running container was built from exactly the pushed commit.
4. The job waits until `https://beta…/statusz` answers. The pull request shows
   **View deployment** next to the `beta` environment.

There is **one** slot: the most recent push to any pull request wins. A
running rollout is never cut off. Pushes that arrive meanwhile collapse into
one follow-up run for the newest commit.

## What is shared with production, and what is not

| | Production | Beta |
| --- | --- | --- |
| Host, Docker, Caddy, CrowdSec | shared | shared |
| Containers, volumes, compose project | `pikdame`, … | `pikdame-beta`, … (project `pikdame-beta`) |
| Database | `pikdame-postgres` | own `pikdame-beta-postgres`, own password; data **persists** between deploys |
| Accounts and passkeys | play domain | beta domain only (the passkey RP-ID is the host name) |
| Mail | Mailgun via `smtp-egress` | same Mailgun account via its own `smtp-egress-beta` |
| Admin page | `PIKDAME_ADMIN_TOKEN` | `PIKDAME_BETA_ADMIN_TOKEN` (off while unset) |
| Updates | release → deploy, Watchtower nightly | beta workflow only, **no** Watchtower |
| Limits | 1 CPU / 512 MB | 0.5 CPU / 384 MB, 20 tables |
| Search engines | indexed | `X-Robots-Tag: noindex, nofollow` |

Caddy reaches the beta app over one extra internal network
(`pikdame-caddy-beta`). The prod compose file creates it, and the beta stack
joins it. Beta has no route to the prod app or the prod database.

:::{warning}
**Trust model:** anyone who can push a branch to this repository can run code on
the production host, inside the hardened beta container (no capabilities,
read-only root, AppArmor, no route to the prod network). That code can also
send mail through the shared Mailgun account. Fork pull requests and
Dependabot branches **never** deploy: the workflow uses `pull_request`,
never `pull_request_target`, and `test/beta-contract.test.js` keeps it that way.
:::

:::{note}
**Known limit:** the Content-Security-Policy is baked into the Caddy image of
the last **release**. If a pull request edits the inline head script of
`index.html`, beta blocks that script until the change is released. The
splash then ends through its CSS fallback after 9 s. Everything else is
unaffected.
:::

## Setup (about 20 minutes, once)

Requires the {doc}`auto-deploy` setup (deploy user, script, sudo rule). Steps
1–5 run on the **server** as root, steps 6–8 on **GitHub**.

### 1. DNS

Add an `A` record (and `AAAA` if prod has one) `beta.pikdame.online` → the
same IP as `play.pikdame.online`.

### 2. Stack files and configuration

The beta site block ships with the Caddy image of the release that contains
this page. After that release:

```bash
curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/scripts/server-update.sh | bash
cd /opt/pikdame/docker
echo 'PIKDAME_BETA_DOMAIN=beta.pikdame.online' >> .env
openssl rand -base64 24 | tr -d '\n' > secrets/beta_db_password.txt
chown 10001:10001 secrets/*.txt && chmod 400 secrets/*.txt
docker compose -f docker-compose.prod.yml up -d   # Caddy: new network + beta certificate
```

Optional, for `/admin` on beta (generate a hash with a **different** password
than prod's):

```bash
echo "PIKDAME_BETA_ADMIN_TOKEN='<argon2id hash>'" >> .env
```

### 3. Update the deploy script

The beta mode is new in the script, and deploys never replace it:

```bash
curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/scripts/pikdame-deploy.sh \
  -o /usr/local/bin/pikdame-deploy
chmod 755 /usr/local/bin/pikdame-deploy
```

The sudo rule from {doc}`auto-deploy` stays as it is. It allows the script
with any argument, and the argument is fixed per key in the next step.

### 4. A second key, locked to the beta mode

```bash
ssh-keygen -t ed25519 -N '' -C github-beta -f /root/github-beta
echo "command=\"sudo -n /usr/local/bin/pikdame-deploy beta\",restrict $(cat /root/github-beta.pub)" \
  >> /home/deploy/.ssh/authorized_keys
```

Mind the `>>`: the production key stays the first line. Check the lock from
your machine:

```bash
scp root@<server>:/root/github-beta /tmp/github-beta
ssh -i /tmp/github-beta deploy@<server> 'id'
# pikdame-deploy: expected a 40-character commit id, got 'id'
```

### 5. First start of the beta stack

```bash
docker compose -f docker-compose.beta.yml pull   # fails until the first beta build exists - fine
```

The first beta workflow run starts the stack itself. Until then,
`beta.pikdame.online` answers `502`.

### 6. Create the `beta` environment on GitHub

Repository → **Settings → Environments → New environment** → `beta`.
Leave *Deployment branches* on **No restriction**, because pull request
branches have arbitrary names.

### 7. Environment secrets (in `beta`, not `production`)

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | `cat /root/github-beta`, the **beta** private key |
| `DEPLOY_KNOWN_HOSTS` | same host key line as for production |

Same names as in `production`. Each environment hands out only its own
secrets. Then delete `/root/github-beta` and your local copy.

### 8. Switch it on

Only now, with the environment and both secrets in place, set the repository
variable (next to `DEPLOY_HOST`). Until it exists, the Beta workflow is
skipped on every pull request (grey, never red). Do not set it earlier: GitHub
cannot check whether an environment exists before starting the job, and a job
that names a missing one creates it empty, which leaves the run red for lack of
secrets.

| Variable | Value |
| --- | --- |
| `BETA_URL` | `https://beta.pikdame.online` |

Push to any open pull request. A green **Beta** run ends with
`Beta live: v2.46.0 (abc1234)`.

## Turning it off

Delete `BETA_URL` (runs are skipped, shown grey). To free the resources:
`docker compose -f docker-compose.beta.yml down`. Add `-v` to also drop the
beta database. To revoke the key, delete its line from
`/home/deploy/.ssh/authorized_keys`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Beta run skipped (grey) | `DEPLOY_HOST` or `BETA_URL` unset, a fork PR, or a `dependabot/` branch |
| `must be set in the 'beta' environment` | Secrets stored in `production` or as repository secrets |
| `beta runs revision '…', expected …` | The pull did not get the new `:beta` image, e.g. GHCR was briefly unreachable. Re-run the job |
| `network pikdame-caddy-beta declared as external, but could not be found` | Prod stack not updated yet: step 2 |
| `502` on beta | Beta stack not running: `docker compose -f docker-compose.beta.yml ps` / `logs pikdame-beta` |
| Certificate error on beta | `PIKDAME_BETA_DOMAIN` not in `.env`, or DNS not pointing at the host yet. Recreate Caddy after fixing |
| Registration mail does not arrive | Same causes as prod ({doc}`mail`): `docker compose -f docker-compose.beta.yml logs smtp-egress-beta` |
