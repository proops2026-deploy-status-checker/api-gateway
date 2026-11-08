output "instance" {
  description = "The full ec2-instance module object (all of its outputs)"
  value       = module.ec2
}

output "id" {
  description = "EC2 instance ID"
  value       = module.ec2.id
}

output "public_ip" {
  description = "Public IP of the instance"
  value       = module.ec2.public_ip
}

output "private_ip" {
  description = "Private IP of the instance"
  value       = module.ec2.private_ip
}

output "name" {
  description = "Resource name produced by the convention"
  value       = local.name
}
