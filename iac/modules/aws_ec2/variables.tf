# ===== STANDARD MODULE CONTRACT (every module takes these) =====

variable "prefix" {
  description = "Org or customer shortcode used in resource names (e.g. 'proops')"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+$", var.prefix))
    error_message = "prefix must be lowercase letters and digits only (no '-' or '_'): it is one segment of the resource name."
  }
}

variable "project" {
  description = "Project shortcode (e.g. 'dsc' for Deploy Status Checker)"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+$", var.project))
    error_message = "project must be lowercase letters and digits only (no '-' or '_'): it is one segment of the resource name."
  }
}

variable "environment" {
  description = "Environment name: dev / test / prod"
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "Environment must be one of: dev, test, prod."
  }
}

variable "region_code" {
  description = "Compact region code (e.g. 'usw2' for us-west-2)"
  type        = string

  validation {
    condition     = can(regex("^[a-z]{3,4}[0-9]$", var.region_code))
    error_message = "region_code must be the compact form, e.g. 'usw2', 'apse2', 'euc1' (not the full region name)."
  }
}

variable "region" {
  description = "Full AWS region name (e.g. 'us-west-2'). Used by data sources."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.region))
    error_message = "region must be a full AWS region name, e.g. 'us-west-2'."
  }
}

variable "tags" {
  description = "Common tags applied to every resource (Project, Environment, ResponsibleParty, Owner, Email)"
  type        = map(string)

  validation {
    condition = alltrue([
      for k in ["Project", "Environment", "ResponsibleParty", "Owner", "Email"] : contains(keys(var.tags), k)
    ])
    error_message = "tags must include Project, Environment, ResponsibleParty, Owner and Email (Owner + Email are required by the account IAM policy at create time)."
  }
}

# ===== EC2-SPECIFIC INPUTS =====

variable "purpose" {
  description = "What this EC2 is for — used in the name suffix (e.g. 'api-server', 'vpn')"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", var.purpose))
    error_message = "purpose must be lowercase kebab-case, e.g. 'api-server'."
  }
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"

  validation {
    condition     = can(regex("^t3\\.", var.instance_type))
    error_message = "Lab budget guard: only t3.* instance types are allowed."
  }
}

variable "vpc_security_group_ids" {
  description = "List of security group IDs to attach (null = VPC default SG)"
  type        = list(string)
  # null, not []: [] means "manage as empty", so every plan tries to strip the default SG AWS attached.
  default = null
}

variable "subnet_id" {
  description = "Subnet ID where the instance is launched (null = a default subnet of the default VPC)"
  type        = string
  default     = null
}
