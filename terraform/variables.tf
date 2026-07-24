variable "hcloud_token" {
  description = "Hetzner Cloud API token (create in the Hetzner console under Security > API tokens, read+write). Pass via TF_VAR_hcloud_token - do not commit it."
  type        = string
  sensitive   = true
}

variable "server_name" {
  description = "Name of the server in the Hetzner console."
  type        = string
  default     = "pikdame"
}

variable "server_type" {
  description = "Hetzner server type. Default is x86 (cx22) ON PURPOSE: the pikdame images on GHCR are built for amd64 by the GitHub runners - ARM types (cax*) cannot run them unless multi-arch builds are added."
  type        = string
  default     = "cx22"
}

variable "location" {
  description = "Hetzner location. fsn1 (Falkenstein) and nbg1 (Nuremberg) are in Germany - relevant for the privacy statement."
  type        = string
  default     = "fsn1"
}

variable "ssh_public_key" {
  description = "Your SSH public key (the content of ~/.ssh/id_ed25519.pub) for root access to the server."
  type        = string
}

variable "ssh_allowed_cidr" {
  description = "CIDR allowed to reach SSH (port 22). Default is the whole internet; tighten it to your own IP (e.g. \"203.0.113.5/32\") if it is static."
  type        = string
  default     = "0.0.0.0/0"
}
