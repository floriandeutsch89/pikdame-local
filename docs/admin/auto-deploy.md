# Automatic deploy after a merge

Without this, Watchtower picks up a new release at 04:00. With it, a merge to
`main` is live a few minutes later:

1. The release workflow builds the images and pushes them to GHCR (as before):
   the app and the Caddy proxy.
2. The **Deploy** job logs in to the server over SSH.
3. The server runs `docker compose -f docker-compose.prod.yml pull` and
   `up -d` on **your** compose file - Watchtower's job, right away. Nothing is
   downloaded from the repository and nothing is compiled on the server.
4. The job waits until `/statusz` reports the new version. If it does not
   within 3 minutes, the job turns red.

Watchtower keeps running as a nightly safety net.

:::{note}
The deploy key can do **one thing only**: "pull the images and restart". It
never gets a shell, cannot forward ports, and the `deploy` user has no Docker
access of its own. Your compose file, `.env` and `secrets/` are never touched.
:::

:::{tip}
**Stack-file changes** (compose, `.env.example`) are not deployed
automatically - your compose file on the host stays yours. When a release note
mentions such a change, compare and apply it by hand, or run
`scripts/server-update.sh` (it replaces `docker-compose.prod.yml` with the
repository version and keeps `.env` and `secrets/`).
:::

## Tutorial (about 15 minutes)

Steps 1–4 run on the **server** as root, steps 5–7 on **GitHub**. Assumes the
stack from `server-bootstrap.sh` in `/opt/pikdame/docker`. For a Dockge setup
see step 3.

### 1. Create the deploy user

```bash
adduser --system --group --shell /bin/sh --home /home/deploy deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
```

The user is **not** added to the `docker` group (that would be root in
disguise).

### 2. Install the deploy script and the sudo rule

```bash
curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/scripts/pikdame-deploy.sh \
  -o /usr/local/bin/pikdame-deploy
chmod 755 /usr/local/bin/pikdame-deploy

cat > /etc/sudoers.d/pikdame-deploy <<'EOF'
Defaults!/usr/local/bin/pikdame-deploy env_keep += "SSH_ORIGINAL_COMMAND"
deploy ALL=(root) NOPASSWD: /usr/local/bin/pikdame-deploy
EOF
chmod 440 /etc/sudoers.d/pikdame-deploy
visudo -c
```

`visudo -c` must answer `parsed OK`. Read the script once before you install
it: this file is what the key may trigger, and deploys never replace it.

:::{important}
**Installed it before 2026-10-05?** Run the `curl … -o /usr/local/bin/pikdame-deploy`
line above once more. The first version downloaded the stack files from the
repository and overwrote your compose file on every deploy; the current one only
pulls images.
:::

:::{warning}
Do not drop the `env_keep` line. `sudo` clears the environment, and without it
the commit id never reaches the script: every deploy fails with
`expected a 40-character commit id, got ''`.
:::

### 3. Only for Dockge: point the script at your stack

Skip this when you used `server-bootstrap.sh` (`/opt/pikdame/docker/docker-compose.prod.yml`).

```bash
cat > /etc/pikdame-deploy.conf <<'CONF'
PIKDAME_DIR=/opt/stacks/pikdame
PIKDAME_COMPOSE_FILE=compose.yaml
CONF
```

### 4. Create the key and lock it to the script

On the server (the private key leaves it exactly once, in step 6):

```bash
ssh-keygen -t ed25519 -N '' -C github-deploy -f /root/github-deploy
echo "command=\"sudo -n /usr/local/bin/pikdame-deploy\",restrict $(cat /root/github-deploy.pub)" \
  > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

The file then holds **one line**, and the part in front of the key is
intentional:

```text
command="sudo -n /usr/local/bin/pikdame-deploy",restrict ssh-ed25519 AAAA... github-deploy
```

:::{important}
Keep the `command="…",restrict` prefix. It is not a leftover: it is the lock.

- `command="…"` is an OpenSSH *forced command*. Whatever a client asks to run
  with this key, sshd runs the deploy script instead. The client's request
  only arrives as `SSH_ORIGINAL_COMMAND`, and the script accepts nothing but a
  commit id of `main`.
- `restrict` switches off terminal, port, agent and X11 forwarding for this key.

Without the prefix, the same key would be an ordinary login with a shell for
`deploy` - exactly what must not sit in a GitHub secret.
:::

Check that the lock works. From your own machine, temporarily using the new key:

```bash
scp root@<server>:/root/github-deploy /tmp/github-deploy
ssh -i /tmp/github-deploy deploy@<server> 'id'
# pikdame-deploy: expected a 40-character commit id, got 'id'
```

> That refusal is the proof: whatever the key sends, only the deploy script
> answers.

| Answer to `ssh … 'id'` | Meaning |
| --- | --- |
| `expected a 40-character commit id, got 'id'` | Correct - the key can only start the deploy script |
| `uid=… (deploy) …` | The forced command is **not** applied: the prefix is missing, or sshd reads another `authorized_keys` |
| `sudo: a password is required` | Step 2 missing or `visudo -c` failed |
| `Permission denied (publickey)` | Owner/mode: `chown deploy:deploy` + `chmod 600` on the file, `chmod 700` on `.ssh` |

### 5. Create the `production` environment on GitHub

Repository → **Settings → Environments → New environment** → `production`.

Recommended under *Deployment branches and tags*: **Selected branches** →
`main`. Then only workflows running on `main` can read this environment's
secrets.

### 6. Store key and host key as environment secrets

In the `production` environment → **Add environment secret**:

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | the **private** key: `cat /root/github-deploy` (everything incl. the `-----BEGIN`/`END` lines) |
| `DEPLOY_KNOWN_HOSTS` | the server's host key line, see below |

Host key: read it **on the server** (that is the trustworthy copy):

```bash
echo "<server-address> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
# play.pikdame.online ssh-ed25519 AAAAC3Nza...
```

`<server-address>` must be exactly what you put into `DEPLOY_HOST` in step 7.
Then remove the copies:

```bash
rm /root/github-deploy          # on the server (the .pub stays, harmless)
rm /tmp/github-deploy           # on your machine
```

### 7. Set the repository variables

Repository → **Settings → Secrets and variables → Actions → Variables**:

| Variable | Example | Purpose |
| --- | --- | --- |
| `DEPLOY_HOST` | `play.pikdame.online` | Server address. **Setting it switches the auto-deploy on.** |
| `DEPLOY_URL` | `https://play.pikdame.online` | Checked afterwards (`/statusz` must show the new version) |
| `DEPLOY_USER` | `deploy` | optional, default `deploy` |
| `DEPLOY_PORT` | `22` | optional, default `22` |

### 8. Try it

**Actions → Deploy → Run workflow** (branch `main`). It deploys the current
`main`. A green run ends with:

```
Live: v2.42.0
```

From now on every merge that creates a release deploys by itself — including
Dependabot's automatic minor/patch merges.

## Turning it off

Delete the variable `DEPLOY_HOST`. The Deploy job is then skipped (shown grey,
not red), Watchtower carries on nightly. To revoke the key for good, empty
`/home/deploy/.ssh/authorized_keys` on the server.

## Troubleshooting

| Symptom in the Deploy job | Cause |
| --- | --- |
| Job skipped (grey) | `DEPLOY_HOST` not set, or the workflow ran on a branch other than `main` |
| `DEPLOY_SSH_KEY and DEPLOY_KNOWN_HOSTS must be set` | Secrets missing, or stored as repository secrets instead of in the `production` environment while the environment restricts them |
| `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` does not match: host name differs from `DEPLOY_HOST`, or the server was rebuilt (new host key) |
| `Permission denied (publickey)` | `authorized_keys` wrong owner/mode, the public key does not belong to `DEPLOY_SSH_KEY`, or your sshd config has `AllowUsers`/`AllowGroups` without `deploy` |
| `sudo: a password is required` | sudoers file missing or `visudo -c` failed |
| `expected a 40-character commit id, got ''` | `env_keep` line missing in the sudoers file |
| `… not found - set PIKDAME_DIR / PIKDAME_COMPOSE_FILE` | Stack is not in `/opt/pikdame/docker/docker-compose.prod.yml`: step 3 |
| `another deploy is still running` | Two merges in quick succession; the second one waits up to 10 minutes |
| `still does not report vX.Y.Z after 3 minutes` | Deploy ran, but the app did not come up healthy: `docker compose -f docker-compose.prod.yml logs pikdame` on the server |

## What the job runs on the server

`/usr/local/bin/pikdame-deploy <commit>`:

1. Refuses anything that is not a 40-character commit id. The id only labels
   the log; which images run is decided by the tags in your compose file
   (`:latest` by default).
2. Takes a lock (`/run/pikdame-deploy.lock`), so deploys never overlap.
3. In your stack directory: `docker compose -f <file> pull --ignore-buildable`,
   `up -d`, `docker image prune -f`, `ps`.

Caddy is pulled too: it is the prebuilt `pikdame-local-caddy` image, published
with every release. It carries the Caddyfile, which pins the hash of the app's
inline start-up script, so app and proxy must always be updated together - the
deploy and Watchtower both do that.

Trust model, stated plainly: whoever can merge to `main` decides which images
run on the server - as with Watchtower before. Branch protection on `main`
(required checks, no direct pushes) is what guards it.
