# Beta preview for pull requests

Every push to a pull request is live on **beta.play.pikdame.online** a few minutes
later, on a server of its own. You can try the change on the iPhone before it
is merged. No extra branch is needed: the pull request *is* the beta.

1. The **Beta** workflow builds the app image from the pull request's head
   commit (amd64 only) and pushes it to GHCR as `pikdame-local:beta`.
2. It logs in to the **beta host**, a server of its own, with a deploy key
   that can only run `pikdame-deploy beta`.
3. The server pulls and restarts `docker-compose.beta.yml`. It then checks that
   the app was built from exactly the pushed commit.
4. The job waits until `https://beta…/statusz` answers. The pull request shows
   **View deployment** next to the `beta` environment.

There is **one** slot: the most recent push to any pull request wins. A
running rollout is never cut off. Pushes that arrive meanwhile collapse into
one follow-up run for the newest commit.

## What is shared with production, and what is not

Nothing runs on the production host. The two only share the GitHub
repository and the Mailgun account.

| | Production | Beta |
| --- | --- | --- |
| Host | `play.pikdame.online` | own server (`BETA_HOST`) |
| Proxy | caddy-crowdsec stack ({doc}`shared-caddy`) | its own caddy-crowdsec stack on the beta host |
| Database | `pikdame-postgres` | own `pikdame-beta-postgres`; data **persists** between deploys |
| Accounts and passkeys | play domain | beta domain only (the passkey RP-ID is the host name) |
| Mail | Mailgun, production SMTP login | Mailgun, **own** SMTP login |
| Admin page | `PIKDAME_ADMIN_TOKEN` | `PIKDAME_BETA_ADMIN_TOKEN` (off while unset) |
| Updates | release → deploy, Watchtower nightly | beta workflow only; the beta containers carry no Watchtower label |
| Limits | 1 CPU / 512 MB | same, 20 tables |
| Search engines | indexed | `X-Robots-Tag: noindex, nofollow` |

The CSP comes from the app on both, so a pull request that edits the inline head
script of `index.html` gets its matching hash automatically.

:::{warning}
**Trust model:** anyone who can push a branch to this repository can run code on
the **beta host** (inside the hardened container) and can read the `beta`
environment's secrets from a modified workflow. Keep that host free of anything
that matters: no production keys, no production SMTP login, no backups. Fork
pull requests and Dependabot branches **never** deploy: the workflow uses
`pull_request`, never `pull_request_target`, and `test/beta-contract.test.js`
keeps it that way.
:::

## Setup (about 30 minutes, once)

Steps 1–5 run on the **beta host** as root, step 6 on the **production host**,
steps 7–8 on **GitHub**.

### 1. DNS and the shared Caddy

Point `beta.play.pikdame.online` (`A`, plus `AAAA` if the host has IPv6) at the
**beta host**. Set up the [caddy-crowdsec](https://github.com/floriandeutsch89/caddy-crowdsec)
stack there as on prod (its `infra/` also hardens the host: key-only SSH,
fail2ban, security updates). Then, as in {doc}`shared-caddy`, with the beta
names:

```bash
docker network create --internal caddy_beta_play_pikdame
# /opt/docker/caddy/compose.yaml: caddy_beta_play_pikdame: {} under the caddy service's networks,
#                                 caddy_beta_play_pikdame: { external: true } under the top-level networks
curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/docker/shared-caddy/beta.play.pikdame.caddy \
  -o /opt/docker/caddy/config/sites/beta.play.pikdame.caddy
chmod 0644 /opt/docker/caddy/config/sites/beta.play.pikdame.caddy
cd /opt/docker/caddy && docker compose up -d caddy   # recreate: a new network needs more than a reload
```

SSH (22) must be reachable from GitHub's runners: either publicly, or over
Tailscale (next section). A firewall that allows SSH only from your own
address makes every deploy time out.

#### SSH only over Tailscale

GitHub's runners have no fixed addresses, so an allowlist does not work. With
`TS_OAUTH_CLIENT_ID` set, the workflow joins the tailnet first as an ephemeral
node tagged `tag:ci`, authenticated by GitHub's OIDC token (workload identity
federation): no Tailscale secret is stored in GitHub.

1. **Policy** (Access controls). Any branch can trigger this, so `tag:ci` gets
   the beta host's port 22 and nothing else. Replace the default allow-all
   rule: `*` includes tagged nodes.
   ```json
   "tagOwners": { "tag:ci": ["autogroup:admin"], "tag:beta": ["autogroup:admin"] },
   "grants": [
     { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
     { "src": ["tag:ci"], "dst": ["tag:beta"], "ip": ["tcp:22"] }
   ]
   ```
   Tag the beta host `tag:beta` (Machines → Edit tags; keep its other tags).
   Leave the policy's `ssh` section alone: the deploy uses OpenSSH with the
   forced command, not Tailscale SSH.
2. **Trust credential** (Settings → Trust credentials → OpenID Connect): issuer
   GitHub, subject `repo:floriandeutsch89/pikdame-local:environment:beta`,
   scope `auth_keys` (write), tag `tag:ci`.
3. **Variables in the `beta` environment** (not secrets, neither is sensitive):
   `TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE` from that credential.
4. `BETA_HOST` = the beta host's Tailscale name or `100.x` address, and
   `DEPLOY_KNOWN_HOSTS` with exactly that name in front. `BETA_URL` stays public.

The step pings `BETA_HOST` until the new node is visible (up to 3 minutes).

### 2. Stack files

```bash
mkdir -p /opt/docker/beta.play.pikdame.online/secrets && cd /opt/docker/beta.play.pikdame.online
BASE=https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/docker
curl -fsSL "$BASE/docker-compose.beta.yml" -o docker-compose.beta.yml
curl -fsSL "$BASE/.env.beta.example" -o .env
chmod 600 .env
nano .env    # SMTP user of the beta login
```

Secrets. Use a **separate** Mailgun SMTP login for beta (Mailgun → Sending →
Domain settings → SMTP credentials), never the production one:

```bash
openssl rand -base64 24 | tr -d '\n' > secrets/beta_db_password.txt
echo -n '<beta SMTP password>' > secrets/smtp_password.txt
chown 10001:10001 secrets/*.txt && chmod 400 secrets/*.txt
docker compose -f docker-compose.beta.yml config -q
```

The deploy script defaults to `/opt/pikdame/docker`; point it at this directory:

```bash
echo 'PIKDAME_DIR=/opt/docker/beta.play.pikdame.online' > /etc/pikdame-deploy.conf
```

Optional, for `/admin` on beta (generate a hash with a **different** password
than prod's):

```bash
echo "PIKDAME_BETA_ADMIN_TOKEN='<argon2id hash>'" >> .env
```

### 3. Deploy user, script and sudo rule

Steps 1–2 of {doc}`auto-deploy`, unchanged: user `deploy`, script in
`/usr/local/bin/pikdame-deploy`, sudo rule, `visudo -c`.

### 4. The deploy key, locked to the beta mode

**Reuse the existing beta key** (the one in the `beta` environment) or create a
new one. **Never the production key:** every pull request branch can read the
`beta` environment's secrets.

New key:

```bash
ssh-keygen -t ed25519 -N '' -C github-beta -f /root/github-beta
echo "command=\"sudo -n /usr/local/bin/pikdame-deploy beta\",restrict $(cat /root/github-beta.pub)" \
  > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

Existing key: take its public line from the prod host
(`grep github-beta /home/deploy/.ssh/authorized_keys`) and write it to the same
file here, `command="…beta",restrict` prefix included.

Check the lock from your machine:

```bash
ssh -i <beta private key> deploy@<beta host> 'id'
# pikdame-deploy: expected a 40-character commit id, got 'id'
```

### 5. First start

```bash
docker compose -f docker-compose.beta.yml pull   # fails until the first beta build exists - fine
```

The first beta workflow run starts the stack itself.

### 6. Production host: remove the old beta

Only when you move an existing beta from the prod host. Run **before** the
next `server-update.sh` there (that no longer fetches the beta file):

```bash
cd /opt/pikdame/docker
docker compose -f docker-compose.beta.yml down -v   # -v drops the old beta database
rm docker-compose.beta.yml secrets/beta_db_password.txt
sed -i '/^PIKDAME_BETA_/d' .env
sed -i '/github-beta/d' /home/deploy/.ssh/authorized_keys   # beta key no longer works here
```

Then `server-update.sh` as usual.

### 7. The `beta` environment on GitHub

If it does not exist yet: Repository → **Settings → Environments → New
environment** → `beta`. Leave *Deployment branches* on **No restriction**,
because pull request branches have arbitrary names.

Environment secrets (in `beta`, not `production`):

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | the **beta** private key (unchanged if you reused it) |
| `DEPLOY_KNOWN_HOSTS` | the **beta host's** key line: `echo "<beta host> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"` on that host |

`<beta host>` must be exactly what goes into `BETA_HOST`. Then delete
`/root/github-beta` and any local copy.

### 8. Switch it on

Only now, with the environment and both secrets in place, set the repository
variables. Until both exist, the Beta workflow is skipped on every pull request
(grey, never red). Do not set `BETA_URL` earlier: GitHub cannot check whether an
environment exists before starting the job, and a job that names a missing one
creates it empty, which leaves the run red for lack of secrets.

| Variable | Value |
| --- | --- |
| `BETA_HOST` | address of the beta host, e.g. `beta.play.pikdame.online` |
| `BETA_URL` | `https://beta.play.pikdame.online` |
| `BETA_USER` | optional, default `deploy` |
| `BETA_PORT` | optional, default `22` |

Push to any open pull request. A green **Beta** run ends with
`Beta live: v2.48.0 (abc1234)`. Pull requests branched before this change still
carry the old workflow (aimed at `DEPLOY_HOST`): merge `main` into them.

## Checking a beta deploy

After a green **Beta** run:

```bash
curl -fsS https://beta.play.pikdame.online/statusz | jq -r .version          # version of the PR
curl -sI https://beta.play.pikdame.online | grep -iE 'x-robots|content-security'
docker inspect pikdame-beta --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'   # on the beta host: the PR's head commit
```

In the browser: start a game (WebSocket) and register (mail arrives).

## Turning it off

Delete `BETA_URL` (runs are skipped, shown grey). On the beta host:
`docker compose -f docker-compose.beta.yml down` (add `-v` to also drop the
beta database), or delete the server. To revoke the key, empty
`/home/deploy/.ssh/authorized_keys` there.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Beta run skipped (grey) | `BETA_HOST` or `BETA_URL` unset, a fork PR, or a `dependabot/` branch |
| `must be set in the 'beta' environment` | Secrets stored in `production` or as repository secrets |
| `pikdame-beta runs revision '…', expected …` | The pull did not get the new `:beta` image, e.g. GHCR was briefly unreachable. Re-run the job. Also: a `pikdame-deploy` from before v2.58.1 still checks `pikdame-beta-caddy`; reinstall it (step 3) |
| `Permission denied (publickey…)`, sshd log `account is locked` | `deploy` was created with a locked password: `usermod -p '*' deploy` ({doc}`auto-deploy`, step 1) |
| `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` in `beta` still holds the prod host key, or its host name differs from `BETA_HOST` |
| `502` on beta | App not running (`docker compose -f docker-compose.beta.yml ps` / `logs pikdame-beta`), or not on `caddy_beta_play_pikdame`: `docker network inspect caddy_beta_play_pikdame` must list `caddy` and `pikdame-beta` |
| Certificate error on beta | DNS not pointing at the beta host yet: `docker compose -f /opt/docker/caddy/compose.yaml logs caddy` |
| Registration mail does not arrive | Same causes as prod ({doc}`mail`): `docker compose -f docker-compose.beta.yml logs smtp-egress-beta` |
