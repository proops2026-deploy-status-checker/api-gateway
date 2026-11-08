locals {
  # Layer 1 — common tags for every resource in this env (Owner + Email are required by the account IAM policy)
  tags = {
    Project          = var.project
    Environment      = var.environment
    ResponsibleParty = var.responsible_party
    Owner            = var.owner
    Email            = var.owner_email
  }
}

module "api_server" {
  source = "../modules/aws_ec2"

  prefix      = var.prefix
  project     = var.project
  environment = var.environment
  region_code = var.region_code
  region      = var.region
  tags        = local.tags

  purpose       = var.purpose
  instance_type = var.instance_type
}
