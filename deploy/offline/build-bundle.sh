#!/usr/bin/env bash
# Builds an offline install bundle of the console (management) for a Linux server with no internet
# access. Run it on any machine that has internet access, Node.js and npm (Linux, macOS, or Git Bash
# on Windows), from the repository:
#
#   bash deploy/offline/build-bundle.sh
#   NGINX_FOR=noble bash deploy/offline/build-bundle.sh      # also pack nginx for Ubuntu 24.04
#
# It writes dist/oauth-console-<version>-linux-<arch>.tar.gz and a .sha256 file next to it. The
# bundle holds:
#   app/                 the console with its production dependencies installed (all plain JavaScript)
#   node/                the Node.js release for Linux, checked against nodejs.org's SHASUMS256.txt
#   certs/               Amazon's RDS CA bundle, for DB_SSL_CA on RDS
#   nginx/               (with NGINX_FOR) nginx and its dependencies as a local apt repository
#   install.sh           the offline installer: sudo bash install.sh --help
#
# Options (environment):
#   NODE_MAJOR (22)        the Node.js line; the newest release of it is used
#   NODE_VERSION           an exact release instead, e.g. 22.20.0
#   ARCH (x64)             x64 or arm64 (e.g. AWS Graviton, Azure Cobalt)
#   NGINX_FOR              noble (24.04) or jammy (22.04): pack nginx for that Ubuntu release; needs
#                          Docker, and the server must run that release
#   RDS_CA (true)          false leaves out Amazon's RDS CA bundle
#   OUT_DIR (dist)         where the bundle is written
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_MAJOR=${NODE_MAJOR:-22}
ARCH=${ARCH:-x64}
OUT_DIR=${OUT_DIR:-${REPO_ROOT}/dist}
RDS_CA=${RDS_CA:-true}

info() { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

[[ $ARCH == x64 || $ARCH == arm64 ]] || fail "ARCH must be x64 or arm64"
[[ -z "${NGINX_FOR:-}" || $NGINX_FOR == noble || $NGINX_FOR == jammy ]] || fail "NGINX_FOR must be noble or jammy"
for tool in node npm curl tar gzip; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed to build the bundle"; done
[[ -z "${NGINX_FOR:-}" ]] || command -v docker >/dev/null 2>&1 || fail "NGINX_FOR needs Docker"

VERSION="$(cd "$REPO_ROOT" && node -p "require('./package.json').version")"
NAME="oauth-console-${VERSION}-linux-${ARCH}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="${WORK}/${NAME}"
mkdir -p "$STAGE"/{app/gateway,node,certs}

info "Console ${VERSION}"
# The same files deploy/console/install.sh installs. The console runs the gateway's flow and
# policy modules, serves its charts and its README.
(cd "$REPO_ROOT" && cp -r app.js server.js package.json package-lock.json config controllers middleware \
  models public routes scripts services utils views docs "$STAGE/app/")
(cd "$REPO_ROOT/gateway" && cp -r src ui README.md "$STAGE/app/gateway/")
[[ -f "$REPO_ROOT/README.md" ]] && cp "$REPO_ROOT/README.md" "$STAGE/app/"

info "Production dependencies (npm ci --omit=dev)"
# No install scripts: every production dependency is plain JavaScript, so a bundle built on any
# system runs on Linux. The check below fails the build if that ever stops being true.
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
native="$(find "$STAGE/app/node_modules" \( -name '*.node' -o -name binding.gyp \) | head -5)"
[[ -z "$native" ]] || fail "A production dependency has native code, so the bundle must be built on Linux ${ARCH}:
${native}"
rm -rf "$STAGE/app/node_modules/.bin"   # npm's command shims: not used at runtime, and OS-specific

if [[ -n "${NODE_VERSION:-}" ]]; then
  NODE_DIST="https://nodejs.org/dist/v${NODE_VERSION#v}"
else
  NODE_DIST="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
fi
curl -fsSL "${NODE_DIST}/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt" || fail "Could not read ${NODE_DIST}/SHASUMS256.txt"
line="$(grep -E "  node-v[0-9.]+-linux-${ARCH}\.tar\.gz$" "$WORK/SHASUMS256.txt" || true)"
NODE_SHA=${line%% *}
NODE_FILE=${line##* }
[[ -n "$line" ]] || fail "No Linux ${ARCH} build listed in ${NODE_DIST}/SHASUMS256.txt"
info "Node.js ${NODE_FILE}"
curl -fsSL "${NODE_DIST}/${NODE_FILE}" -o "$STAGE/node/${NODE_FILE}"
[[ "$(sha256 "$STAGE/node/${NODE_FILE}")" == "$NODE_SHA" ]] || fail "${NODE_FILE} does not match its SHA-256 in SHASUMS256.txt"

if [[ $RDS_CA == true ]]; then
  info "Amazon RDS CA bundle"
  curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$STAGE/certs/rds-global-bundle.pem"
fi

if [[ -n "${NGINX_FOR:-}" ]]; then
  [[ $ARCH == x64 ]] && platform=linux/amd64 || platform=linux/arm64
  info "nginx for Ubuntu ${NGINX_FOR} (${platform}), as a local apt repository"
  mkdir -p "$STAGE/nginx"
  # Download first, in a clean image, so every dependency a minimal system lacks is included; then
  # index the folder so apt on the server can resolve them from it.
  out="$STAGE/nginx"
  command -v cygpath >/dev/null 2>&1 && out="$(cygpath -w "$out")"   # Git Bash: Docker needs a Windows path
  MSYS_NO_PATHCONV=1 docker run --rm --platform "$platform" -v "${out}:/out" "ubuntu:${NGINX_FOR}" bash -ec '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --download-only nginx >/dev/null
    cp /var/cache/apt/archives/*.deb /out/
    apt-get install -y -qq apt-utils >/dev/null
    cd /out && apt-ftparchive packages . > Packages
    chmod 644 /out/*'
  [[ -s "$STAGE/nginx/Packages" ]] || fail "The nginx packages did not reach ${STAGE}/nginx"
  echo "$NGINX_FOR" > "$STAGE/nginx/UBUNTU_RELEASE"
fi

cp "$REPO_ROOT/deploy/offline/install.sh" "$STAGE/install.sh"
cp "$REPO_ROOT/deploy/console/oauth-console.service" "$REPO_ROOT/deploy/console/nginx.conf" "$STAGE/"
cp "$REPO_ROOT/.env.example" "$STAGE/console.env.example"
cat > "$STAGE/BUNDLE" <<EOF
version=${VERSION}
commit=$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node=${NODE_FILE}
arch=${ARCH}
nginx=${NGINX_FOR:-none}
EOF

mkdir -p "$OUT_DIR"
info "Packing ${OUT_DIR}/${NAME}.tar.gz"
tar -C "$WORK" --owner=0 --group=0 -czf "${OUT_DIR}/${NAME}.tar.gz" "$NAME"
echo "$(sha256 "${OUT_DIR}/${NAME}.tar.gz")  ${NAME}.tar.gz" > "${OUT_DIR}/${NAME}.tar.gz.sha256"

cat <<EOF

Built ${OUT_DIR}/${NAME}.tar.gz ($(du -h "${OUT_DIR}/${NAME}.tar.gz" | cut -f1))
SHA-256 in ${NAME}.tar.gz.sha256. On the server:
  sha256sum -c ${NAME}.tar.gz.sha256
  tar -xzf ${NAME}.tar.gz && cd ${NAME}
  sudo bash install.sh --help
EOF
