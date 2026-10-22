resource "aws_security_group" "efs" {
  name        = "metronome-lab-efs"
  description = "Security group for lab EFS mount targets"
  vpc_id      = aws_vpc.lab.id

  tags = {
    Name = "metronome-lab-efs"
  }
}

resource "aws_security_group" "workers" {
  name        = "metronome-lab-workers"
  description = "Security group for lab worker nodes"
  vpc_id      = aws_vpc.lab.id

  tags = {
    Name = "metronome-lab-workers"
  }
}

resource "aws_security_group" "eks" {
  name        = "metronome-lab-eks"
  description = "Security group for lab EKS control plane"
  vpc_id      = aws_vpc.lab.id

  tags = {
    Name = "metronome-lab-eks"
  }
}

resource "aws_security_group" "cloudshell" {
  name        = "metronome-lab-cloudshell"
  description = "Security group for lab CloudShell administration"
  vpc_id      = aws_vpc.lab.id

  tags = {
    Name = "metronome-lab-cloudshell"
  }
}

resource "aws_vpc_security_group_egress_rule" "workers_to_efs" {
  security_group_id            = aws_security_group.workers.id
  referenced_security_group_id = aws_security_group.efs.id

  from_port   = 2049
  to_port     = 2049
  ip_protocol = "tcp"
  description = "Allow workers to mount EFS"
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_workers" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.workers.id

  from_port   = 2049
  to_port     = 2049
  ip_protocol = "tcp"
  description = "Allow EFS mounts from workers"
}

resource "aws_vpc_security_group_egress_rule" "workers_to_eks" {
  security_group_id            = aws_security_group.workers.id
  referenced_security_group_id = aws_security_group.eks.id

  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "Allow workers to contact the Kubernetes API"
}

resource "aws_vpc_security_group_ingress_rule" "eks_from_workers" {
  security_group_id            = aws_security_group.eks.id
  referenced_security_group_id = aws_security_group.workers.id

  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "Allow Kubernetes API connections from workers"
}

resource "aws_vpc_security_group_egress_rule" "eks_to_kubelet" {
  security_group_id            = aws_security_group.eks.id
  referenced_security_group_id = aws_security_group.workers.id

  from_port   = 10250
  to_port     = 10250
  ip_protocol = "tcp"
  description = "Allow EKS to contact the workers Kubelet"
}

resource "aws_vpc_security_group_ingress_rule" "kubelet_from_eks" {
  security_group_id            = aws_security_group.workers.id
  referenced_security_group_id = aws_security_group.eks.id

  from_port   = 10250
  to_port     = 10250
  ip_protocol = "tcp"
  description = "Allow EKS to contact the workers Kubelet"
}

resource "aws_vpc_security_group_egress_rule" "eks_to_lb_webhook" {
  security_group_id            = aws_security_group.eks.id
  referenced_security_group_id = aws_security_group.workers.id

  from_port   = 9443
  to_port     = 9443
  ip_protocol = "tcp"
  description = "Allow EKS to contact the load balancer controller webhook"
}

resource "aws_vpc_security_group_ingress_rule" "lb_webhook_from_eks" {
  security_group_id            = aws_security_group.workers.id
  referenced_security_group_id = aws_security_group.eks.id

  from_port   = 9443
  to_port     = 9443
  ip_protocol = "tcp"
  description = "Allow EKS to contact the load balancer controller webhook"
}

resource "aws_vpc_security_group_egress_rule" "workers_to_workers" {
  security_group_id            = aws_security_group.workers.id
  referenced_security_group_id = aws_security_group.workers.id

  ip_protocol = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "workers_to_workers" {
  security_group_id            = aws_security_group.workers.id
  referenced_security_group_id = aws_security_group.workers.id

  ip_protocol = "-1"
}

resource "aws_vpc_security_group_egress_rule" "workers_https" {
  security_group_id = aws_security_group.workers.id
  cidr_ipv4         = "0.0.0.0/0"

  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "Allow outbound HTTPS for images and external services"
}

# The control plane may resolve in-cluster names through CoreDNS on workers.
resource "aws_vpc_security_group_egress_rule" "eks_to_dns" {
  for_each                     = toset(["tcp", "udp"])
  security_group_id            = aws_security_group.eks.id
  referenced_security_group_id = aws_security_group.workers.id
  from_port                    = 53
  to_port                      = 53
  ip_protocol                  = each.key
  description                  = "Allow EKS to reach worker DNS"
}

resource "aws_vpc_security_group_ingress_rule" "dns_from_eks" {
  for_each                     = toset(["tcp", "udp"])
  security_group_id            = aws_security_group.workers.id
  referenced_security_group_id = aws_security_group.eks.id
  from_port                    = 53
  to_port                      = 53
  ip_protocol                  = each.key
  description                  = "Allow worker DNS from EKS"
}

# Needed for AWS management APIs and downloads in a VPC-connected CloudShell.
# The same initial broad HTTPS trade-off as workers is tracked in NET-EGRESS-01.
resource "aws_vpc_security_group_egress_rule" "cloudshell_https" {
  security_group_id = aws_security_group.cloudshell.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "Allow CloudShell HTTPS through NAT"
}

resource "aws_vpc_security_group_egress_rule" "cloudshell_to_eks" {
  security_group_id            = aws_security_group.cloudshell.id
  referenced_security_group_id = aws_security_group.eks.id

  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "Allow cloudshell to contact the Kubernetes API"
}

resource "aws_vpc_security_group_ingress_rule" "eks_from_cloudshell" {
  security_group_id            = aws_security_group.eks.id
  referenced_security_group_id = aws_security_group.cloudshell.id

  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
  description = "Allow cloudshell to contact the Kubernetes API"
}
