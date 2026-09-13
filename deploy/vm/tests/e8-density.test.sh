#!/usr/bin/env bash
# Structural tests for deploy/vm/e8-density.sh. No cluster, no VM, no live run.
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

# --- 1. Without the live gate the driver is inert and exits 0. -----------------------------
SKIP_RESULTS="$TMP/should-not-exist-EXPERIMENTS.md"
OUT="$(V_LIVE=0 V_RESULTS="$SKIP_RESULTS" ./e8-density.sh 2>&1)"
RC=$?
[ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'SKIP' && ok "skips without V_LIVE=1" ||
  ko "should SKIP and exit 0 without V_LIVE=1 (rc=$RC)"

# A skip must not have created or touched the results file: Task 5 owns creating
# deploy/vm/EXPERIMENTS.md deliberately, and a driver that touched it on a skip would
# defeat that. Assert the filesystem, not just stdout's silence.
[ -e "$SKIP_RESULTS" ] && ko "a SKIP wrote a run record ($SKIP_RESULTS exists)" ||
  ok "SKIP writes no record"

# --- 2. The gate precedes the trap, so a skip cannot mutate state. -------------------------
GATE_LINE="$(grep -n 'V_LIVE' e8-density.sh | head -1 | cut -d: -f1)"
TRAP_LINE="$(grep -n '^trap ' e8-density.sh | head -1 | cut -d: -f1)"
if [ -n "$TRAP_LINE" ]; then
  [ "$GATE_LINE" -lt "$TRAP_LINE" ] && ok "live gate precedes the EXIT trap" ||
    ko "trap installed before the gate: a SKIP would run cleanup against a live system"
else
  ok "no EXIT trap to order"
fi

# --- 3. The ladder always contains c=1, or detectKnee throws. -----------------------------
grep -qE 'V_LADDER:-1 ' e8-density.sh && ok "default ladder starts at c=1" ||
  ko "default ladder must start at 1 (detectKnee throws without a c=1 baseline)"
grep -q 'no c=1' e8-density.sh && ok "driver asserts the c=1 rung up front" ||
  ko "driver must check for the c=1 rung BEFORE measuring, not after"

# --- 4. SH_TURNS_PER_WORKER is required, never defaulted. ---------------------------------
grep -qE 'SH_TURNS_PER_WORKER:?-' e8-density.sh &&
  ko "SH_TURNS_PER_WORKER must have no default (its value is an OUTPUT of E8)" ||
  ok "SH_TURNS_PER_WORKER carries no default"

# --- 5. Every rung records the two run-record fields §5.2 requires. -----------------------
for field in duty_basis conns_per_turn; do
  grep -q "$field" e8-density.sh && ok "records $field" || ko "missing run-record field: $field"
done

# --- 5b. Every rung records attempts/ok_n, and percentiles are success-only. --------------
for field in attempts ok_n; do
  grep -q "$field" e8-density.sh && ok "records $field" || ko "missing run-record field: $field"
done
grep -qE "\\\$2==200" e8-density.sh && ok "percentile input is filtered to 200-coded rows" ||
  ko "p50/p95 must be computed over 200-coded rows only, not the mixed raw sample"
grep -qi '0.95' e8-density.sh && ok "driver names a success-rate floor" ||
  ko "driver must WARN below a stated success-rate floor (see EXPERIMENTS.md)"

# --- 6. Every §5.2 attribution metric is sampled. -----------------------------------------
for m in loop_lag_p99 rss_bytes file_op_ms sandbox_cpu lease_saturation over_admission spurious_refusals spurious_429; do
  grep -q "$m" e8-density.sh && ok "samples $m" ||
    ko "missing §5.2 metric: $m (without it a knee cannot be attributed to a tier)"
done

# --- 6b. The bound is attributed, and refusably. -------------------------------------------
grep -q 'BOUND_TAG' e8-density.sh && ok "driver attributes the bound (§5.7)" ||
  ko "§5.7's claim sentence names a tier; the driver must derive it, not leave it to prose"
grep -q 'unattributed' e8-density.sh && ok "attribution can come back unattributed" ||
  ko "bound attribution must be refusable: with no threshold crossed it must say unattributed"

# --- 7. The knee is reported as a floor, never as a ceiling. -------------------------------
grep -qi 'floor' e8-density.sh && ok "knee labelled a floor" ||
  ko "knee must be labelled a floor: the ladder cannot see past its top rung"
grep -qiE 'maximum (density|concurrency)|hard limit' e8-density.sh &&
  ko "driver claims a ceiling" || ok "no ceiling claim"

# --- 8. shellcheck, like every other script in deploy/. -----------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x e8-density.sh lib-vm.sh >"$TMP/sc.log" 2>&1 && ok "shellcheck clean" ||
    { ko "shellcheck found problems"; cat "$TMP/sc.log"; }
else
  echo "# shellcheck not installed; skipping"
fi

[ "$FAIL" = 0 ] || exit 1
echo "# e8-density structural tests passed"
