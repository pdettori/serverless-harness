#!/usr/bin/env bash
# Structural tests for deploy/vm/run-experiments.sh — the shared-configuration runner.
#
# The property under test is narrower than "it runs E8 and E9": it is that an operator CANNOT
# give the two drivers different ladders or stub profiles, because a difference in either makes
# their records incomparable (§5.7). This file also asserts the runner cannot be mistaken for
# v-live-gate.sh's real-model validation path — that confusion is the thing Task 5 exists to
# prevent.
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

# --- 1. Without the live gate the runner is inert and exits 0. -----------------------------
SKIP_RESULTS="$TMP/should-not-exist-EXPERIMENTS.md"
OUT="$(V_LIVE=0 V_RESULTS="$SKIP_RESULTS" ./run-experiments.sh 2>&1)"
RC=$?
[ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'SKIP' && ok "skips without V_LIVE=1" ||
  ko "should SKIP and exit 0 without V_LIVE=1 (rc=$RC)"
[ -e "$SKIP_RESULTS" ] && ko "a SKIP wrote a run record ($SKIP_RESULTS exists)" ||
  ok "SKIP writes no record"

# --- 2. The gate precedes any invocation of a driver. ---------------------------------------
GATE_LINE="$(grep -n 'V_LIVE' run-experiments.sh | head -1 | cut -d: -f1)"
E8_CALL_LINE="$(grep -n '\./e8-density\.sh' run-experiments.sh | head -1 | cut -d: -f1)"
[ -n "$E8_CALL_LINE" ] || ko "runner never invokes e8-density.sh"
[ -z "$E8_CALL_LINE" ] || [ "$GATE_LINE" -lt "$E8_CALL_LINE" ] &&
  ok "live gate precedes the first driver invocation" ||
  ko "a driver is invoked before the V_LIVE gate"

# --- 3. SH_WORKERS / SH_TURNS_PER_WORKER carry no default. ----------------------------------
grep -qE 'SH_WORKERS:?-[^}]' run-experiments.sh &&
  ko "SH_WORKERS must have no default (it must match the running supervisor)" ||
  ok "SH_WORKERS carries no default"
grep -qE 'SH_TURNS_PER_WORKER:?-[^}]' run-experiments.sh &&
  ko "SH_TURNS_PER_WORKER must have no default (§3.8: S is an OUTPUT of E8, not a runner default)" ||
  ok "SH_TURNS_PER_WORKER carries no default"

# --- 4. One shared configuration feeds BOTH drivers -- not two separately-configured calls. --
# Every knob that must match across E8 and E9 is exported exactly once, before either driver
# runs, so both processes inherit the identical value rather than each defaulting on its own.
for var in V_LADDER V_DEGRADE_X V_MIN_C V_CONNS_PER_SESSION V_DUTY_BASIS V_METRICS_BASE; do
  N="$(grep -c "^export $var=" run-experiments.sh || true)"
  [ "$N" = 1 ] && ok "exports $var exactly once, shared by both drivers" ||
    ko "$var must be exported exactly once so E8 and E9 cannot diverge (found $N export sites)"
done

# --- 5. The stub profile is shared too: half the claim per §5.2's run-record table. ---------
for var in SH_STUB_TTFT_MS SH_STUB_TOKEN_DELAY_MS SH_STUB_OUTPUT_TOKENS SH_STUB_TOOL_CALL_RATE; do
  grep -q "$var" run-experiments.sh && ok "shares $var across both drivers" ||
    ko "missing shared stub-profile knob: $var"
done

# --- 6. E9 is skipped, not failed, when there is no cluster to compare against. -------------
grep -qE 'KSVC_URL' run-experiments.sh && grep -qE 'V_STUB_URL' run-experiments.sh &&
  ok "gates the E9 invocation on KSVC_URL/V_STUB_URL" ||
  ko "must skip E9 (not fail the whole run) when no cluster is configured"
grep -q '\./e9-tiers\.sh' run-experiments.sh && ok "invokes e9-tiers.sh when a cluster is present" ||
  ko "runner never invokes e9-tiers.sh"

# --- 7. This is the STUB-DRIVEN path, and the runner says so -- it must not read like proof ---
# that the VM path works against a real model. That confusion is exactly what v-live-gate.sh
# exists to prevent, so the runner must name it rather than let its own silence imply coverage.
grep -qi 'stub-driven' run-experiments.sh && ok "labels itself the stub-driven measurement path" ||
  ko "runner must say it is the stub-driven path, or its output can be mistaken for validation"
grep -q 'v-live-gate\.sh' run-experiments.sh && ok "points at v-live-gate.sh for the real-model claim" ||
  ko "runner must reference v-live-gate.sh so the two paths stay distinguishable"
grep -qiE 'NOT proof|not proof|does not prove' run-experiments.sh &&
  ok "disclaims proof-of-genuineness for the stub path" ||
  ko "runner must explicitly disclaim that a stub run proves the VM path works end to end"

# --- 8. No headline-number vocabulary lives in the runner itself; the drivers own that. -----
grep -qE 'E8_RESULT|E9_RESULT|knee_floor' run-experiments.sh &&
  ko "runner should not fabricate result vocabulary itself -- that belongs to the drivers" ||
  ok "runner composes no result line of its own"

# --- 9. shellcheck, like every other script in deploy/. -------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x run-experiments.sh >"$TMP/sc.log" 2>&1 && ok "shellcheck clean" ||
    { ko "shellcheck found problems"; cat "$TMP/sc.log"; }
else
  echo "# shellcheck not installed; skipping"
fi

[ "$FAIL" = 0 ] || exit 1
echo "# run-experiments structural tests passed"
