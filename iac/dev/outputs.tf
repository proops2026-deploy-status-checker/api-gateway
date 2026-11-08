output "api_server_name" {
  description = "Convention-built name of the API server"
  value       = module.api_server.name
}

output "api_server_public_ip" {
  description = "Public IP of the API server"
  value       = module.api_server.public_ip
}

output "api_server_id" {
  description = "EC2 instance ID of the API server"
  value       = module.api_server.id
}
