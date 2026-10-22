resource "aws_launch_template" "workers" {
  name = "metronome-lab-workers"

  vpc_security_group_ids = [
    aws_security_group.workers.id,
  ]

  block_device_mappings {
    device_name = data.aws_ami.worker.root_device_name

    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # Fixed lab capacity uses burstable instances. Standard credit mode throttles
  # when credits run out instead of charging for unlimited surplus CPU credits.
  credit_specification {
    cpu_credits = "standard"
  }

  dynamic "tag_specifications" {
    for_each = toset(["instance", "volume", "network-interface"])
    content {
      resource_type = tag_specifications.value
      tags = {
        Name      = "metronome-lab-worker"
        Lab       = "metronome-lab"
        ManagedBy = "Terraform"
      }
    }
  }

  tags = {
    Name = "metronome-lab-workers"
  }
}

resource "aws_eks_node_group" "workers" {
  cluster_name    = aws_eks_cluster.lab.name
  node_group_name = "workers"
  node_role_arn   = aws_iam_role.workers.arn
  subnet_ids      = [aws_subnet.private_a.id, aws_subnet.private_b.id]

  ami_type        = "AL2023_x86_64_STANDARD"
  version         = local.kubernetes_version
  release_version = local.worker_ami_release
  capacity_type   = "ON_DEMAND"
  instance_types  = ["t3.medium"]

  scaling_config {
    min_size     = 2
    desired_size = 2
    max_size     = 2
  }

  launch_template {
    id      = aws_launch_template.workers.id
    version = tostring(aws_launch_template.workers.latest_version)
  }

  update_config {
    max_unavailable = 1
  }

  labels = { workload = "lab" }
  tags   = { Name = "metronome-lab-workers" }

  # Reverse ordering also keeps network access and role permissions present
  # while EKS terminates nodes during destruction.
  depends_on = [
    aws_iam_role_policy_attachment.workers_node,
    aws_iam_role_policy_attachment.workers_ecr,
    aws_eks_addon.before_workers,
    aws_route_table_association.private_a,
    aws_route_table_association.private_b,
    aws_route_table_association.public_a,
    aws_vpc_security_group_egress_rule.workers_https,
    aws_vpc_security_group_egress_rule.workers_to_eks,
    aws_vpc_security_group_ingress_rule.eks_from_workers,
    aws_vpc_security_group_egress_rule.eks_to_kubelet,
    aws_vpc_security_group_ingress_rule.kubelet_from_eks,
    aws_vpc_security_group_egress_rule.workers_to_workers,
    aws_vpc_security_group_ingress_rule.workers_to_workers,
  ]

  lifecycle {
    precondition {
      condition     = data.aws_ami.worker.architecture == "x86_64" && data.aws_ami.worker.state == "available"
      error_message = "The pinned EKS worker AMI must be available and x86_64."
    }
  }
}
