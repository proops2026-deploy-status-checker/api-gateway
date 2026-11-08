# Same filter as Day 20: "2023.*-kernel-*" excludes the al2023-ami-minimal-* images that "al2023-ami-*" would also match.
data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  name = "${var.prefix}-${var.project}-${var.environment}-ec2-${var.region_code}-${var.purpose}"

  tags = merge(var.tags, {
    Name            = local.name
    ApplicationRole = "EC2 ${var.purpose}"
    SensitiveData   = "false"
  })
}

module "ec2" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "~> 5.6"

  name = local.name

  ami           = data.aws_ami.amazon_linux.id
  instance_type = var.instance_type

  vpc_security_group_ids = var.vpc_security_group_ids
  subnet_id              = var.subnet_id

  # House rules: deliberately not exposed as variables, so callers cannot turn them off.
  metadata_options = {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device = [
    {
      volume_type = "gp3"
      volume_size = 8
      encrypted   = true
    }
  ]

  tags = local.tags

  # Upstream builds volume_tags from var.volume_tags, not var.tags — without this the root EBS volume gets only Name.
  volume_tags = local.tags
}
