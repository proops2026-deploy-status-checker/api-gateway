# aws_ec2 module

Wraps [`terraform-aws-modules/ec2-instance/aws`](https://registry.terraform.io/modules/terraform-aws-modules/ec2-instance/aws) (`~> 5.6`) with the proops2026 naming, tagging and security conventions.

## Usage

```hcl
module "api_server" {
  source = "../modules/aws_ec2"

  # Standard 6
  prefix      = "proops"
  project     = "dsc"
  environment = "dev"
  region_code = "usw2"
  region      = "us-west-2"
  tags        = local.tags

  # EC2-specific
  purpose       = "api-server"
  instance_type = "t3.micro"
}
```

`local.tags` (env layer) must contain `Project`, `Environment`, `ResponsibleParty`, `Owner`, `Email`.

## Inputs

| Name | Description | Type | Default | Required | Validation |
|---|---|---|---|---|---|
| prefix | Org / customer shortcode | string | - | yes | `^[a-z0-9]+$` |
| project | Project shortcode | string | - | yes | `^[a-z0-9]+$` |
| environment | Environment name | string | - | yes | `dev` / `test` / `prod` |
| region_code | Compact region code | string | - | yes | `^[a-z]{3,4}[0-9]$` (e.g. `usw2`) |
| region | Full AWS region | string | - | yes | e.g. `us-west-2` |
| tags | Common env-level tags | map(string) | - | yes | must include the 5 keys above |
| purpose | Suffix in resource name | string | - | yes | kebab-case, e.g. `api-server` |
| instance_type | EC2 instance type | string | `t3.micro` | no | `t3.*` only (lab budget guard) |
| subnet_id | Subnet ID | string | `null` (default VPC subnet) | no | - |
| vpc_security_group_ids | Security group IDs | list(string) | `null` (VPC default SG) | no | - |

## Outputs

| Name | Description |
|---|---|
| instance | Full ec2-instance module object (all upstream outputs) |
| id | EC2 instance ID |
| public_ip | Public IP |
| private_ip | Private IP |
| name | Generated resource name |

## Naming convention applied

```
{prefix}-{project}-{environment}-ec2-{region_code}-{purpose}
```

Example: `proops-dsc-dev-ec2-usw2-api-server`

## Tags applied

Both layers are applied to the instance **and** its root EBS volume (`volume_tags`).

| Layer | Source | Keys |
|---|---|---|
| 1 — common | `var.tags` from the env's `locals` | Project, Environment, ResponsibleParty, Owner, Email |
| 2 — per-resource | `merge()` in this module (wins on conflict) | Name, ApplicationRole (`EC2 <purpose>`), SensitiveData (`false`) |

## House rules (not configurable)

| Rule | Setting |
|---|---|
| IMDSv2 only | `http_tokens = "required"`, hop limit 1 |
| Encrypted root volume | gp3, 8 GiB, `encrypted = true` |
| AMI | Latest Amazon Linux 2023 (x86_64, non-minimal) via `data "aws_ami"` |

## Requirements

| Name | Version |
|---|---|
| terraform | `>= 1.6` |
| hashicorp/aws | `>= 5.0, < 6.0` — upstream v5 uses arguments removed in provider v6 |
