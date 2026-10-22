resource "aws_eks_access_entry" "admin" {
  cluster_name  = aws_eks_cluster.lab.name
  principal_arn = "arn:aws:iam::${var.aws_account_id}:user/metronome-lab"
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "admin" {
  cluster_name  = aws_eks_access_entry.admin.cluster_name
  principal_arn = aws_eks_access_entry.admin.principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }
}