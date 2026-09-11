#!/usr/bin/env bash
# Cluster-free, root-free test for setup-vm.sh. Mocks podman/systemctl/getent onto PATH and
# asserts on the recorded argv, plus checks both unit files' ExecStart/WorkingDirectory
# pairing, their §4.3 hardening directives, the env-file contract each EnvironmentFile= line
# implies, and (last) a full main() run against the mocks.
set -euo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$VM_DIR/setup-vm.sh"
UNIT_SUPERVISOR="$VM_DIR/systemd/sh-supervisor.service"
UNIT_RELAY="$VM_DIR/systemd/sh-relay.service"
ENV_SRC_DIR="$VM_DIR/env"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
for cmd in podman systemctl getent; do
  cat >"$TMP/bin/$cmd" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"$MOCK_LOG"
MOCK
  chmod +x "$TMP/bin/$cmd"
done
export PATH="$TMP/bin:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

export SH_SOURCE_ONLY=1
export SH_UNIT_DIR="$TMP/units" SH_ENV_DIR="$TMP/etc" SH_SANDBOX_COUNT=3
mkdir -p "$SH_UNIT_DIR"
# shellcheck source=/dev/null
source "$SCRIPT"

# --- sourcing must not touch the machine -------------------------------------------------
[[ ! -s "$MOCK_LOG" ]] || fail "sourcing ran commands: $(cat "$MOCK_LOG")"
pass "SH_SOURCE_ONLY sources without side effects"

# --- units land, and each carries the right ExecStart/WorkingDirectory and §4.3 hardening -
install_units
[[ -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || fail "supervisor unit not installed"
[[ -f "$SH_UNIT_DIR/sh-relay.service" ]] || fail "relay unit not installed"
grep -q 'systemctl daemon-reload' "$MOCK_LOG" || fail "daemon-reload not invoked"

# unit -> package-dir pairs. WorkingDirectory must be the package's OWN dir (not the repo
# root) and ExecStart must match that package's own `start` script (`node --import tsx
# src/main.ts`) -- the same CWD-resolution fix already documented at
# deploy/knative/relay-deployment.yaml:20-32 and deploy/knative/control-plane.yaml:184-187:
# `node --import tsx` resolves the tsx loader relative to the CWD, and tsx is linked only
# into each package's own node_modules, never root-hoisted.
UNIT_PACKAGES=(
  "$UNIT_SUPERVISOR:supervisor"
  "$UNIT_RELAY:sandbox-relay"
)
for pair in "${UNIT_PACKAGES[@]}"; do
  unit="${pair%%:*}"
  pkg="${pair##*:}"
  grep -qE "^WorkingDirectory=/opt/serverless-harness/packages/$pkg\$" "$unit" ||
    fail "$unit: WorkingDirectory must be the $pkg package dir, not the repo root"
  grep -qE '^ExecStart=/usr/bin/node --import tsx src/main\.ts$' "$unit" ||
    fail "$unit: ExecStart must run src/main.ts relative to WorkingDirectory"
  for directive in ProtectSystem=strict NoNewPrivileges=true SystemCallFilter TimeoutStopSec \
    StateDirectory=serverless-harness; do
    # These are the VM analogue of the pod securityContext. Present, and asserted so a future
    # edit cannot quietly drop them -- §4.3 does not CLAIM parity, but it does claim presence.
    grep -q "$directive" "$unit" || fail "$unit is missing $directive"
  done
  # Nothing in deploy/vm/systemd/ installs a redis.service -- Redis runs as a bare podman
  # container from start_redis() in this same script -- so a Requires= here would name a unit
  # that can never resolve and the service would fail to start.
  if grep -q '^Requires=' "$unit"; then
    fail "$unit: Requires= names a unit nothing installs"
  fi
done
pass "both units: correct ExecStart/WorkingDirectory, §4.3 hardening present, no dangling Requires="

# --- every EnvironmentFile= has a shipped template (general form of the relay.env gap) -----
# Derive the env names from the units themselves, not by hard-coding "supervisor"/"relay" --
# that is what makes this catch the next env file somebody adds.
ENV_NAMES=()
for unit in "$UNIT_SUPERVISOR" "$UNIT_RELAY"; do
  name=$(grep -oE '^EnvironmentFile=/etc/serverless-harness/[A-Za-z0-9_.-]+\.env$' "$unit" |
    sed -E 's#.*/([A-Za-z0-9_.-]+)\.env$#\1#')
  [[ -n "$name" ]] || fail "$unit: no EnvironmentFile= line found"
  [[ -f "$ENV_SRC_DIR/$name.env.example" ]] ||
    fail "$unit references $name.env but deploy/vm/env/$name.env.example does not exist"
  ENV_NAMES+=("$name")
done
pass "every EnvironmentFile= has a shipped template"

# --- env files are written once and never clobbered ----------------------------------------
install_env
for name in "${ENV_NAMES[@]}"; do
  [[ -f "$SH_ENV_DIR/$name.env" ]] || fail "install_env did not install $name.env"
done
grep -q 'SH_TURNS_PER_WORKER=' "$SH_ENV_DIR/supervisor.env" || fail "env template incomplete"
grep -q 'SH_SANDBOX_DISCOVERY=records' "$SH_ENV_DIR/supervisor.env" ||
  fail "VM env must select records discovery (no cluster on a VM)"
echo 'SH_TURNS_PER_WORKER=9' >>"$SH_ENV_DIR/supervisor.env"
echo 'SH_RELAY_PORT=7777' >>"$SH_ENV_DIR/relay.env"
install_env
grep -q 'SH_TURNS_PER_WORKER=9' "$SH_ENV_DIR/supervisor.env" ||
  fail "install_env clobbered an operator-edited supervisor.env"
grep -q 'SH_RELAY_PORT=7777' "$SH_ENV_DIR/relay.env" ||
  fail "install_env clobbered an operator-edited relay.env"
pass "both env files written once, operator edits preserved"

# --- SH_TURNS_PER_WORKER ships EMPTY -------------------------------------------------------
# §3.8: shipping a value would put a guess where an E8 output belongs.
grep -qE '^SH_TURNS_PER_WORKER=$' "$ENV_SRC_DIR/supervisor.env.example" ||
  fail "the example env must leave SH_TURNS_PER_WORKER empty"
pass "no default shipped for SH_TURNS_PER_WORKER"

# --- the relay's bind port and the supervisor's dial port must agree (the real F3 bug) -----
relay_port=$(grep -oE '^SH_RELAY_PORT=[0-9]+' "$ENV_SRC_DIR/relay.env.example" | cut -d= -f2)
addr_port=$(grep -oE '^SH_RELAY_ADDR=.*:[0-9]+$' "$ENV_SRC_DIR/supervisor.env.example" |
  grep -oE '[0-9]+$')
[[ -n "$relay_port" ]] || fail "relay.env.example is missing SH_RELAY_PORT"
[[ -n "$addr_port" ]] || fail "supervisor.env.example's SH_RELAY_ADDR has no port"
[[ "$relay_port" == "$addr_port" ]] ||
  fail "SH_RELAY_PORT ($relay_port) in relay.env.example must equal the port in" \
    "SH_RELAY_ADDR ($addr_port) in supervisor.env.example -- they describe the same wire"
pass "relay bind port and supervisor dial port agree"

# --- sandbox count is honoured --------------------------------------------------------------
: >"$MOCK_LOG"
start_sandboxes
[[ "$(grep -c 'podman run .*sh-sandbox-' "$MOCK_LOG")" == "3" ]] ||
  fail "expected 3 sandbox containers, got: $(cat "$MOCK_LOG")"
pass "SH_SANDBOX_COUNT honoured"

# --- missing commands fail loudly -----------------------------------------------------------
if PATH="/nonexistent" require_cmds podman 2>/dev/null; then
  fail "require_cmds should fail when podman is absent"
fi
pass "require_cmds reports missing tools"

# --- main(), end to end, against mocks (last: exercises the real call order) ---------------
# require_cmds also needs `install` and `node`, which are on the real PATH (appended after the
# mock dir above) and deliberately not mocked here.
export SH_UNIT_DIR="$TMP/units2" SH_ENV_DIR="$TMP/etc2"
mkdir -p "$SH_UNIT_DIR"
: >"$MOCK_LOG"
main

grep -q 'getent passwd harness' "$MOCK_LOG" || fail "main() did not check for the harness account"
[[ -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || fail "main() did not install the supervisor unit"
[[ -f "$SH_UNIT_DIR/sh-relay.service" ]] || fail "main() did not install the relay unit"
[[ -f "$SH_ENV_DIR/supervisor.env" ]] || fail "main() did not install supervisor.env"
[[ -f "$SH_ENV_DIR/relay.env" ]] || fail "main() did not install relay.env"

reload_line=$(grep -n 'systemctl daemon-reload' "$MOCK_LOG" | head -1 | cut -d: -f1)
redis_line=$(grep -n 'podman run .*sh-redis' "$MOCK_LOG" | head -1 | cut -d: -f1)
relay_enable_line=$(grep -n 'systemctl enable --now sh-relay.service' "$MOCK_LOG" | head -1 | cut -d: -f1)
[[ -n "$reload_line" && -n "$redis_line" && -n "$relay_enable_line" ]] ||
  fail "main() did not perform the expected steps: $(cat "$MOCK_LOG")"
((reload_line < redis_line)) ||
  fail "main() must install units (daemon-reload) before starting Redis"
((redis_line < relay_enable_line)) ||
  fail "main() must start Redis before enabling the relay unit"
pass "main() end to end: harness-account check, both units, both env files, correct ordering"

echo "all setup-vm.sh tests passed"
