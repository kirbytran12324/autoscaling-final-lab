resource "aws_vpc" "lab" {
  cidr_block           = "10.30.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = {
    Name = "metronome-lab"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.lab.id
  }

  tags = {
    Name = "metronome-lab-private"
  }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id

  tags = {
    Name = "metronome-lab"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.30.11.0/24"
  availability_zone       = "ap-southeast-1a"
  map_public_ip_on_launch = false

  tags = {
    Name                              = "metronome-lab-private-a"
    "kubernetes.io/role/internal-elb" = "1"
  }
}


resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}



resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.30.1.0/24"
  availability_zone       = "ap-southeast-1a"
  map_public_ip_on_launch = false
  tags = {
    Name                     = "metronome-lab-public-a"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lab.id
  }
  tags = {
    Name = "metronome-lab-public"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_subnet" "private_b" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.30.12.0/24"
  availability_zone       = "ap-southeast-1b"
  map_public_ip_on_launch = false

  tags = {
    Name                              = "metronome-lab-private-b"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.30.2.0/24"
  availability_zone       = "ap-southeast-1b"
  map_public_ip_on_launch = false

  tags = {
    Name                     = "metronome-lab-public-b"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags = {
    Name = "metronome-lab-nat"
  }
}

resource "aws_nat_gateway" "lab" {
  allocation_id     = aws_eip.nat.id
  subnet_id         = aws_subnet.public_a.id
  connectivity_type = "public"
  availability_mode = "zonal"

  depends_on = [aws_internet_gateway.lab]
  tags = {
    Name = "metronome-lab-nat"
  }
}