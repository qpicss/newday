#!/usr/bin/env bash
# Creates the console (management) side on AWS with the AWS CLI v2:
#   - a VPC with two public subnets (the console VM) and two private subnets (the database)
#   - Amazon RDS for MySQL in the private subnets, encrypted, with 7 days of backups
#   - the console's secrets in SSM Parameter Store (JWT_SECRET, PKI_MASTER_KEY, DB_*)
#   - an Ubuntu 24.04 EC2 instance with an Elastic IP and an instance role that may read them
#
#   AWS_REGION=eu-central-1 PREFIX=oauth ADMIN_CIDR=198.51.100.7/32 KEY_NAME=my-key \
#     bash deploy/aws/provision-console.sh
#
# Optional: INSTANCE_TYPE (t3.small), DB_CLASS (db.t4g.micro), DB_ENGINE_VERSION (8.4),
# CONSOLE_DOMAIN (used in the printed next steps), MULTI_AZ (false), VPC_CIDR_PREFIX (10.40),
# LINK_CIDRS (pull-mode gateway addresses allowed to reach the link on 3443, space-separated;
# none by default).
#
# Run it once per environment: it creates new resources every time. Existing secrets are kept,
# so a second run never replaces JWT_SECRET or PKI_MASTER_KEY. It prints what to do next.
set -euo pipefail

: "${AWS_REGION:?set AWS_REGION}" "${ADMIN_CIDR:?set ADMIN_CIDR to your address, e.g. 198.51.100.7/32}" "${KEY_NAME:?set KEY_NAME to an EC2 key pair}"
PREFIX=${PREFIX:-oauth}
NET=${VPC_CIDR_PREFIX:-10.40}
INSTANCE_TYPE=${INSTANCE_TYPE:-t3.small}
DB_CLASS=${DB_CLASS:-db.t4g.micro}
DB_ENGINE_VERSION=${DB_ENGINE_VERSION:-8.4}
DB_NAME=newday
DB_USER=oauthadmin
CONSOLE_DOMAIN=${CONSOLE_DOMAIN:-console.example.com}
export AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION AWS_PAGER=""

aws() { command aws --output text "$@"; }
tags() { echo "ResourceType=$1,Tags=[{Key=Name,Value=${PREFIX}-$2},{Key=Project,Value=${PREFIX}}]"; }
step() { echo; echo "==> $*"; }

ACCOUNT=$(aws sts get-caller-identity --query Account)
read -r AZ1 AZ2 _ <<<"$(aws ec2 describe-availability-zones --filters Name=state,Values=available --query 'AvailabilityZones[].ZoneName')"

step "Network: VPC ${NET}.0.0/16 in ${AZ1} and ${AZ2}"
VPC=$(aws ec2 create-vpc --cidr-block "${NET}.0.0/16" --tag-specifications "$(tags vpc console)" --query Vpc.VpcId)
aws ec2 modify-vpc-attribute --vpc-id "$VPC" --enable-dns-hostnames
IGW=$(aws ec2 create-internet-gateway --tag-specifications "$(tags internet-gateway console)" --query InternetGateway.InternetGatewayId)
aws ec2 attach-internet-gateway --vpc-id "$VPC" --internet-gateway-id "$IGW"
subnet() { aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "$1" --availability-zone "$2" --tag-specifications "$(tags subnet "$3")" --query Subnet.SubnetId; }
PUBLIC_1=$(subnet "${NET}.1.0/24" "$AZ1" console-public-1)
PUBLIC_2=$(subnet "${NET}.2.0/24" "$AZ2" console-public-2)
PRIVATE_1=$(subnet "${NET}.11.0/24" "$AZ1" console-db-1)
PRIVATE_2=$(subnet "${NET}.12.0/24" "$AZ2" console-db-2)
ROUTES=$(aws ec2 create-route-table --vpc-id "$VPC" --tag-specifications "$(tags route-table console-public)" --query RouteTable.RouteTableId)
aws ec2 create-route --route-table-id "$ROUTES" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW" >/dev/null
for s in "$PUBLIC_1" "$PUBLIC_2"; do aws ec2 associate-route-table --route-table-id "$ROUTES" --subnet-id "$s" >/dev/null; done

step "Security groups"
CONSOLE_SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name "${PREFIX}-console" --description "OAuth console" --tag-specifications "$(tags security-group console)" --query GroupId)
aws ec2 authorize-security-group-ingress --group-id "$CONSOLE_SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
aws ec2 authorize-security-group-ingress --group-id "$CONSOLE_SG" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null   # certificate renewals, redirect
aws ec2 authorize-security-group-ingress --group-id "$CONSOLE_SG" --protocol tcp --port 22 --cidr "$ADMIN_CIDR" >/dev/null
for cidr in ${LINK_CIDRS:-}; do
  aws ec2 authorize-security-group-ingress --group-id "$CONSOLE_SG" --protocol tcp --port 3443 --cidr "$cidr" >/dev/null
done
DB_SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name "${PREFIX}-console-db" --description "OAuth console database" --tag-specifications "$(tags security-group console-db)" --query GroupId)
aws ec2 authorize-security-group-ingress --group-id "$DB_SG" --protocol tcp --port 3306 --source-group "$CONSOLE_SG" >/dev/null

step "Secrets in SSM Parameter Store under /${PREFIX}/console/"
param_exists() { aws ssm get-parameter --name "/${PREFIX}/console/$1" --query Parameter.Name >/dev/null 2>&1; }
put_once() {
  if param_exists "$1"; then echo "    $1 exists, kept"; return; fi
  aws ssm put-parameter --name "/${PREFIX}/console/$1" --type "$2" --value "$3" >/dev/null
  echo "    $1 created"
}
put_once JWT_SECRET SecureString "$(openssl rand -base64 48 | tr -d '\n')"
put_once PKI_MASTER_KEY SecureString "$(openssl rand -base64 32)"
put_once DB_PASSWORD SecureString "$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 32)"
put_once DB_USER String "$DB_USER"
put_once DB_NAME String "$DB_NAME"
DB_PASSWORD=$(aws ssm get-parameter --with-decryption --name "/${PREFIX}/console/DB_PASSWORD" --query Parameter.Value)

step "RDS for MySQL ${DB_ENGINE_VERSION} (${DB_CLASS}); this takes 5 to 15 minutes"
aws rds create-db-subnet-group --db-subnet-group-name "${PREFIX}-console-db" --db-subnet-group-description "OAuth console database" \
  --subnet-ids "$PRIVATE_1" "$PRIVATE_2" >/dev/null
multi_az=--no-multi-az; [[ "${MULTI_AZ:-false}" == true ]] && multi_az=--multi-az
aws rds create-db-instance --db-instance-identifier "${PREFIX}-console-db" \
  --engine mysql --engine-version "$DB_ENGINE_VERSION" --db-instance-class "$DB_CLASS" \
  --allocated-storage 20 --storage-type gp3 --storage-encrypted \
  --master-username "$DB_USER" --master-user-password "$DB_PASSWORD" --db-name "$DB_NAME" \
  --vpc-security-group-ids "$DB_SG" --db-subnet-group-name "${PREFIX}-console-db" --no-publicly-accessible \
  --backup-retention-period 7 --deletion-protection --copy-tags-to-snapshot "$multi_az" \
  --tags "Key=Project,Value=${PREFIX}" >/dev/null

step "Instance role ${PREFIX}-console (Session Manager, and read /${PREFIX}/console/*)"
aws iam create-role --role-name "${PREFIX}-console" --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam attach-role-policy --role-name "${PREFIX}-console" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam put-role-policy --role-name "${PREFIX}-console" --policy-name read-console-settings --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParameters\"],
    \"Resource\":\"arn:aws:ssm:${AWS_REGION}:${ACCOUNT}:parameter/${PREFIX}/console/*\"}]}"
aws iam create-instance-profile --instance-profile-name "${PREFIX}-console" >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name "${PREFIX}-console" --role-name "${PREFIX}-console"
sleep 15   # a new instance profile takes a moment before EC2 accepts it

step "EC2 instance (${INSTANCE_TYPE}, Ubuntu 24.04)"
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value)
INSTANCE=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
  --subnet-id "$PUBLIC_1" --security-group-ids "$CONSOLE_SG" --iam-instance-profile "Name=${PREFIX}-console" \
  --metadata-options HttpTokens=required \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true}' \
  --tag-specifications "$(tags instance console)" "$(tags volume console)" \
  --query 'Instances[0].InstanceId')
aws ec2 wait instance-running --instance-ids "$INSTANCE"
ALLOCATION=$(aws ec2 allocate-address --domain vpc --tag-specifications "$(tags elastic-ip console)" --query AllocationId)
aws ec2 associate-address --allocation-id "$ALLOCATION" --instance-id "$INSTANCE" >/dev/null
CONSOLE_IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOCATION" --query 'Addresses[0].PublicIp')

step "Waiting for the database"
aws rds wait db-instance-available --db-instance-identifier "${PREFIX}-console-db"
DB_HOST=$(aws rds describe-db-instances --db-instance-identifier "${PREFIX}-console-db" --query 'DBInstances[0].Endpoint.Address')
put_once DB_HOST String "$DB_HOST"

cat <<EOF

Done.
  VPC              ${VPC}
  Console instance ${INSTANCE}, Elastic IP ${CONSOLE_IP}
  Security group   ${CONSOLE_SG} (console), ${DB_SG} (database)
  Database         ${DB_HOST}
  Secrets          /${PREFIX}/console/* in SSM Parameter Store

Next:
  1. DNS: point your console name (e.g. ${CONSOLE_DOMAIN}) at ${CONSOLE_IP} (an A record).
  2. Copy the code and install (from your machine, in the repository):
       git archive --format=tar.gz -o oauth.tar.gz HEAD
       scp oauth.tar.gz ubuntu@${CONSOLE_IP}:
       ssh ubuntu@${CONSOLE_IP} 'mkdir -p oauth && tar -xzf oauth.tar.gz -C oauth'
       ssh ubuntu@${CONSOLE_IP} 'cd oauth && sudo bash deploy/console/install.sh --domain ${CONSOLE_DOMAIN} --email ops@example.com'
       ssh ubuntu@${CONSOLE_IP} 'cd oauth && sudo CLOUD=aws REGION=${AWS_REGION} PREFIX=${PREFIX} DOMAIN=${CONSOLE_DOMAIN} bash deploy/cloud/console-env.sh'
       ssh ubuntu@${CONSOLE_IP} 'sudo systemctl enable --now oauth-console'
  3. Gateways connect from ${CONSOLE_IP}: pass CONSOLE_CIDR=${CONSOLE_IP}/32 to the gateway script.
EOF
