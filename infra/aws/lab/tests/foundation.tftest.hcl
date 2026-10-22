mock_provider "aws" {
  mock_data "aws_ami" {
    defaults = {
      root_device_name = "/dev/xvda"
      architecture     = "x86_64"
      state            = "available"
    }
  }
}

variables {
  admin_ipv4_cidr = "192.0.2.10/32"
}

run "foundation_boundaries" {
  command = plan

  assert {
    condition     = aws_eks_node_group.workers.scaling_config[0].desired_size == 2 && aws_eks_node_group.workers.scaling_config[0].max_size == 2
    error_message = "Baseline worker capacity must remain fixed at two."
  }
  assert {
    condition     = aws_eks_cluster.lab.vpc_config[0].endpoint_private_access && aws_eks_cluster.lab.vpc_config[0].public_access_cidrs == toset([var.admin_ipv4_cidr])
    error_message = "Private API access and the administrator-only public CIDR must be preserved."
  }
  assert {
    condition     = !aws_eks_cluster.lab.access_config[0].bootstrap_cluster_creator_admin_permissions && aws_eks_cluster.lab.access_config[0].authentication_mode == "API"
    error_message = "Cluster administration must come from explicit access entries."
  }
  assert {
    condition     = aws_launch_template.workers.metadata_options[0].http_tokens == "required" && aws_launch_template.workers.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "Ordinary Pods must not depend on node IMDS credentials."
  }
  assert {
    condition     = jsondecode(aws_eks_addon.before_workers["vpc-cni"].configuration_values).enableNetworkPolicy == "true"
    error_message = "NetworkPolicy enforcement support must be enabled."
  }
  assert {
    condition     = jsondecode(aws_iam_role.vpc_cni.assume_role_policy).Statement[0].Condition.StringEquals["aws:RequestTag/kubernetes-service-account"] == "aws-node"
    error_message = "The CNI identity must be limited to its service account."
  }
}

run "reject_open_admin_api" {
  command = plan
  variables { admin_ipv4_cidr = "0.0.0.0/0" }
  expect_failures = [var.admin_ipv4_cidr]
}

run "reject_unreviewed_region" {
  command = plan
  variables { aws_region = "eu-west-1" }
  expect_failures = [var.aws_region]
}
