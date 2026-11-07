#!/usr/bin/env bash
# Updates a running OAuth Server gateway to the code in this gateway/ folder, then checks it.
#
#   sudo ./gateway/deploy/update.sh                  # finds the gateway: the systemd service or its Docker containers
#   sudo ./gateway/deploy/update.sh --git            # git pull the repository first
#   sudo ./gateway/deploy/update.sh --docker node-1  # only this container
#   sudo ./gateway/deploy/update.sh --service        # only the systemd service
#
# The configuration, credentials and data are kept: the service keeps /etc/oauth-gateway and
# /var/lib/oauth-gateway; a container is recreated with its own ports, settings and volumes.
# A node that isn't healthy within the wait goes back to the previous release by itself.
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=/opt/oauth-gateway
CONFIG_DIR=/etc/oauth-gateway
WAIT_SECONDS=60
MODE=""
GIT_PULL=0
CONTAINERS=()

usage() {
  cat <<'EOF'
Usage: sudo ./gateway/deploy/update.sh [options]

  --git              run git pull in the repository before updating
  --service          update the systemd service (oauth-gateway)
  --docker [NAME...] update these containers (default: every container of an oauth-server-gateway image)
  --wait SECONDS     how long a node may take to become healthy (default: 60)
  -h, --help         this help

Without --service or --docker, the script updates whichever of the two runs here.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --git) GIT_PULL=1; shift ;;
    --service) MODE=service; shift ;;
    --docker)
      MODE=docker; shift
      while [ $# -gt 0 ] && [[ "$1" != -* ]]; do CONTAINERS+=("$1"); shift; done ;;
    --wait) WAIT_SECONDS=${2:?--wait needs a value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

info() { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run this script as root: sudo $0"
[[ -f "${SOURCE_DIR}/package.json" && -d "${SOURCE_DIR}/src" ]] || fail "${SOURCE_DIR} is not the gateway folder (no package.json and src/)."

if [[ $GIT_PULL -eq 1 ]]; then
  REPO_DIR="$(git -C "$SOURCE_DIR" rev-parse --show-toplevel 2>/dev/null)" || fail "${SOURCE_DIR} is not in a git repository: copy the new gateway folder instead of --git."
  info "Pulling ${REPO_DIR}"
  # As the repository's owner, so root doesn't take over files or use other credentials.
  sudo -u "$(stat -c %U "$REPO_DIR")" git -C "$REPO_DIR" pull --ff-only
fi

# Files copied from Windows can carry CRLF line ends, which break bash.
for script in "${SOURCE_DIR}/deploy/"*.sh; do sed -i 's/\r$//' "$script"; done

service_installed() { [[ -f /etc/systemd/system/oauth-gateway.service ]]; }
gateway_containers() {
  docker ps -a --format '{{.Names}}\t{{.Image}}' 2>/dev/null | awk -F'\t' '$2 ~ /^oauth-server-gateway(:|$)/ { print $1 }'
}

if [[ -z "$MODE" ]]; then
  if service_installed; then MODE=service
  elif command -v docker >/dev/null 2>&1 && [[ -n "$(gateway_containers)" ]]; then MODE=docker
  else fail "No gateway found: neither the oauth-gateway service nor a container of an oauth-server-gateway image. Install one with deploy/install.sh or the docker run command from the console."
  fi
fi

NEW_VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "${SOURCE_DIR}/package.json" | head -n 1)"
info "Updating the gateway (${MODE}) to the code in ${SOURCE_DIR}, version ${NEW_VERSION}"

# Waits until GET url answers 2xx. $1: url
wait_http() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  until curl -fsS -o /dev/null -m 3 "$1"; do
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}

# Prints the node's readiness (whether it serves a configuration on every handler port).
show_ready() {
  local body
  body="$(curl -sS -m 3 "$1" 2>/dev/null || true)"
  if [[ "$body" == *'"ready":true'* ]]; then info "Ready: $body"
  else echo "Note: not serving traffic yet ($body). A push node gets its configuration from the console: click Push configuration if it doesn't within a minute."
  fi
}

# ---------------------------------------------------------------------------------------------
# systemd service
# ---------------------------------------------------------------------------------------------
update_service() {
  service_installed || fail "The oauth-gateway service isn't installed here."
  local previous health_port
  previous="$(readlink -f "${INSTALL_DIR}/current" 2>/dev/null || true)"
  health_port="$(sed -n 's/^GATEWAY_HEALTH_PORT=//p' "${CONFIG_DIR}/gateway.env" 2>/dev/null | tail -n 1)"
  health_port="${health_port:-9080}"

  # install.sh installs a new release, switches "current" and restarts a running service.
  bash "${SOURCE_DIR}/deploy/install.sh" >/dev/null
  systemctl daemon-reload
  systemctl is-active --quiet oauth-gateway || systemctl restart oauth-gateway

  info "Waiting for the gateway on port ${health_port}"
  if wait_http "http://127.0.0.1:${health_port}/healthz"; then
    info "Updated: $(readlink -f "${INSTALL_DIR}/current")"
    show_ready "http://127.0.0.1:${health_port}/readyz"
    return
  fi
  echo "The new release isn't healthy. Its log:" >&2
  journalctl -u oauth-gateway -n 40 --no-pager >&2 || true
  if [[ -n "$previous" && -d "$previous" ]]; then
    info "Rolling back to ${previous}"
    ln -sfn "$previous" "${INSTALL_DIR}/current"
    systemctl restart oauth-gateway
    wait_http "http://127.0.0.1:${health_port}/healthz" && info "The previous release runs again."
  fi
  fail "Update failed."
}

# ---------------------------------------------------------------------------------------------
# Docker containers
# ---------------------------------------------------------------------------------------------

# The docker run options that recreate container $1 as it is: ports, gateway settings, volumes,
# restart policy, extra hosts and network. One option per line.
container_options() {
  docker inspect "$1" --format '
{{- range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}-p
{{if .HostIp}}{{.HostIp}}:{{end}}{{.HostPort}}:{{$port}}
{{end}}{{end}}
{{- range .Config.Env}}-e
{{.}}
{{end}}
{{- range .Mounts}}-v
{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}:{{.Destination}}{{if not .RW}}:ro{{end}}
{{end}}
{{- range .HostConfig.ExtraHosts}}--add-host
{{.}}
{{end}}
{{- with .HostConfig.RestartPolicy.Name}}{{if ne . "no"}}--restart
{{.}}
{{end}}{{end}}
{{- with .HostConfig.NetworkMode}}{{if and (ne . "default") (ne . "bridge")}}--network
{{.}}
{{end}}{{end}}' | awk '
    # Keep only the gateway settings: the others (PATH, NODE_VERSION...) belong to the image.
    pending == "-e" { if ($0 ~ /^GATEWAY_|^NODE_EXTRA_CA_CERTS=/) print "-e\n" $0; pending = ""; next }
    $0 == "-e" { pending = "-e"; next }
    NF { print }'
}

container_health() {
  docker inspect "$1" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo missing
}

# Waits until container $1 is healthy (the image's HEALTHCHECK calls /healthz).
wait_container() {
  local deadline=$((SECONDS + WAIT_SECONDS)) state
  while :; do
    state="$(container_health "$1")"
    case "$state" in
      healthy) return 0 ;;
      exited|dead|missing) return 1 ;;
    esac
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}

update_container() {
  local name=$1 image old_id options=()
  image="$(docker inspect "$name" --format '{{.Config.Image}}')"
  old_id="$(docker inspect "$name" --format '{{.Image}}')"
  mapfile -t options < <(container_options "$name")

  info "Recreating ${name} on ${image}"
  docker rm -f "${name}-previous" >/dev/null 2>&1 || true
  docker stop "$name" >/dev/null
  docker rename "$name" "${name}-previous"
  if docker run -d --name "$name" "${options[@]}" "$image" >/dev/null && wait_container "$name"; then
    docker rm "${name}-previous" >/dev/null
    info "${name} is healthy on the new image."
    local health_port
    health_port="$(docker port "$name" 9080/tcp 2>/dev/null | head -n 1 | sed 's/.*://')"
    [[ -n "$health_port" ]] && show_ready "http://127.0.0.1:${health_port}/readyz"
    return 0
  fi

  echo "${name} isn't healthy on the new image. Its log:" >&2
  docker logs --tail 40 "$name" >&2 2>&1 || true
  info "Rolling back ${name}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker rename "${name}-previous" "$name"
  # The old container still refers to the old image by its id, so it starts as before.
  docker start "$name" >/dev/null
  echo "${name} runs the previous image again (${old_id:7:12})." >&2
  return 1
}

update_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker isn't installed here."
  if [[ ${#CONTAINERS[@]} -eq 0 ]]; then mapfile -t CONTAINERS < <(gateway_containers); fi
  [[ ${#CONTAINERS[@]} -gt 0 ]] || fail "No container of an oauth-server-gateway image found. Name it: --docker <name>."

  # Build every image the containers use (normally one: the tag the console's command names).
  local images=() name image failed=0
  for name in "${CONTAINERS[@]}"; do
    image="$(docker inspect "$name" --format '{{.Config.Image}}' 2>/dev/null)" || fail "No container named ${name}."
    [[ " ${images[*]} " == *" ${image} "* ]] || images+=("$image")
  done
  for image in "${images[@]}"; do
    info "Building ${image}"
    docker build -q -t "$image" "$SOURCE_DIR" >/dev/null
  done

  # One container at a time, so the other nodes keep serving while each restarts.
  for name in "${CONTAINERS[@]}"; do update_container "$name" || failed=1; done
  [[ $failed -eq 0 ]] || fail "Some containers were not updated; see above."
  docker image prune -f >/dev/null 2>&1 || true
}

case "$MODE" in
  service) update_service ;;
  docker) update_docker ;;
esac

info "Done. The console's Nodes list shows the new version after its next status check."
