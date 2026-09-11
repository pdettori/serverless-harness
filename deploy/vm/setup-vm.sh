#!/usr/bin/env bash
# Bring up the P6 single-VM deployment: Redis, relay, sandbox containers, supervisor unit.
# Sibling of deploy/knative/setup-kind.sh and setup-ocp.sh (spec §4.4).
#
# Prerequisites:
#   - a Linux VM with systemd and podman, Node 22+
#   - run as a user that can sudo to root (installs units under /etc/systemd/system)
#
# Usage:
#   ./deploy/vm/setup-vm.sh
#
# Env overrides:
#   SH_UNIT_DIR       Where systemd unit files are installed (default /etc/systemd/system)
#   SH_ENV_DIR        Where the supervisor/relay env files live (default /etc/serverless-harness)
#   SH_INSTALL_DIR    Where the harness checkout lives on the VM (default /opt/serverless-harness)
#   SH_SANDBOX_COUNT  Number of sandbox containers to start (default 2)
#   SANDBOX_IMAGE     Sandbox container image (default ghcr.io/rossoctl/sandbox:latest)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/serverless-harness}"
: "${SH_INSTALL_DIR:=/opt/serverless-harness}"
: "${SH_SANDBOX_COUNT:=2}"
: "${SANDBOX_IMAGE:=ghcr.io/rossoctl/sandbox:latest}"

log() { printf '==> %s\n' "$*"; }

require_cmds() {
  local missing=()
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  if ((${#missing[@]})); then
    echo "missing required commands: ${missing[*]}" >&2
    return 1
  fi
}

install_units() {
  log "installing systemd units into $SH_UNIT_DIR"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-supervisor.service" "$SH_UNIT_DIR/"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-relay.service" "$SH_UNIT_DIR/"
  systemctl daemon-reload
}

install_env() {
  install -d -m 0750 "$SH_ENV_DIR"
  if [[ ! -f "$SH_ENV_DIR/supervisor.env" ]]; then
    # Never clobber an operator-edited env file: it holds the S that an E8 run established.
    install -m 0640 "$SCRIPT_DIR/env/supervisor.env.example" "$SH_ENV_DIR/supervisor.env"
    log "wrote $SH_ENV_DIR/supervisor.env — set SH_TURNS_PER_WORKER before starting"
  else
    log "keeping existing $SH_ENV_DIR/supervisor.env"
  fi
}

start_redis() {
  log "starting Redis container"
  podman run -d --name sh-redis --replace -p 6379:6379 docker.io/redis:7-alpine
}

start_sandboxes() {
  log "starting $SH_SANDBOX_COUNT sandbox containers"
  local i
  for ((i = 0; i < SH_SANDBOX_COUNT; i++)); do
    podman run -d --name "sh-sandbox-$i" --replace "$SANDBOX_IMAGE"
  done
}

start_services() {
  log "enabling supervisor and relay"
  systemctl enable --now sh-relay.service
  systemctl enable --now sh-supervisor.service
}

main() {
  require_cmds podman systemctl install node
  install_env
  install_units
  start_redis
  start_sandboxes
  start_services
  log "done — curl http://127.0.0.1:${PORT:-8080}/health"
}

# Sourcing guard: lets the test load these functions without touching the machine.
if [[ -z "${SH_SOURCE_ONLY:-}" ]]; then
  main "$@"
fi
