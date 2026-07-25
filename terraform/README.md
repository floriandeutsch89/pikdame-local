# Pik Dame on Hetzner Cloud (Terraform)

Creates an Ubuntu 24.04 LTS server with Docker (from Docker's official apt
repository) and [Dockge](https://github.com/louislam/dockge) for managing
compose stacks. The game stack itself is then deployed **through Dockge**.

## Requirements

- Terraform >= 1.5
- A Hetzner Cloud API token (Console -> Project -> Security -> API tokens,
  *Read & Write*)
- An SSH public key

## Usage

```bash
cd terraform
export TF_VAR_hcloud_token="<your-token>"           # never commit this
export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"

terraform init
terraform plan
terraform apply
```

After `apply`, Terraform prints the IPv4/IPv6 addresses and ready-made SSH
commands. First-boot setup (cloud-init) needs another **2-4 minutes**;
follow it with `ssh root@<ip> cloud-init status --wait`.

## Opening Dockge (deliberately not public)

Port 5001 is **closed** in the Hetzner firewall. A publicly reachable
container manager holding the Docker socket would be a barn door, so reach
it through a tunnel instead:

```bash
ssh -L 5001:localhost:5001 root@<ip>
# then browse to http://localhost:5001 (create the admin account on first visit)
```

## Deploying the Pik Dame stack

1. In Dockge: **+ Compose** -> name it `pikdame` -> paste the contents of
   `docker/docker-compose.prod.yml` from this repository and fill in the
   environment values (`PIKDAME_BASE_URL`, database password, SMTP settings
   for the confirmation mails, ...).
2. While the GHCR packages are private, log in once on the server:
   `docker login ghcr.io -u floriandeutsch89` (PAT with `read:packages`).
   Not needed once the packages are public.
3. DNS: point the `play.pikdame.online` A record at the new IPv4 (and the
   AAAA record at the IPv6) - Caddy then obtains the certificate itself.

## Security posture

- **Hetzner cloud firewall** allows only SSH, 80, 443 and ICMP. It sits in
  front of the host, so it also covers Docker-published ports, which a
  host firewall such as ufw would not.
- **SSH is key-only**: password and keyboard-interactive authentication are
  disabled, root may log in with a key only, `MaxAuthTries 3`.
- **fail2ban** watches the SSH journal (`backend = systemd`, because the
  Ubuntu cloud image may ship without rsyslog and a file-based jail would
  silently never match) and bans an address for an hour after 5 failures
  within 10 minutes. Check it with `fail2ban-client status sshd`.
- **Unattended security upgrades** are enabled.
- Restrict `ssh_allowed_cidr` to your own address if it is static - that is
  the single most effective change on top of the above.

## Decisions taken (change via variables if you disagree)

- **`cx23` (x86) rather than ARM:** the GHCR images are built for amd64 by
  the GitHub runners, so `cax*` ARM machines cannot run them. `cx23` is the
  current entry plan; the older `cx22` still works but belongs to the
  previous generation. Confirm the current lineup with
  `hcloud server-type list`.
- **`fsn1` (Falkenstein, Germany):** matches the "hosted in Germany" claim
  in the privacy statement.
- **`prevent_destroy` on the server:** game state lives in Docker volumes
  on that machine, so an accidental `terraform destroy` must not be enough
  to wipe it.
