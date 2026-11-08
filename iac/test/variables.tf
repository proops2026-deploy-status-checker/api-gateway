variable "prefix" {
  description = "Org shortcode used in resource names"
  type        = string
}

variable "project" {
  description = "Project shortcode used in resource names"
  type        = string
}

variable "environment" {
  description = "Environment name: dev / test / prod"
  type        = string
}

variable "region_code" {
  description = "Compact region code (e.g. 'usw2')"
  type        = string
}

variable "region" {
  description = "Full AWS region name (e.g. 'us-west-2')"
  type        = string
}

variable "responsible_party" {
  description = "Team / escalation contact email (ResponsibleParty tag)"
  type        = string
}

variable "owner" {
  description = "Trainee ID of the resource owner (Owner tag, required by IAM policy)"
  type        = string
}

variable "owner_email" {
  description = "Owner email (Email tag, required by IAM policy)"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for the API server"
  type        = string
  default     = "t3.micro"
}

variable "purpose" {
  description = "Purpose suffix in the API server's name"
  type        = string
  default     = "api-server"
}
