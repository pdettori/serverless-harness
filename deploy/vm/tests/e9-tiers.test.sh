#!/usr/bin/env bash
# Structural tests for deploy/vm/e9-tiers.sh — chiefly that §5.3's two pins are enforced by
# the driver, not merely described in a comment.
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

# --- 1. Inert without the gate. ------------------------------------------------------------
SKIP_RESULTS="$TMP/should-not-exist-EXPERIMENTS.md"
OUT="$(V_LIVE=0 V_RESULTS="$SKIP_RESULTS" ./e9-tiers.sh 2>&1)"
RC=$?
[ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q 'SKIP' && ok "skips without V_LIVE=1" ||
  ko "should SKIP and exit 0 without V_LIVE=1 (rc=$RC)"

# A skip must not have created or touched the results file, same property e8-density.test.sh
# asserts: silence on stdout is not proof nothing was written.
[ -e "$SKIP_RESULTS" ] && ko "a SKIP wrote a run record ($SKIP_RESULTS exists)" ||
  ok "SKIP writes no record"

GATE_LINE="$(grep -n 'V_LIVE' e9-tiers.sh | head -1 | cut -d: -f1)"
TRAP_LINE="$(grep -n '^trap ' e9-tiers.sh | head -1 | cut -d: -f1)"
[ -z "$TRAP_LINE" ] || [ "$GATE_LINE" -lt "$TRAP_LINE" ] &&
  ok "live gate precedes the EXIT trap" ||
  ko "trap before gate: a SKIP would restore ksvc env on a cluster it never touched"

# The KSVC_URL/V_STUB_URL required-variable checks must ALSO precede the trap: a missing
# variable exits via `:?`, and if the trap were already installed that exit would run
# restore_ksvc_env's real kubectl patch calls against a cluster this invocation never
# configured. Same hazard as the live gate above, same fix.
REQVAR_LINE="$(grep -n ':?' e9-tiers.sh | head -1 | cut -d: -f1)"
[ -n "$REQVAR_LINE" ] || ko "no required-variable (:?) check found for KSVC_URL/V_STUB_URL"
[ -z "$TRAP_LINE" ] || [ -z "$REQVAR_LINE" ] || [ "$REQVAR_LINE" -lt "$TRAP_LINE" ] &&
  ok "KSVC_URL/V_STUB_URL required-var checks precede the EXIT trap" ||
  ko "trap before required-var check: a missing var would restore ksvc env on an unconfigured cluster"

# The ladder c=1 gate must ALSO precede the trap: a typo'd V_LADDER (no c=1 rung) exits via
# `exit 1` right after this check, and if the trap were already installed that exit would run
# restore_ksvc_env's real kubectl patch calls against a cluster this invocation never
# configured. Same hazard as the live gate and the required-var checks above, same fix.
LADDER_GATE_LINE="$(grep -n 'no c=1' e9-tiers.sh | head -1 | cut -d: -f1)"
[ -n "$LADDER_GATE_LINE" ] || ko "no ladder c=1 gate found (grep for 'no c=1 baseline rung')"
[ -z "$TRAP_LINE" ] || [ -z "$LADDER_GATE_LINE" ] || [ "$LADDER_GATE_LINE" -lt "$TRAP_LINE" ] &&
  ok "ladder c=1 gate precedes the EXIT trap" ||
  ko "trap before ladder gate: a typo'd V_LADDER would restore ksvc env on a cluster it never configured"

# --- 2. PIN ONE: both arms drive the same stub. --------------------------------------------
grep -q 'ANTHROPIC_BASE_URL' e9-tiers.sh && ok "points an arm at the stub via ANTHROPIC_BASE_URL" ||
  ko "the Knative arm MUST be re-run against the same stub (§5.3) — no ANTHROPIC_BASE_URL"
grep -qE 'set_ksvc_env|kubectl set env' e9-tiers.sh &&
  ok "sets the stub URL on the Knative Service, not just locally" ||
  ko "the stub URL never reaches the cluster arm"
grep -qiE 'reuse.*E6|E6 numbers' e9-tiers.sh &&
  ok "explains why E6's existing numbers are not reused" ||
  ko "must state that E6's real-model numbers are NOT comparable and are re-run"

# --- 3. PIN TWO: both arms on relay + gRPC. -----------------------------------------------
grep -qE 'SH_REMOTE_SANDBOX=1' e9-tiers.sh && ok "remote sandbox on" ||
  ko "both arms must run the relay path (§5.3)"
grep -qi 'persistentExecInPod' e9-tiers.sh &&
  ok "addresses persistentExecInPod explicitly" ||
  ko "must disable the Knative arm's fast exec channel, or the VM is penalised for a tool-tier difference"
grep -qi '245' e9-tiers.sh && ok "cites #245 for the missing gRPC fast channel" ||
  ko "should cite #245 so the deferral is traceable"

# --- 4. Both arms run the SAME ladder and the driver records what it actually did. --------
grep -q 'conns_per_turn' e9-tiers.sh && ok "records conns_per_turn" ||
  ko "conns_per_turn must be recorded (§5.2) — what the driver actually does, not a knob"
[ "$(grep -c 'V_LADDER' e9-tiers.sh)" -ge 1 ] && ok "one ladder variable feeds both arms" ||
  ko "each arm must run the same ladder"

# --- 5. No ceiling claims; the comparison is of floors. -----------------------------------
grep -qi 'floor' e9-tiers.sh && ok "results labelled floors" || ko "must label results as floors"

# --- 5b. Every point records attempts/non200, and percentiles are success-only. -----------
for field in attempts non200; do
  grep -q "$field" e9-tiers.sh && ok "records $field" || ko "missing point field: $field"
done
grep -qE "\\\$2==200" e9-tiers.sh && ok "percentile input is filtered to 200-coded rows" ||
  ko "p95 must be computed over 200-coded rows only, not the mixed raw sample"
grep -qi '0.95' e9-tiers.sh && ok "driver names a success-rate floor" ||
  ko "driver must WARN below a stated success-rate floor (see EXPERIMENTS.md)"

# --- 5c. sanityFloorPass's .pass is consumed (ko when false), not discarded, and the "floors" --
# prose is conditional on whether a genuine knee was actually found — mirrors e8-density.sh's
# own PASS/SATURATED/TOP_RUNG pattern. Before this fix, .pass was extracted and thrown away
# (only .knee was read) and the run-record prose unconditionally asserted "Both are floors:
# each ladder topped out..." even when detectKnee found a real knee below the top rung.
grep -q '\.pass' e9-tiers.sh && ok "consumes sanityFloorPass's .pass, not just .knee" ||
  ko "knee_of returns {knee, pass} but .pass must actually be read and acted on (ko when false)"
grep -qi 'SATURATED' e9-tiers.sh && ok "tracks per-arm saturation, mirroring e8-density.sh's TOP_RUNG/SATURATED pattern" ||
  ko "must record whether each arm's knee is a genuine bound or merely the ladder's own ceiling"
# The "Both are floors" sentence must not be the ONLY prose branch — there must be at least one
# conditional arm (an elif) covering the case where a genuine knee was found.
grep -q 'elif \[ "\$VM_SATURATED"' e9-tiers.sh && ok "\"floors\" prose is conditional on per-arm saturation" ||
  ko "the topped-out-ladder prose must not run unconditionally when a genuine knee was found"

# --- 6. shellcheck. -----------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x e9-tiers.sh >/dev/null 2>&1 && ok "shellcheck clean" || ko "shellcheck found problems"
else
  echo "# shellcheck not installed; skipping"
fi

[ "$FAIL" = 0 ] || exit 1
echo "# e9-tiers structural tests passed"
