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
#   SANDBOX_IMAGE     Sandbox container image (default ghcr.io/rossoctl/serverless-harness-sandbox:latest)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${SH_UNIT_DIR:=/etc/systemd/system}"
: "${SH_ENV_DIR:=/etc/serverless-harness}"
: "${SH_INSTALL_DIR:=/opt/serverless-harness}"
: "${SH_SANDBOX_COUNT:=2}"
: "${SANDBOX_IMAGE:=ghcr.io/rossoctl/serverless-harness-sandbox:latest}"

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
# install -d -m 0750 /etc/serverless-harness and systemctl enable both need root. Failing here
# with a clear message beats dying partway through on a confusing `install: Permission denied`.
# uid defaults to the real effective uid (via `id -u`, not $EUID, so a test can override it
# without actually running as another user).
require_root() {
  local uid="${1:-}"
  [[ -n "$uid" ]] || uid="$(id -u)"
  if [[ "$uid" != "0" ]]; then
    echo "must run as root: this installs systemd units under $SH_UNIT_DIR and files under" \
      "$SH_ENV_DIR. Re-run as: sudo $0" >&2
    return 1
  fi
}

# ExecStart is `node --import tsx src/main.ts`; tsx is a devDependency and the workspace's
# link: targets (harness -> pi-fork) only resolve after root `pnpm install`, and pi-fork's own
# type/JS output only exists after its own build (spec §9). A fresh VM checkout has run neither,
# so both units would die with ERR_MODULE_NOT_FOUND. Building here would take minutes inside a
# bring-up script that is supposed to be fast and idempotent -- fail loudly instead, naming the
# exact commands, and let the operator run them once.
#
# root defaults to the repo root two levels above this script (deploy/vm/../..); a caller may
# override it, which is what makes this testable without a second real checkout.
require_build() {
  local root="${1:-$SCRIPT_DIR/../..}"
  local missing=()
  [[ -d "$root/packages/supervisor/node_modules" ]] ||
    missing+=("pnpm install has not run (packages/supervisor/node_modules is missing)")
  if [[ ! -d "$root/pi-fork/packages/ai/dist" || ! -d "$root/pi-fork/packages/coding-agent/dist" ]]; then
    missing+=("pi-fork is not built (pi-fork/packages/{ai,coding-agent}/dist is missing)")
  fi
  if ((${#missing[@]})); then
    printf 'workspace is not built:\n' >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo "run, in order (spec §9): git submodule update --init --recursive; " \
      "cd pi-fork && npm ci && npm run build && cd ..; pnpm install" >&2
    return 1
  fi
}

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
  require_cmds podman systemctl install node getent pnpm
  require_root
  require_build
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
