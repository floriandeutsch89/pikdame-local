#!/usr/bin/env bash
# Pik Dame - one-shot server bootstrap (Ubuntu/Debian, run as root).
# Hardening + Docker + production stack. Idempotent where possible.
#
#   curl -fsSL https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/scripts/server-bootstrap.sh | bash
#
# Afterwards (one-time):
#   1. cd /opt/pikdame/docker && nano .env            # domain, ACME mail, SMTP user
#   2. put passwords into secrets/db_password.txt and secrets/smtp_password.txt
#   3. docker compose -f docker-compose.prod.yml up -d
#   4. docker compose -f docker-compose.prod.yml exec crowdsec cscli bouncers add caddy-bouncer
#      -> paste the key into .env (CROWDSEC_API_KEY=...) and:
#   5. docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
set -euo pipefail

echo "== 1/6 System updates =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -y -q

echo "== 2/6 Unattended upgrades with nightly reboot =="
apt-get install -y -q unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/52unattended-upgrades-local << 'CONF'
// Reboot automatically at night when an update requires it (kernel etc.)
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF

echo "== 3/6 fail2ban (SSH brute-force protection) =="
apt-get install -y -q fail2ban
cat > /etc/fail2ban/jail.local << 'CONF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
CONF
systemctl enable --now fail2ban
systemctl restart fail2ban

echo "== 4/6 Firewall (UFW) =="
apt-get install -y -q ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP (ACME + redirect)
ufw allow 443/tcp  # HTTPS
ufw --force enable
# Note: Docker publishes ports past UFW (direct iptables). Published here:
# only 80/443 via Caddy - which is exactly what UFW allows anyway.

echo "== 5/6 Docker (official repository) =="
if ! command -v docker > /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "== 6/6 Fetch the production stack =="
mkdir -p /opt/pikdame/docker/secrets
cd /opt/pikdame/docker
BASE=https://raw.githubusercontent.com/floriandeutsch89/pikdame-local/main/docker
for f in docker-compose.prod.yml Caddyfile .env.example caddy/Dockerfile crowdsec/acquis.yaml; do
  mkdir -p "$(dirname "$f")"
  curl -fsSL "$BASE/$f" -o "$f"
done
[ -f .env ] || cp .env.example .env
chmod 600 .env
touch secrets/db_password.txt secrets/smtp_password.txt
chmod 600 secrets/*.txt

echo
echo "Bootstrap done. Next steps:"
echo "  1. nano /opt/pikdame/docker/.env                  (domain, ACME mail, SMTP user)"
echo "  2. echo -n 'STRONG-PW' > /opt/pikdame/docker/secrets/db_password.txt"
echo "     echo -n 'MAILGUN-SMTP-PW' > /opt/pikdame/docker/secrets/smtp_password.txt"
echo "  3. cd /opt/pikdame/docker && docker compose -f docker-compose.prod.yml up -d"
echo "  4. docker compose -f docker-compose.prod.yml exec crowdsec cscli bouncers add caddy-bouncer"
echo "     -> key into .env (CROWDSEC_API_KEY=...), then: docker compose -f docker-compose.prod.yml up -d --force-recreate caddy"
echo
echo "Later (after installing your SSH key): set 'PasswordAuthentication no' +"
echo "'PermitRootLogin prohibit-password' in /etc/ssh/sshd_config, systemctl reload ssh,"
echo "and ROTATE the current root password."
