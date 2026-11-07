#!/usr/bin/env bash
# Updates a running OAuth Server gateway to the code in this gateway/ folder, then checks it.
#
#   sudo ./gateway/deploy/update.sh                  # finds the gateway: the systemd service or its Docker containers
#   sudo ./gateway/deploy/update.sh --git            # git pull the repository first
#   sudo ./gateway/deploy/update.sh --docker node-1  # only this container
#   sudo ./gateway/deploy/update.sh --docker node-1 --image oauth-server-gateway:1.0.0  # and run it on this tag
#   sudo ./gateway/deploy/update.sh --service        # only the systemd service
#
# The configuration, credentials and data are kept: the service keeps /etc/oauth-gateway and
# /var/lib/oauth-gateway. Docker: the new image is built first, then each container is stopped,
# replaced by one with the same ports, settings and volumes on the new image, and started; the old
# image is removed once nothing runs it.
# A node that isn't healthy within the wait goes back to the previous release by itself.
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=/opt/oauth-gateway
CONFIG_DIR=/etc/oauth-gateway
WAIT_SECONDS=60
MODE=""
GIT_PULL=0
CONTAINERS=()
IMAGE_ARG=""

usage() {
  cat <<'EOF'
Usage: sudo ./gateway/deploy/update.sh [options]

  --git              run git pull in the repository before updating
  --service          update the systemd service (oauth-gateway)
  --docker [NAME...] update these containers (default: every gateway container)
  --image TAG        build the image under this tag and run the containers on it
                     (default: the tag each container runs now)
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
    --image) IMAGE_ARG=${2:?--image needs a value}; shift 2 ;;
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
# Gateway containers, running or stopped: an image named like the gateway's, or the GATEWAY_DATA_DIR
# its Dockerfile sets (an image built under another name). Left-over <name>-previous copies don't count.
gateway_containers() {
  local id
  for id in $(docker ps -aq 2>/dev/null); do
    docker inspect "$id" --format '{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{range .Config.Env}}{{.}} {{end}}'
  done | awk -F'\t' '{ sub(/^\//, "", $1) }
    $1 !~ /-previous$/ && ($2 ~ /oauth-(server-)?gateway/ || $3 ~ /(^| )GATEWAY_DATA_DIR=/) { print $1 }'
}

[[ -n "$IMAGE_ARG" && -z "$MODE" ]] && MODE=docker
if [[ -z "$MODE" ]]; then
  if service_installed; then MODE=service
  elif command -v docker >/dev/null 2>&1 && [[ -n "$(gateway_containers)" ]]; then MODE=docker
  else fail "No gateway found: neither the oauth-gateway service nor a gateway container. Install one with deploy/install.sh or the docker run command from the console."
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

# Removes image $1 (an id) once no container uses it any more.
remove_image_if_unused() {
  [[ -n "$1" ]] || return 0
  if [[ -z "$(docker ps -aq --filter "ancestor=$1")" ]]; then
    docker rmi "$1" >/dev/null 2>&1 && info "Removed the old image ${1:7:12}." || true
  fi
}

# Prints whether the node in container $1 serves traffic, if its health port is published.
show_container_ready() {
  local health_port
  health_port="$(docker port "$1" 9080/tcp 2>/dev/null | head -n 1 | sed 's/.*://')"
  if [[ -n "$health_port" ]]; then show_ready "http://127.0.0.1:${health_port}/readyz"; fi
}

# A container started with "docker run": stop it, start a new one with the same options on the
# new image, and keep the old one (stopped, as <name>-previous) until the new one is healthy.
update_container() {
  local name=$1 image=$2 old_id=$3 options=()
  mapfile -t options < <(container_options "$name")

  info "Stopping ${name}"
  docker rm -f "${name}-previous" >/dev/null 2>&1 || true
  docker stop "$name" >/dev/null
  docker rename "$name" "${name}-previous"
  info "Starting ${name} on ${image}"
  if docker run -d --name "$name" "${options[@]}" "$image" >/dev/null && wait_container "$name"; then
    docker rm "${name}-previous" >/dev/null
    info "${name} is running and healthy on the new image."
    show_container_ready "$name"
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

# A container of a Docker Compose project (deploy/docker-compose.yml): compose recreates it, so it
# stays in its project and network. Rolling back puts the old image back under the same tag.
update_compose_container() {
  local name=$1 image=$2 old_id=$3 project service workdir files args=()
  project="$(docker inspect "$name" --format '{{index .Config.Labels "com.docker.compose.project"}}')"
  service="$(docker inspect "$name" --format '{{index .Config.Labels "com.docker.compose.service"}}')"
  workdir="$(docker inspect "$name" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
  files="$(docker inspect "$name" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"
  args=(-p "$project")
  [[ -n "$workdir" ]] && args+=(--project-directory "$workdir")
  local file file_list=()
  IFS=',' read -ra file_list <<<"$files"
  for file in "${file_list[@]}"; do [[ -n "$file" ]] && args+=(-f "$file"); done

  info "Replacing ${name} (compose service ${service} of ${project})"
  if docker compose "${args[@]}" up -d --no-deps --force-recreate "$service" >/dev/null && wait_container "$name"; then
    info "${name} is running and healthy on the new image."
    show_container_ready "$name"
    return 0
  fi

  echo "${name} isn't healthy on the new image. Its log:" >&2
  docker logs --tail 40 "$name" >&2 2>&1 || true
  info "Rolling back ${name}"
  docker tag "$old_id" "$image"
  docker compose "${args[@]}" up -d --no-deps --force-recreate "$service" >/dev/null || true
  echo "${name} runs the previous image again (${old_id:7:12}). Build again after fixing the code: the tag ${image} now names the old image." >&2
  return 1
}

update_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker isn't installed here."
  if [[ ${#CONTAINERS[@]} -eq 0 ]]; then mapfile -t CONTAINERS < <(gateway_containers); fi
  [[ ${#CONTAINERS[@]} -gt 0 ]] || fail "No gateway container found. Name it: --docker <name>."

  # Each container's image tag (or --image) and the image it runs now, before anything changes.
  declare -A image_of old_id_of
  local images=() name image failed=0
  for name in "${CONTAINERS[@]}"; do
    docker inspect "$name" >/dev/null 2>&1 || fail "No container named ${name}."
    image="${IMAGE_ARG:-$(docker inspect "$name" --format '{{.Config.Image}}')}"
    # An image given by id (no tag) can't be replaced: build under the console's tag instead.
    [[ "$image" == sha256:* || "$image" =~ ^[0-9a-f]{12,64}$ ]] && image=oauth-server-gateway:${NEW_VERSION}
    image_of[$name]=$image
    old_id_of[$name]="$(docker inspect "$name" --format '{{.Image}}')"
    [[ " ${images[*]} " == *" ${image} "* ]] || images+=("$image")
  done

  # Build first, while the old containers still serve: an image that doesn't build changes nothing.
  for image in "${images[@]}"; do
    info "Building ${image} from ${SOURCE_DIR}"
    docker build -q -t "$image" "$SOURCE_DIR" >/dev/null || fail "The image ${image} didn't build; nothing was changed."
  done

  # One container at a time, so the other nodes keep serving while each restarts.
  for name in "${CONTAINERS[@]}"; do
    if [[ -n "$(docker inspect "$name" --format '{{index .Config.Labels "com.docker.compose.project"}}')" ]]; then
      update_compose_container "$name" "${image_of[$name]}" "${old_id_of[$name]}" || failed=1
    else
      update_container "$name" "${image_of[$name]}" "${old_id_of[$name]}" || failed=1
    fi
  done

  # The old images, once nothing runs them.
  local old_ids=() id
  for name in "${CONTAINERS[@]}"; do
    id="${old_id_of[$name]}"
    [[ " ${old_ids[*]} " == *" ${id} "* ]] || old_ids+=("$id")
  done
  for id in "${old_ids[@]}"; do remove_image_if_unused "$id"; done

  echo
  for name in "${CONTAINERS[@]}"; do
    docker ps -a --filter "name=^${name}\$" --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  done
  [[ $failed -eq 0 ]] || fail "Some containers were not updated; see above."
}

case "$MODE" in
  service) update_service ;;
  docker) update_docker ;;
esac

info "Done. The console's Nodes list shows the new version after its next status check."
