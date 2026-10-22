terraform {
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "aws_region" {
  description = "AWS Region for this learning lab."
  type        = string
  default     = "ap-southeast-1"

  validation {
    condition     = var.aws_region == "ap-southeast-1"
    error_message = "This lab pins Singapore AZs and AMIs. Review those pins before changing Region."
  }
}

variable "aws_account_id" {
  description = "Expected account; the provider refuses another account."
  type        = string
  default     = "206690614118"
}

provider "aws" {
  profile             = "metronome-terraform"
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Lab       = "metronome-lab"
      ManagedBy = "Terraform"
    }
  }
}

# This data source reads existing VPCs.
data "aws_vpcs" "visible" {}

output "vpc_ids" {
  description = "VPCs visible in the selected account and Region."
  value       = sort(tolist(data.aws_vpcs.visible.ids))
}
