#!/usr/bin/env bash
# Cluster-free, root-free test for setup-vm.sh. Mocks podman/systemctl onto PATH and asserts
# on the recorded argv, plus checks the unit file's §4.3 hardening directives are present.
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/setup-vm.sh"
UNIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/systemd/sh-supervisor.service"
ENV_TEMPLATE="$(dirname "$UNIT")/../env/supervisor.env.example"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
for cmd in podman systemctl; do
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

# --- units land, and carry the §4.3 hardening -------------------------------------------
install_units
[[ -f "$SH_UNIT_DIR/sh-supervisor.service" ]] || fail "supervisor unit not installed"
grep -q 'systemctl daemon-reload' "$MOCK_LOG" || fail "daemon-reload not invoked"
for directive in ProtectSystem=strict NoNewPrivileges=true SystemCallFilter TimeoutStopSec; do
  # These are the VM analogue of the pod securityContext. Present, and asserted so a future
  # edit cannot quietly drop them — §4.3 does not CLAIM parity, but it does claim presence.
  grep -q "$directive" "$UNIT" || fail "unit is missing $directive"
done
pass "systemd unit installed with §4.3 hardening directives"

# --- env file is written once and never clobbered ----------------------------------------
install_env
grep -q 'SH_TURNS_PER_WORKER=' "$SH_ENV_DIR/supervisor.env" || fail "env template incomplete"
grep -q 'SH_SANDBOX_DISCOVERY=records' "$SH_ENV_DIR/supervisor.env" ||
  fail "VM env must select records discovery (no cluster on a VM)"
echo 'SH_TURNS_PER_WORKER=9' >>"$SH_ENV_DIR/supervisor.env"
install_env
grep -q 'SH_TURNS_PER_WORKER=9' "$SH_ENV_DIR/supervisor.env" ||
  fail "install_env clobbered an operator-edited env file"
pass "env file written once, operator edits preserved"

# --- SH_TURNS_PER_WORKER ships EMPTY -----------------------------------------------------
# §3.8: shipping a value would put a guess where an E8 output belongs.
grep -qE '^SH_TURNS_PER_WORKER=$' "$ENV_TEMPLATE" ||
  fail "the example env must leave SH_TURNS_PER_WORKER empty"
pass "no default shipped for SH_TURNS_PER_WORKER"

# --- sandbox count is honoured ------------------------------------------------------------
: >"$MOCK_LOG"
start_sandboxes
[[ "$(grep -c 'podman run .*sh-sandbox-' "$MOCK_LOG")" == "3" ]] ||
  fail "expected 3 sandbox containers, got: $(cat "$MOCK_LOG")"
pass "SH_SANDBOX_COUNT honoured"

# --- missing commands fail loudly ---------------------------------------------------------
if PATH="/nonexistent" require_cmds podman 2>/dev/null; then
  fail "require_cmds should fail when podman is absent"
fi
pass "require_cmds reports missing tools"

echo "all setup-vm.sh tests passed"
