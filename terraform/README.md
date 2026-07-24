# Pik Dame auf Hetzner Cloud (Terraform)

Erzeugt einen Ubuntu-24.04-LTS-Server mit Docker (offizielles Docker-Repo)
und [Dockge](https://github.com/louislam/dockge) als Compose-Stack-Verwaltung.
Der Spiel-Stack selbst wird danach **über Dockge** eingespielt.

## Voraussetzungen

- Terraform >= 1.5
- Hetzner-Cloud-API-Token (Konsole -> Projekt -> Security -> API tokens, *Read & Write*)
- Ein SSH-Public-Key

## Benutzung

```bash
cd terraform
export TF_VAR_hcloud_token="<dein-token>"          # niemals committen
export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"

terraform init
terraform plan
terraform apply
```

Nach `apply` zeigt Terraform IPv4/IPv6 und fertige SSH-Befehle an. Die
Ersteinrichtung (cloud-init) braucht nach dem Boot noch **2-4 Minuten**;
Fortschritt: `ssh root@<ip> cloud-init status --wait`.

## Dockge öffnen (bewusst nicht öffentlich)

Port 5001 ist in der Hetzner-Firewall **zu**. Eine offene Container-
Verwaltung mit Docker-Socket wäre ein Scheunentor - deshalb nur per Tunnel:

```bash
ssh -L 5001:localhost:5001 root@<ip>
# dann im Browser: http://localhost:5001  (beim ersten Mal Admin-Konto anlegen)
```

## Pik-Dame-Stack einspielen

1. In Dockge: **+ Compose** -> Name `pikdame` -> Inhalt aus
   `docker/docker-compose.prod.yml` dieses Repos einfügen und die
   Umgebungswerte setzen (`PIKDAME_BASE_URL`, Datenbank-Passwort, SMTP für
   die Bestätigungs-Mails, ...).
2. Solange die GHCR-Pakete privat sind, vorher einmalig auf dem Server
   anmelden: `docker login ghcr.io -u floriandeutsch89` (PAT mit
   `read:packages`). Entfällt, sobald die Pakete public sind.
3. DNS: A-Record von `play.pikdame.online` auf die neue IPv4 (und AAAA auf
   die IPv6) stellen - Caddy holt sich das Zertifikat dann selbst.

## Getroffene Entscheidungen (bei Bedarf per Variable ändern)

- **`cx22` (x86) statt ARM:** die GHCR-Images werden von den GitHub-Runnern
  für amd64 gebaut; auf `cax*`-ARM-Maschinen liefen sie nicht.
- **`fsn1` (Falkenstein, Deutschland):** passend zur Datenschutz-Angabe
  "Hosting in Deutschland".
- **`prevent_destroy`** am Server: Spielstände liegen in Docker-Volumes auf
  der Maschine - ein versehentliches `terraform destroy` soll nicht reichen,
  sie zu löschen.
- **SSH weltweit offen (Default):** per `ssh_allowed_cidr` auf die eigene
  feste IP einschränkbar.
