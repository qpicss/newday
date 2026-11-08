# Deploy on AWS

Step by step: the console on EC2 with RDS for MySQL, and a gateway in its own VPC with EC2 nodes behind a Network Load Balancer. Read [Deploying to the cloud](cloud-deployment.md) first for the plan, the architecture and the network rules.

## What you get

| Part | AWS resources | Script |
|---|---|---|
| Console | VPC `10.40.0.0/16`, EC2 `t3.small` (Ubuntu 24.04) with an Elastic IP, RDS for MySQL `db.t4g.micro` in private subnets, SSM parameters `/<prefix>/console/*`, an instance role | `deploy/aws/provision-console.sh` |
| Gateway | ECR repository `<prefix>/gateway`, a Secrets Manager secret with the credentials, VPC `10.41.0.0/16`, 2 × EC2 `t3.small` with Elastic IPs in two zones, a Network Load Balancer, an instance role | `deploy/aws/provision-gateway.sh` |

Both instance roles include `AmazonSSMManagedInstanceCore`, so you can also reach the VMs with Session Manager (`aws ssm start-session --target <instance id>`) and close port 22.

## Before you start

- AWS CLI v2, signed in with rights to create VPCs, EC2, RDS, IAM roles, SSM parameters, Secrets Manager secrets, ECR repositories and load balancers: `aws sts get-caller-identity`.
- Docker on your machine, to build the gateway image.
- An EC2 key pair in the region: `aws ec2 create-key-pair --key-name oauth --query KeyMaterial --output text > oauth.pem && chmod 600 oauth.pem`.
- DNS for two names you control, such as `console.example.com` and `api.example.com`.

Set these once in your shell, from the repository root:

```bash
export AWS_REGION=eu-central-1
export PREFIX=oauth
export ADMIN_CIDR="$(curl -s https://checkip.amazonaws.com)/32"
export KEY_NAME=oauth
export CONSOLE_DOMAIN=console.example.com
```

## 1. Create the console's infrastructure

```bash
bash deploy/aws/provision-console.sh
```

It takes 10 to 20 minutes, mostly waiting for RDS, and prints the console's Elastic IP and the next commands. In order, it:

1. Creates the VPC: two public subnets for the VM, two private ones for the database, an internet gateway and routes.
2. Creates the security groups:
   - console: 80 and 443 from anywhere, 22 from `ADMIN_CIDR`, and 3443 from `LINK_CIDRS` (pull mode only);
   - database: 3306 from the console's group only.
3. Generates `JWT_SECRET`, `PKI_MASTER_KEY` and the database password into SSM Parameter Store as `SecureString`. It keeps any that already exist.
4. Creates RDS for MySQL 8.4: encrypted, not public, with 7 days of automated backups and deletion protection. Add `MULTI_AZ=true` for a standby in a second zone.
5. Creates an instance role that may read only `/<prefix>/console/*`.
6. Starts the EC2 instance with IMDSv2 and an encrypted disk, and gives it an Elastic IP.

If RDS refuses the engine version, list the ones offered and pass one:

```bash
aws rds describe-db-engine-versions --engine mysql --query 'DBEngineVersions[].EngineVersion' --output text
DB_ENGINE_VERSION=8.0.40 bash deploy/aws/provision-console.sh
```

Then create a DNS **A** record: `console.example.com` → the Elastic IP. With Route 53:

```bash
aws route53 change-resource-record-sets --hosted-zone-id <zone id> --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
  "Name":"console.example.com","Type":"A","TTL":300,"ResourceRecords":[{"Value":"<elastic ip>"}]}}]}'
```

## 2. Install the console

From the repository on your machine:

```bash
CONSOLE_IP=<elastic ip>
git archive --format=tar.gz -o oauth.tar.gz HEAD
scp -i oauth.pem oauth.tar.gz ubuntu@$CONSOLE_IP:
ssh -i oauth.pem ubuntu@$CONSOLE_IP
```

On the VM:

```bash
mkdir -p oauth && tar -xzf oauth.tar.gz -C oauth && cd oauth
# Node.js 20, the oauth-console service, nginx and a Let's Encrypt certificate (DNS must point here)
sudo bash deploy/console/install.sh --domain console.example.com --email ops@example.com
# console.env from SSM: secrets, the RDS endpoint, DB_SSL with Amazon's CA bundle, APP_URL, TRUST_PROXY
sudo CLOUD=aws REGION=eu-central-1 PREFIX=oauth DOMAIN=console.example.com bash deploy/cloud/console-env.sh
sudo systemctl enable --now oauth-console
journalctl -u oauth-console -f     # "Database connected successfully", "Gateway link listening on port 3443"
```

Open `https://console.example.com`, register, and make yourself platform admin: see [First platform admin](cloud-deployment.md#first-platform-admin).

For invitation emails, add the SMTP settings to `/etc/oauth-console/console.env` and restart. With Amazon SES: `SMTP_HOST=email-smtp.eu-central-1.amazonaws.com`, `SMTP_PORT=587`, plus the SES SMTP user and password.

## 3. Prepare the gateway in the console

1. Sign in as an org admin. Open **Gateways → New gateway**, named `public`, with the public URL `https://api.example.com`.
2. Add a connection handler on port `8443`:
   - with an ACM certificate on the load balancer (step 4): protocol **http**;
   - without one: protocol **https** with your certificate for `api.example.com` (**Custom certificate**).
3. **Download credentials** to `public-credentials.json`.

Or with the API: see [Connect a gateway with the API](cloud-deployment.md#connect-a-gateway-with-the-api).

## 4. Optional: a certificate for the API name

To let the Network Load Balancer end TLS, request a public certificate in ACM and validate it through DNS:

```bash
CERT_ARN=$(aws acm request-certificate --domain-name api.example.com --validation-method DNS --query CertificateArn --output text)
aws acm describe-certificate --certificate-arn $CERT_ARN --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
# create that CNAME record, then:
aws acm wait certificate-validated --certificate-arn $CERT_ARN
export CERT_ARN
```

## 5. Create the gateway's infrastructure

```bash
CONSOLE_CIDR=<console elastic ip>/32 GATEWAY=public CREDENTIALS_FILE=./public-credentials.json \
  bash deploy/aws/provision-gateway.sh
```

In order, it:

1. Creates the ECR repository, builds `gateway/` with Docker and pushes it as `<account>.dkr.ecr.<region>.amazonaws.com/oauth/gateway:<version>`. With `SKIP_BUILD=true` and `IMAGE_TAG`, it uses an image that is already there.
2. Stores the credentials file in Secrets Manager as `oauth-gw-public/credentials`.
3. Creates a separate VPC with two public subnets in two zones.
4. Creates the security group:
   - 8443 from anywhere;
   - 9080 from the VPC (health checks);
   - 9443 from `CONSOLE_CIDR` only;
   - 9445 and 22 from `ADMIN_CIDR`.
5. Creates an instance role that may pull from ECR and read only that secret.
6. Starts the nodes (`NODES=2`), each with an Elastic IP. Their user data is `deploy/cloud/gateway-node.sh`: it installs Docker, writes the credentials from Secrets Manager and starts the container `gateway`.
7. Creates the Network Load Balancer:
   - port 443 to 8443 on the nodes, with health checks on `/readyz` at 9080;
   - a TLS listener with `CERT_ARN`, or TCP passthrough without it.

Delete the local credentials file once the nodes are up: `rm public-credentials.json`.

Check a node (it starts within about 3 minutes):

```bash
ssh -i oauth.pem ubuntu@<node ip> 'sudo docker ps --filter name=gateway; curl -s localhost:9080/healthz'
# or without SSH: aws ssm start-session --target <instance id>
```

## 6. Connect and deploy

1. On the gateway's page in the console, add the node addresses the script printed: `https://<node ip>:9443`. The console checks each one.
2. Attach the catalog, turn on auto-push, and click **Push configuration**.
3. Create a DNS **CNAME**: `api.example.com` → the load balancer's DNS name.
4. Check the target group turns healthy:

   ```bash
   aws elbv2 describe-target-health --target-group-arn $(aws elbv2 describe-target-groups --names oauth-gw-public-8443 --query 'TargetGroups[0].TargetGroupArn' --output text) \
     --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output text
   ```

5. Run the checks of [Phase 7](cloud-deployment.md#phase-7-verify).

## Update the gateways

Build and push a new tag, then move the nodes one at a time with SSM Run Command (no SSH needed):

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
IMAGE=$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/oauth/gateway:1.1.0
aws ecr get-login-password | docker login --username AWS --password-stdin ${IMAGE%%/*}
docker build -t $IMAGE gateway && docker push $IMAGE

for id in $(aws ec2 describe-instances --output text --query 'Reservations[].Instances[].InstanceId' \
    --filters "Name=tag:Name,Values=oauth-gw-public-gw-*" Name=instance-state-name,Values=running); do
  cmd=$(aws ssm send-command --instance-ids $id --document-name AWS-RunShellScript \
    --parameters "commands=[\"/usr/local/sbin/oauth-gateway-node $IMAGE\"]" --query Command.CommandId --output text)
  until status=$(aws ssm get-command-invocation --command-id $cmd --instance-id $id --query Status --output text 2>/dev/null) \
    && [[ $status != Pending && $status != InProgress && $status != Delayed ]]; do sleep 5; done
  echo "$id: $status"
  [[ $status == Success ]] || break    # stop on the first node that doesn't come back
done
```

Then push from the console. To add a node later, run the node part of the script again, or start an instance with the same role, security group and user data, and add its address in the console.

## Update the console

```bash
aws rds create-db-snapshot --db-instance-identifier oauth-console-db --db-snapshot-identifier oauth-console-$(date +%Y%m%d%H%M)
git archive --format=tar.gz -o oauth.tar.gz HEAD && scp -i oauth.pem oauth.tar.gz ubuntu@$CONSOLE_IP:
ssh -i oauth.pem ubuntu@$CONSOLE_IP 'rm -rf oauth && mkdir oauth && tar -xzf oauth.tar.gz -C oauth && cd oauth && sudo bash deploy/console/install.sh'
```

Run the migration if the release needs one (the installer prints the command), as in [Updating](cloud-deployment.md#updating).

## Optional: Redis for exact rate limits

Create a small ElastiCache for Redis (or Valkey) cluster in the gateway VPC. Allow 6379 from the gateway security group only. Then, on each node:

```bash
sudo REDIS_URL=redis://<primary endpoint>:6379 oauth-gateway-node
```

## Remove everything

Every resource is tagged `Project=<prefix>`. List them with:

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=oauth --query 'ResourceTagMappingList[].ResourceARN' --output text
```

Delete the gateway first:

1. The load balancer, then its target group.
2. The instances. Wait until they are terminated.
3. Release the Elastic IPs.
4. The security group, subnets, route table, internet gateway and VPC.
5. The instance profile and role.
6. The secret, and the ECR repository.

Then the console in the same order. Before that, take a final snapshot and turn off deletion protection:

```bash
aws rds modify-db-instance --db-instance-identifier oauth-console-db --no-deletion-protection --apply-immediately
aws rds delete-db-instance --db-instance-identifier oauth-console-db --final-db-snapshot-identifier oauth-console-final
```

Delete the SSM parameters last, and only once you are sure. Without `PKI_MASTER_KEY` and `JWT_SECRET`, the database snapshot can't be used again.
