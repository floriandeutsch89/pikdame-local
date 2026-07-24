# Pik Dame on Hetzner Cloud: one small Ubuntu LTS server with Docker and
# Dockge (a friendly web UI for docker-compose stacks). The game stack
# itself is then deployed THROUGH Dockge - see README.md.

resource "hcloud_ssh_key" "admin" {
  name       = "${var.server_name}-admin"
  public_key = var.ssh_public_key
}

# Cloud firewall in front of the host. Note that this also protects
# Docker-published ports (which would bypass a host firewall like ufw):
# Dockge's port 5001 is NOT opened here on purpose - reach it via an SSH
# tunnel only (see README).
resource "hcloud_firewall" "web" {
  name = "${var.server_name}-web"

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = [var.ssh_allowed_cidr]
  }

  rule {
    description = "HTTP (Caddy redirect + ACME)"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "ICMP (ping, path MTU)"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "pikdame" {
  name         = var.server_name
  image        = "ubuntu-24.04" # newest Ubuntu LTS
  server_type  = var.server_type
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.web.id]

  user_data = file("${path.module}/cloud-init.yaml")

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  # The game state lives in Docker volumes on the server. Protect the whole
  # machine from a careless `terraform destroy` - remove this line only when
  # you really mean to delete the server.
  lifecycle {
    prevent_destroy = true
  }

  labels = {
    role    = "pikdame"
    managed = "terraform"
  }
}
