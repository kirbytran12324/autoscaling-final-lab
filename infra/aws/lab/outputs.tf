output "lab" {
  description = "Non-secret identifiers used by read-only verification and guarded foundation teardown."
  value = {
    account_id          = var.aws_account_id
    region              = var.aws_region
    cluster_name        = aws_eks_cluster.lab.name
    cluster_arn         = aws_eks_cluster.lab.arn
    vpc_id              = aws_vpc.lab.id
    node_group_name     = aws_eks_node_group.workers.node_group_name
    nat_gateway_id      = aws_nat_gateway.lab.id
    private_subnet_ids  = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    cloudshell_group_id = aws_security_group.cloudshell.id
  }
}
