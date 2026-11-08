terraform {
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state: shared by laptop + CI runners (an ephemeral runner would lose local state).
  # Bucket bootstrapped once by CLI (versioning, SSE, public access blocked). use_lockfile = S3-native
  # locking (.tflock object), needs Terraform >= 1.10; no DynamoDB table.
  backend "s3" {
    bucket       = "proops2026-dsc-tfstate-868737222758"
    key          = "api-gateway/dev/terraform.tfstate"
    region       = "us-west-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
}
