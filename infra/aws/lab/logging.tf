resource "aws_cloudwatch_log_group" "vpc_flow" {
  name              = "/metronome/lab/vpc-flow"
  retention_in_days = 7

  tags = {
    Name = "metronome-lab-vpc-flow"
  }
}

resource "aws_iam_role" "vpc_flow" {
  name = "metronome-lab-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "vpc-flow-logs.amazonaws.com"
      }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.aws_account_id
        }
        ArnLike = {
          "aws:SourceArn" = "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:vpc-flow-log/*"
        }
      }
    }]
  })

  tags = {
    Name = "metronome-lab-flow-logs"
  }
}

resource "aws_iam_role_policy" "vpc_flow" {
  name = "publish-vpc-flow-logs"
  role = aws_iam_role.vpc_flow.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = [
          aws_cloudwatch_log_group.vpc_flow.arn,
          "${aws_cloudwatch_log_group.vpc_flow.arn}:*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = "logs:DescribeLogGroups"
        Resource = "*"
      }
    ]
  })
}

resource "aws_flow_log" "lab" {
  vpc_id                   = aws_vpc.lab.id
  iam_role_arn             = aws_iam_role.vpc_flow.arn
  log_destination          = aws_cloudwatch_log_group.vpc_flow.arn
  log_destination_type     = "cloud-watch-logs"
  traffic_type             = "ALL"
  max_aggregation_interval = 60

  depends_on = [aws_iam_role_policy.vpc_flow]

  tags = {
    Name = "metronome-lab-vpc-flow"
  }
}

resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.cluster_name}/cluster"
  retention_in_days = 7
  tags              = { Name = "metronome-lab-eks" }
}
