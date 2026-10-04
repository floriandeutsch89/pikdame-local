# Automatic deploy after a merge

Without this, Watchtower picks up a new release at 04:00. With it, a merge to
`main` is live a few minutes later:

1. The release workflow builds the image and pushes it to GHCR (as before).
2. The **Deploy** job logs in to the server over SSH and hands over the merged
   commit.
3. The server fetches the stack files of exactly that commit, pulls the
   images, rebuilds Caddy and restarts what changed
   (`scripts/server-update.sh`, the same script you would run by hand).
4. The job waits until `/statusz` reports the new version. If it does not
   within 3 minutes, the job turns red.

Watchtower keeps running as a nightly safety net.

:::{note}
The deploy key can do **one thing only**: roll out a commit that is on `main`.
It never gets a shell, cannot forward ports, and the `deploy` user has no Docker
access of its own. Even a leaked key cannot run anything else and cannot deploy
an unmerged branch: the server asks GitHub whether the commit is part of `main`
and refuses otherwise.
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

:::{warning}
Do not drop the `env_keep` line. `sudo` clears the environment, and without it
the commit id never reaches the script: every deploy fails with
`expected a 40-character commit id, got ''`.
:::

### 3. Only for Dockge: point the script at your stack

Skip this when you used `server-bootstrap.sh`.

```bash
echo 'PIKDAME_DIR=/opt/stacks/pikdame' > /etc/pikdame-deploy.conf
```

The directory must contain `docker-compose.prod.yml`.

### 4. Create the key and lock it to the script

On the server (the private key leaves it exactly once, in step 6):

```bash
ssh-keygen -t ed25519 -N '' -C github-deploy -f /root/github-deploy
echo "command=\"sudo -n /usr/local/bin/pikdame-deploy\",restrict $(cat /root/github-deploy.pub)" \
  > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

Check that the lock works. From your own machine, temporarily using the new key:

```bash
scp root@<server>:/root/github-deploy /tmp/github-deploy
ssh -i /tmp/github-deploy deploy@<server> 'id'
# pikdame-deploy: expected a 40-character commit id, got 'id'
```

> That refusal is the proof: whatever the key sends, only the deploy script
> answers.

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
| `… is not part of main … refused` | Manual run on a non-main commit — works as intended |
| `another deploy is still running` | Two merges in quick succession; the second one waits up to 10 minutes |
| `still does not report vX.Y.Z after 3 minutes` | Deploy ran, but the app did not come up healthy: `docker compose -f docker-compose.prod.yml logs pikdame` on the server |

## What the job runs on the server

`/usr/local/bin/pikdame-deploy <commit>`:

1. Refuses anything that is not a 40-character commit id.
2. Asks the GitHub API whether `main` contains the commit; refuses otherwise.
3. Takes a lock (`/run/pikdame-deploy.lock`), so deploys never overlap.
4. Downloads `scripts/server-update.sh` **of that commit** and runs it with
   `PIKDAME_REF=<commit>`: stack files of that commit (keeps `.env` and
   `secrets/`), `pull`, rebuild Caddy, `up -d --remove-orphans`.

Trust model, stated plainly: whoever can merge to `main` decides what runs on
the server. That was already true for the app image via Watchtower; with the
auto-deploy it also covers the stack files. Branch protection on `main`
(required checks, no direct pushes) is what guards it.
