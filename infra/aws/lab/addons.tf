# Pod Identity is host-networked and obtains node-role credentials directly.
# Creating its DaemonSet and CNI before compute avoids booting nodes without CNI.
resource "aws_eks_addon" "before_workers" {
  for_each = toset(["eks-pod-identity-agent", "vpc-cni", "kube-proxy"])

  cluster_name                = aws_eks_cluster.lab.name
  addon_name                  = each.key
  addon_version               = local.addon_versions[each.key]
  resolve_conflicts_on_create = "NONE"
  resolve_conflicts_on_update = "NONE"
  preserve                    = false

  configuration_values = each.key == "vpc-cni" ? jsonencode({
    enableNetworkPolicy = "true"
    # Standard startup mode until application and CoreDNS policies are reviewed.
    env = { NETWORK_POLICY_ENFORCING_MODE = "standard" }
  }) : null

  dynamic "pod_identity_association" {
    for_each = each.key == "vpc-cni" ? [1] : []
    content {
      role_arn        = aws_iam_role.vpc_cni.arn
      service_account = "aws-node"
    }
  }

  depends_on = [aws_iam_role_policy_attachment.vpc_cni]
}

# CoreDNS needs schedulable nodes to become healthy, so it follows compute.
resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.lab.name
  addon_name                  = "coredns"
  addon_version               = local.addon_versions.coredns
  resolve_conflicts_on_create = "NONE"
  resolve_conflicts_on_update = "NONE"
  preserve                    = false
  depends_on                  = [aws_eks_node_group.workers]
}

resource "aws_iam_role" "vpc_cni" {
  name = "metronome-lab-vpc-cni"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Condition = {
        StringEquals = {
          "aws:RequestTag/eks-cluster-arn"            = "arn:aws:eks:${var.aws_region}:${var.aws_account_id}:cluster/${local.cluster_name}"
          "aws:RequestTag/kubernetes-namespace"       = "kube-system"
          "aws:RequestTag/kubernetes-service-account" = "aws-node"
        }
      }
    }]
  })
  tags = { Name = "metronome-lab-vpc-cni" }
}

resource "aws_iam_role_policy_attachment" "vpc_cni" {
  role       = aws_iam_role.vpc_cni.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}
