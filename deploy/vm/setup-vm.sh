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

# Both units run as User=harness/Group=harness; nothing here creates that account (uid
# policy, shell, and home are an operator decision, not this script's to make). Fail loudly
# before install_units, naming the account and the units that need it, instead of letting
# systemd fail later with a confusing "user harness does not exist".
require_user() {
  local user="$1"
  if ! getent passwd "$user" >/dev/null 2>&1; then
    echo "missing system user '$user': sh-supervisor.service and sh-relay.service both run" \
      "as User=$user/Group=$user. Create it first, e.g.:" \
      "sudo useradd --system --no-create-home --shell /usr/sbin/nologin $user" >&2
    return 1
  fi
}

install_units() {
  log "installing systemd units into $SH_UNIT_DIR"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-supervisor.service" "$SH_UNIT_DIR/"
  install -m 0644 "$SCRIPT_DIR/systemd/sh-relay.service" "$SH_UNIT_DIR/"
  systemctl daemon-reload
}

# install_env_file <name> <hint> installs deploy/vm/env/<name>.env.example to
# $SH_ENV_DIR/<name>.env, once. Never clobber an operator-edited env file: it holds the S
# that an E8 run established (supervisor.env) or the shared token a worker was configured
# with (relay.env) — either one, a silent overwrite on re-run would be a real outage.
install_env_file() {
  local name="$1" hint="${2:-}"
  if [[ ! -f "$SH_ENV_DIR/$name.env" ]]; then
    install -m 0640 "$SCRIPT_DIR/env/$name.env.example" "$SH_ENV_DIR/$name.env"
    log "wrote $SH_ENV_DIR/$name.env${hint:+ — $hint}"
  else
    log "keeping existing $SH_ENV_DIR/$name.env"
  fi
}

install_env() {
  install -d -m 0750 "$SH_ENV_DIR"
  install_env_file supervisor "set SH_TURNS_PER_WORKER before starting"
  install_env_file relay "set SH_RELAY_TOKEN before starting"
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
  require_cmds podman systemctl install node getent
  require_user harness
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
