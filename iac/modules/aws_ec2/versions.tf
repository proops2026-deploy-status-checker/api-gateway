terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Upper bound is required: ec2-instance v5 uses arguments removed in AWS provider v6 (cpu_core_count, block_duration_minutes).
      version = ">= 5.0, < 6.0"
    }
  }
}
