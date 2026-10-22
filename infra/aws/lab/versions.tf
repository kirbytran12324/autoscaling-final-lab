# Read-only discovery in ap-southeast-1 on 2026-10-19. Review updates deliberately;
# the provider lock file does not pin Kubernetes, AMIs, or add-on versions.
locals {
  cluster_name       = "metronome-lab"
  kubernetes_version = "1.35"
  worker_ami_id      = "ami-005f6394d3840116a"
  worker_ami_release = "1.35.8-20261012"
  addon_versions = {
    vpc-cni                = "v1.22.4-eksbuild.3"
    kube-proxy             = "v1.35.3-eksbuild.52"
    coredns                = "v1.13.2-eksbuild.51"
    eks-pod-identity-agent = "v1.3.10-eksbuild.3"
  }
}

# This is a public AWS image, not a custom AMI. The node group still selects the
# managed EKS AMI by release_version; this lookup verifies its root-device name.
data "aws_ami" "worker" {
  owners = ["602401143452"]
  filter {
    name   = "image-id"
    values = [local.worker_ami_id]
  }
}
