variable "admin_ipv4_cidr" {
  description = "Current administrator public IPv4 address with a /32 prefix."
  type        = string

  validation {
    condition = (
      can(cidrnetmask(var.admin_ipv4_cidr)) &&
      endswith(var.admin_ipv4_cidr, "/32")
    )
    error_message = "Supply an IPv4 address with a /32 prefix."
  }
}

resource "aws_eks_cluster" "lab" {
  name     = local.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = local.kubernetes_version

  bootstrap_self_managed_addons = false
  enabled_cluster_log_types     = ["api", "audit", "authenticator"]

  kubernetes_network_config {
    ip_family         = "ipv4"
    service_ipv4_cidr = "172.20.0.0/16"
  }

  vpc_config {
    subnet_ids = [
      aws_subnet.private_a.id,
      aws_subnet.private_b.id,
    ]

    security_group_ids      = [aws_security_group.eks.id]
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = [var.admin_ipv4_cidr]
  }

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }

  upgrade_policy {
    support_type = "STANDARD"
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster,
    aws_cloudwatch_log_group.eks,
  ]

  tags = {
    Name = "metronome-lab"
  }
}
