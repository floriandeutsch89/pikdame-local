output "ipv4" {
  description = "Public IPv4 of the server (point your DNS A record here)."
  value       = hcloud_server.pikdame.ipv4_address
}

output "ipv6" {
  description = "Public IPv6 (AAAA record)."
  value       = hcloud_server.pikdame.ipv6_address
}

output "ssh" {
  description = "SSH into the server."
  value       = "ssh root@${hcloud_server.pikdame.ipv4_address}"
}

output "dockge_tunnel" {
  description = "Dockge is not exposed publicly - open a tunnel, then browse http://localhost:5001"
  value       = "ssh -L 5001:localhost:5001 root@${hcloud_server.pikdame.ipv4_address}"
}
