#!/usr/bin/env bash
# Creates a private certificate chain: a root CA, an intermediate CA signed by it, and a server
# certificate for a domain signed by the intermediate, plus a PFX of the server certificate (with
# its key and chain) for deploy/docker/install.sh --pfx.
#
#   bash deploy/pki/create-ca.sh                                  # Mana2.ro, mana2.ro and *.mana2.ro
#   NAME="Example" DOMAIN=example.com OUT=example-pki PASSWORDS=example-pki-passwords.txt bash deploy/pki/create-ca.sh
#
# Every private key is encrypted (AES-256) with its own random password; the passwords are written
# to PASSWORDS. OUT and PASSWORDS are git-ignored: keep them out of the repository, and keep the
# root CA's key offline once the chain exists.
#
# Options (environment): NAME (Mana2.ro), DOMAIN (mana2.ro), ALT_NAMES (DNS:*.mana2.ro; comma
# separated, e.g. "DNS:*.mana2.ro,IP:203.0.113.10"), COUNTRY (RO), OUT (mana2-pki),
# PASSWORDS (mana2-pki-passwords.txt), ROOT_DAYS (3650), INTERMEDIATE_DAYS (1825), SERVER_DAYS (397).
# It refuses to overwrite an existing OUT.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: keep "/CN=..." subjects as they are

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME=${NAME:-Mana2.ro}
DOMAIN=${DOMAIN:-mana2.ro}
ALT_NAMES=${ALT_NAMES:-DNS:*.${DOMAIN}}
COUNTRY=${COUNTRY:-RO}
OUT=${OUT:-${REPO_ROOT}/mana2-pki}
PASSWORDS=${PASSWORDS:-${REPO_ROOT}/mana2-pki-passwords.txt}
ROOT_DAYS=${ROOT_DAYS:-3650}
INTERMEDIATE_DAYS=${INTERMEDIATE_DAYS:-1825}
SERVER_DAYS=${SERVER_DAYS:-397}

fail() { echo "ERROR: $*" >&2; exit 1; }
[[ ! -e "$OUT" ]] || fail "${OUT} already exists: move it away first, or set OUT."
command -v openssl >/dev/null 2>&1 || fail "openssl is needed"

mkdir -p "$OUT"
chmod 700 "$OUT"
cd "$OUT"

# One random password per private key, and one for the PFX.
export ROOT_PASS INTERMEDIATE_PASS SERVER_PASS PFX_PASS
ROOT_PASS="$(openssl rand -base64 24)"
INTERMEDIATE_PASS="$(openssl rand -base64 24)"
SERVER_PASS="$(openssl rand -base64 24)"
PFX_PASS="$(openssl rand -base64 24)"

cat > extensions.cnf <<EOF
[req]
distinguished_name = dn
[dn]

[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash

[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
subjectAltName = DNS:${DOMAIN},${ALT_NAMES}
EOF

echo "==> Root CA: ${NAME} Root CA (${ROOT_DAYS} days)"
openssl genrsa -aes256 -passout env:ROOT_PASS -out root-ca.key 4096 2>/dev/null
openssl req -new -x509 -sha256 -days "$ROOT_DAYS" -key root-ca.key -passin env:ROOT_PASS \
  -subj "/C=${COUNTRY}/O=${NAME}/CN=${NAME} Root CA" -config extensions.cnf -extensions root \
  -out root-ca.crt

echo "==> Intermediate CA: ${NAME} Intermediate CA (${INTERMEDIATE_DAYS} days)"
openssl genrsa -aes256 -passout env:INTERMEDIATE_PASS -out intermediate-ca.key 4096 2>/dev/null
openssl req -new -sha256 -key intermediate-ca.key -passin env:INTERMEDIATE_PASS \
  -subj "/C=${COUNTRY}/O=${NAME}/CN=${NAME} Intermediate CA" -out intermediate-ca.csr
openssl x509 -req -sha256 -days "$INTERMEDIATE_DAYS" -in intermediate-ca.csr \
  -CA root-ca.crt -CAkey root-ca.key -passin env:ROOT_PASS -CAcreateserial \
  -extfile extensions.cnf -extensions intermediate -out intermediate-ca.crt 2>/dev/null

echo "==> Server certificate: ${DOMAIN}, ${ALT_NAMES} (${SERVER_DAYS} days)"
openssl genrsa -aes256 -passout env:SERVER_PASS -out "${DOMAIN}.key" 2048 2>/dev/null
openssl req -new -sha256 -key "${DOMAIN}.key" -passin env:SERVER_PASS \
  -subj "/C=${COUNTRY}/O=${NAME}/CN=${DOMAIN}" -out "${DOMAIN}.csr"
openssl x509 -req -sha256 -days "$SERVER_DAYS" -in "${DOMAIN}.csr" \
  -CA intermediate-ca.crt -CAkey intermediate-ca.key -passin env:INTERMEDIATE_PASS -CAcreateserial \
  -extfile extensions.cnf -extensions server -out "${DOMAIN}.crt" 2>/dev/null

cat "${DOMAIN}.crt" intermediate-ca.crt > "${DOMAIN}-fullchain.crt"   # what a server sends: itself, then the intermediate
cat intermediate-ca.crt root-ca.crt > ca-chain.crt                     # what clients need to trust it

echo "==> PFX: ${DOMAIN}.pfx (key, certificate and chain; AES-256, readable by OpenSSL 3 and Windows)"
openssl pkcs12 -export -name "$DOMAIN" -inkey "${DOMAIN}.key" -passin env:SERVER_PASS \
  -in "${DOMAIN}.crt" -certfile ca-chain.crt \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -passout env:PFX_PASS -out "${DOMAIN}.pfx"

rm -f ./*.csr
chmod 600 ./*.key "${DOMAIN}.pfx"

echo "==> Checking the chain"
openssl verify -CAfile root-ca.crt -untrusted intermediate-ca.crt "${DOMAIN}.crt"

umask 077
cat > "$PASSWORDS" <<EOF
# Passwords of the private keys in ${OUT}
# Created $(date -u +%Y-%m-%dT%H:%M:%SZ) by deploy/pki/create-ca.sh. Git-ignored: never commit or share this file.
# Keep the root CA's key and password offline once the chain exists.

${NAME} Root CA key            root-ca.key           ${ROOT_PASS}
${NAME} Intermediate CA key    intermediate-ca.key   ${INTERMEDIATE_PASS}
${DOMAIN} server key           ${DOMAIN}.key         ${SERVER_PASS}
${DOMAIN} PFX                  ${DOMAIN}.pfx         ${PFX_PASS}

Install the console with the PFX:
  sudo PFX_PASSWORD='${PFX_PASS}' bash install.sh --domain mgmt01.${DOMAIN} --pfx ${DOMAIN}.pfx
Clients must trust ${NAME} Root CA (root-ca.crt) to accept the certificate.
EOF

cat <<EOF

Created in ${OUT}:
  root-ca.crt, root-ca.key                    ${NAME} Root CA
  intermediate-ca.crt, intermediate-ca.key    ${NAME} Intermediate CA (signed by the root)
  ${DOMAIN}.crt, ${DOMAIN}.key                the server certificate (signed by the intermediate)
  ${DOMAIN}-fullchain.crt                     server certificate + intermediate (for nginx)
  ca-chain.crt                                intermediate + root
  ${DOMAIN}.pfx                               key + certificate + chain, for install.sh --pfx
Passwords: ${PASSWORDS}
EOF
