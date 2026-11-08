#!/usr/bin/env bash
# Creates one gateway on AWS, in its own VPC, with the AWS CLI v2 and Docker:
#   - an ECR repository with the gateway image, built from gateway/ and pushed
#   - the gateway's credentials file in Secrets Manager
#   - a VPC with two public subnets, and NODES EC2 instances (Ubuntu 24.04) running the gateway
#     container, each with an Elastic IP so the console can push to it
#   - a Network Load Balancer in front of the connection handler port
#
#   AWS_REGION=eu-central-1 PREFIX=oauth GATEWAY=public ADMIN_CIDR=198.51.100.7/32 KEY_NAME=my-key \
#   CONSOLE_CIDR=203.0.113.10/32 CREDENTIALS_FILE=./public-credentials.json \
#     bash deploy/aws/provision-gateway.sh
#
# CONSOLE_CIDR is the console's outbound address (its Elastic IP): only it may reach the
# management port 9443. CREDENTIALS_FILE is downloaded from the gateway's page in the console.
#
# Optional:
#   NODES (2), INSTANCE_TYPE (t3.small), HANDLER_PORT (8443: the handler's port in the console),
#   PUBLIC_PORT (443), IMAGE_TAG (the gateway's package.json version), VPC_CIDR_PREFIX (10.41),
#   CERT_ARN       an ACM certificate: the load balancer then terminates TLS with it and forwards
#                  plain HTTP, so the handler in the console is "http". Without it the load
#                  balancer passes TCP through and the handler is "https".
#   MANAGEMENT_URL the console link (https://console.example.com:3443) for pull mode, instead of
#                  pushes; the nodes then need no inbound 9443.
#   SKIP_BUILD     true to use an image already in the repository.
#
# Run it once per gateway. To roll out a new image later, see deploy/cloud/gateway-node.sh.
set -euo pipefail

: "${AWS_REGION:?}" "${ADMIN_CIDR:?}" "${KEY_NAME:?}" "${CREDENTIALS_FILE:?the credentials file from the console}"
[[ -n "${MANAGEMENT_URL:-}" || -n "${CONSOLE_CIDR:-}" ]] || { echo "Set CONSOLE_CIDR (push) or MANAGEMENT_URL (pull)" >&2; exit 2; }
[[ -f "$CREDENTIALS_FILE" ]] || { echo "No file $CREDENTIALS_FILE" >&2; exit 2; }
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX=${PREFIX:-oauth}
GATEWAY=${GATEWAY:-gateway}
NAME="${PREFIX}-gw-${GATEWAY}"
NET=${VPC_CIDR_PREFIX:-10.41}
NODES=${NODES:-2}
INSTANCE_TYPE=${INSTANCE_TYPE:-t3.small}
HANDLER_PORT=${HANDLER_PORT:-8443}
PUBLIC_PORT=${PUBLIC_PORT:-443}
IMAGE_TAG=${IMAGE_TAG:-$(node -p "require('${REPO_ROOT}/gateway/package.json').version" 2>/dev/null || echo 1.0.0)}
export AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION AWS_PAGER=""

aws() { command aws --output text "$@"; }
tags() { echo "ResourceType=$1,Tags=[{Key=Name,Value=${NAME}-$2},{Key=Project,Value=${PREFIX}}]"; }
step() { echo; echo "==> $*"; }

ACCOUNT=$(aws sts get-caller-identity --query Account)
REGISTRY="${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
REPOSITORY="${PREFIX}/gateway"
IMAGE="${REGISTRY}/${REPOSITORY}:${IMAGE_TAG}"

step "Image ${IMAGE}"
aws ecr describe-repositories --repository-names "$REPOSITORY" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPOSITORY" --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 >/dev/null
if [[ "${SKIP_BUILD:-false}" != true ]]; then
  command aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
  docker build -t "$IMAGE" "${REPO_ROOT}/gateway"
  docker push "$IMAGE"
fi

step "Credentials in Secrets Manager: ${NAME}/credentials"
SECRET_ID="${NAME}/credentials"
if aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://${CREDENTIALS_FILE}" >/dev/null
else
  aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "file://${CREDENTIALS_FILE}" --tags "Key=Project,Value=${PREFIX}" >/dev/null
fi
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" --query ARN)
echo "    Stored. Delete the local copy once the nodes are up: it holds the gateway's private key."

step "Network: VPC ${NET}.0.0/16"
read -r AZ1 AZ2 _ <<<"$(aws ec2 describe-availability-zones --filters Name=state,Values=available --query 'AvailabilityZones[].ZoneName')"
VPC=$(aws ec2 create-vpc --cidr-block "${NET}.0.0/16" --tag-specifications "$(tags vpc net)" --query Vpc.VpcId)
aws ec2 modify-vpc-attribute --vpc-id "$VPC" --enable-dns-hostnames
IGW=$(aws ec2 create-internet-gateway --tag-specifications "$(tags internet-gateway net)" --query InternetGateway.InternetGatewayId)
aws ec2 attach-internet-gateway --vpc-id "$VPC" --internet-gateway-id "$IGW"
SUBNET_1=$(aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "${NET}.1.0/24" --availability-zone "$AZ1" --tag-specifications "$(tags subnet public-1)" --query Subnet.SubnetId)
SUBNET_2=$(aws ec2 create-subnet --vpc-id "$VPC" --cidr-block "${NET}.2.0/24" --availability-zone "$AZ2" --tag-specifications "$(tags subnet public-2)" --query Subnet.SubnetId)
ROUTES=$(aws ec2 create-route-table --vpc-id "$VPC" --tag-specifications "$(tags route-table public)" --query RouteTable.RouteTableId)
aws ec2 create-route --route-table-id "$ROUTES" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW" >/dev/null
for s in "$SUBNET_1" "$SUBNET_2"; do aws ec2 associate-route-table --route-table-id "$ROUTES" --subnet-id "$s" >/dev/null; done

step "Security group"
SG=$(aws ec2 create-security-group --vpc-id "$VPC" --group-name "$NAME" --description "OAuth gateway ${GATEWAY}" --tag-specifications "$(tags security-group nodes)" --query GroupId)
allow() { aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port "$1" --cidr "$2" >/dev/null; }
allow "$HANDLER_PORT" 0.0.0.0/0              # API traffic (the load balancer keeps the client's address)
allow 9080 "${NET}.0.0/16"                    # load balancer health checks: /readyz
allow 9445 "$ADMIN_CIDR"                      # admin UI
allow 22 "$ADMIN_CIDR"
[[ -n "${CONSOLE_CIDR:-}" ]] && allow 9443 "$CONSOLE_CIDR"   # console pushes (mTLS)

step "Instance role ${NAME} (pull the image, read the credentials, Session Manager)"
aws iam create-role --role-name "$NAME" --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
aws iam put-role-policy --role-name "$NAME" --policy-name read-credentials --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"${SECRET_ARN}\"}]}"
aws iam create-instance-profile --instance-profile-name "$NAME" >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name "$NAME" --role-name "$NAME"
sleep 15   # a new instance profile takes a moment before EC2 accepts it

step "Nodes: ${NODES} x ${INSTANCE_TYPE}"
AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value)
INSTANCES=()
NODE_URLS=()
for i in $(seq 1 "$NODES"); do
  subnet=$SUBNET_1; (( i % 2 == 0 )) && subnet=$SUBNET_2
  user_data="$(mktemp)"
  {
    echo "#!/usr/bin/env bash"
    printf 'CLOUD=aws\nREGION=%q\nIMAGE=%q\nNODE_NAME=%q\nHANDLER_PORTS=%q\nCREDENTIALS=%q\nMANAGEMENT_URL=%q\n' \
      "$AWS_REGION" "$IMAGE" "gw-${i}" "$HANDLER_PORT" "$SECRET_ID" "${MANAGEMENT_URL:-}"
    echo "export CLOUD REGION IMAGE NODE_NAME HANDLER_PORTS CREDENTIALS MANAGEMENT_URL"
    cat "${REPO_ROOT}/deploy/cloud/gateway-node.sh"
  } > "$user_data"
  id=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
    --subnet-id "$subnet" --security-group-ids "$SG" --iam-instance-profile "Name=${NAME}" \
    --metadata-options HttpTokens=required \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=16,VolumeType=gp3,Encrypted=true}' \
    --user-data "file://${user_data}" \
    --tag-specifications "$(tags instance "gw-${i}")" "$(tags volume "gw-${i}")" \
    --query 'Instances[0].InstanceId')
  rm -f "$user_data"
  INSTANCES+=("$id")
done
aws ec2 wait instance-running --instance-ids "${INSTANCES[@]}"
for i in "${!INSTANCES[@]}"; do
  allocation=$(aws ec2 allocate-address --domain vpc --tag-specifications "$(tags elastic-ip "gw-$((i + 1))")" --query AllocationId)
  aws ec2 associate-address --allocation-id "$allocation" --instance-id "${INSTANCES[$i]}" >/dev/null
  ip=$(aws ec2 describe-addresses --allocation-ids "$allocation" --query 'Addresses[0].PublicIp')
  NODE_URLS+=("gw-$((i + 1))  https://${ip}:9443  (admin UI https://${ip}:9445)")
done

step "Network Load Balancer: ${PUBLIC_PORT} -> ${HANDLER_PORT}"
LB=$(aws elbv2 create-load-balancer --name "$NAME" --type network --scheme internet-facing --subnets "$SUBNET_1" "$SUBNET_2" \
  --tags "Key=Project,Value=${PREFIX}" --query 'LoadBalancers[0].LoadBalancerArn')
TG=$(aws elbv2 create-target-group --name "${NAME}-${HANDLER_PORT}" --protocol TCP --port "$HANDLER_PORT" --vpc-id "$VPC" \
  --target-type instance --health-check-protocol HTTP --health-check-port 9080 --health-check-path /readyz \
  --query 'TargetGroups[0].TargetGroupArn')
aws elbv2 register-targets --target-group-arn "$TG" --targets $(printf 'Id=%s ' "${INSTANCES[@]}")
if [[ -n "${CERT_ARN:-}" ]]; then
  aws elbv2 create-listener --load-balancer-arn "$LB" --protocol TLS --port "$PUBLIC_PORT" --certificates "CertificateArn=${CERT_ARN}" \
    --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 --default-actions "Type=forward,TargetGroupArn=${TG}" >/dev/null
  HANDLER_PROTOCOL=http
else
  aws elbv2 create-listener --load-balancer-arn "$LB" --protocol TCP --port "$PUBLIC_PORT" --default-actions "Type=forward,TargetGroupArn=${TG}" >/dev/null
  HANDLER_PROTOCOL=https
fi
LB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$LB" --query 'LoadBalancers[0].DNSName')

cat <<EOF

Done. The nodes install Docker and start the gateway in the next few minutes.
  Load balancer  ${LB_DNS}  (port ${PUBLIC_PORT})
  Nodes:
$(printf '    %s\n' "${NODE_URLS[@]}")

Next, in the console (gateway "${GATEWAY}"):
  1. The handler: port ${HANDLER_PORT}, protocol ${HANDLER_PROTOCOL}.
  2. $( [[ -n "${MANAGEMENT_URL:-}" ]] && echo "Pull mode: the nodes register themselves under Nodes." || echo "Add each node address above (https://<ip>:9443) under Nodes. The console checks it at once." )
  3. Attach the catalog and push.
  4. DNS: point your API name (e.g. api.example.com) at ${LB_DNS} (a CNAME), and set it as the
     gateway's public URL.
EOF
