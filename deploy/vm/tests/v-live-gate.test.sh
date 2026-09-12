#!/usr/bin/env bash
# Structural tests for deploy/vm/v-live-gate.sh — §5.5's real-model validation gate.
#
# The gate is deliberately NOT a third experiment: it must be incapable of producing a density
# number, incapable of appending a ladder to EXPERIMENTS.md, and incapable of passing against
# the stub it exists to rule out. Every check below asserts one of those properties directly on
# the script text or its exit behaviour, rather than trusting the header comment to say so.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. Without the live gate the gate is inert and exits 0. -------------------------------
OUT="$(V_LIVE=0 ./v-live-gate.sh 2>&1)"
RC=$?
[ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'SKIP' && ok "skips without V_LIVE=1" ||
  ko "should SKIP and exit 0 without V_LIVE=1 (rc=$RC)"

# --- 2. The gate precedes the EXIT trap. -----------------------------------------------------
GATE_LINE="$(grep -n 'V_LIVE' v-live-gate.sh | head -1 | cut -d: -f1)"
TRAP_LINE="$(grep -n '^trap ' v-live-gate.sh | head -1 | cut -d: -f1)"
if [ -n "$TRAP_LINE" ]; then
  [ "$GATE_LINE" -lt "$TRAP_LINE" ] && ok "live gate precedes the EXIT trap" ||
    ko "trap installed before the gate: a SKIP would run cleanup against a live system"
else
  ok "no EXIT trap to order"
fi

# --- 3. The c<=6 cap is enforced, and enforced BEFORE the real-model checks. ----------------
# A run at c=7 must be refused for being over the cap -- not incidentally rejected later for a
# missing API key, which would let someone raise the cap by simply setting a key.
CAP_OUT="$(V_LIVE=1 V_GATE_C=7 ./v-live-gate.sh 2>&1)"
CAP_RC=$?
[ "$CAP_RC" != 0 ] && printf '%s' "$CAP_OUT" | grep -qi 'cap' &&
  ok "refuses V_GATE_C=7 (over the §5.5 cap of 6)" ||
  ko "must refuse c>6 with a cap message (rc=$CAP_RC): $CAP_OUT"
printf '%s' "$CAP_OUT" | grep -q 'ANTHROPIC_API_KEY must be set' &&
  ko "cap check ran after the API-key check instead of before it" ||
  ok "cap check fires before the API-key requirement"

# --- 4. A real model is mandatory: no key, no run. ------------------------------------------
NOKEY_OUT="$(V_LIVE=1 V_GATE_C=1 env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL ./v-live-gate.sh 2>&1)"
NOKEY_RC=$?
[ "$NOKEY_RC" != 0 ] && printf '%s' "$NOKEY_OUT" | grep -q 'ANTHROPIC_API_KEY' &&
  ok "refuses to run without ANTHROPIC_API_KEY" ||
  ko "must require ANTHROPIC_API_KEY (rc=$NOKEY_RC): $NOKEY_OUT"

# --- 5. A stub-shaped ANTHROPIC_BASE_URL is refused, not silently passed. -------------------
for url in 'http://127.0.0.1:9999' 'http://localhost:9999' 'http://model-stub.default.svc:9999'; do
  STUB_OUT="$(V_LIVE=1 V_GATE_C=1 ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL="$url" ./v-live-gate.sh 2>&1)"
  STUB_RC=$?
  [ "$STUB_RC" != 0 ] && printf '%s' "$STUB_OUT" | grep -qi 'stub' &&
    ok "refuses ANTHROPIC_BASE_URL=$url as stub-shaped" ||
    ko "must refuse a stub-shaped ANTHROPIC_BASE_URL ($url), rc=$STUB_RC: $STUB_OUT"
done

# --- 6. It appends NO ladder to EXPERIMENTS.md: no results file, no append operator. --------
grep -qE 'RESULTS=.*EXPERIMENTS\.md' v-live-gate.sh &&
  ko "gate must not write to EXPERIMENTS.md -- it validates, it does not measure" ||
  ok "no EXPERIMENTS.md results-file variable"
grep -qE '>>\s*"?\$?\{?RESULTS' v-live-gate.sh &&
  ko "gate appends to a results file" ||
  ok "no append-to-results-file operation"

# --- 7. Its output carries no density vocabulary -- cannot be mistaken for a measurement. ---
grep -qE 'E8_RESULT|E9_RESULT|knee_floor|throughput|p95Ms' v-live-gate.sh &&
  ko "gate output uses density-result vocabulary; it must read as validation, not measurement" ||
  ok "no density-result vocabulary in the gate"
grep -q 'V_GATE:' v-live-gate.sh && ok "reports its own PASS/FAIL, distinct from E8/E9" ||
  ko "gate must report a distinct V_GATE verdict"
grep -qi 'not a density number' v-live-gate.sh && ok "explicitly disclaims being a density number" ||
  ko "gate must say it is not a density number"

# --- 8. It proves the path is genuine: a real tool call reached a real sandbox. -------------
grep -q 'sandbox_cpu_seconds' v-live-gate.sh && ok "checks sandbox CPU was consumed" ||
  ko "gate must verify a tool call reached a sandbox, or it proves nothing"

# --- 9. It proves rehydration: the same session id is used for a second turn. --------------
[ "$(grep -c 'vm_turn' v-live-gate.sh)" -ge 2 ] && ok "drives at least two turns per session" ||
  ko "gate must run a second turn on the same session id to prove Redis rehydration"

# --- 10. Telemetry comes from METRICS_BASE, never BASE (plan 1 Task 11's admin listener). ---
grep -q 'worker_metrics.*METRICS_BASE' v-live-gate.sh && ok "reads telemetry from METRICS_BASE" ||
  ko "gate must read /metrics from METRICS_BASE, not the data port"

# --- 11. shellcheck, like every other script in deploy/. ------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x v-live-gate.sh >"$TMP/sc.log" 2>&1 && ok "shellcheck clean" ||
    { ko "shellcheck found problems"; cat "$TMP/sc.log"; }
else
  echo "# shellcheck not installed; skipping"
fi

[ "$FAIL" = 0 ] || exit 1
echo "# v-live-gate structural tests passed"
