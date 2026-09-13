#!/usr/bin/env bash
# Executable tests for the tsx -e argv-plumbing shared by e8-density.sh and e9-tiers.sh.
#
# Every other *.test.sh in this directory is a grep over script text or an in-process TS call;
# none of them shells out to a `tsx -e` snippet with real argv, which is exactly the shape that
# hid the argv-index-off-by-one bug: `tsx -e '...' -- "$A" "$B" "$C"` has no script-path slot in
# process.argv the way `node script.js "$A" "$B" "$C"` does, so process.argv[1]/[2]/[3] ARE
# "$A"/"$B"/"$C" -- reading argv[2]/[3]/[4] (as if a script path occupied argv[1]) silently reads
# past its own args. This file invokes the two snippet SHAPES the drivers use -- knee detection
# and basis resolution -- with known inputs, from deploy/vm's own CWD so the snippets' relative
# imports ("../../experiments/src/...") resolve exactly as they do for the real drivers, and
# asserts the exact JSON that comes back. It also runs the OLD (`--`, argv[2..4]) shape as a
# negative control, to demonstrate this file would have caught the bug it was written for.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=./lib-vm.sh
source ./lib-vm.sh
FAIL=0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

require_tsx

# --- knee-detection snippet, byte-for-byte the corrected shape both drivers call ------------
# baseline (c=1) p95=100ms, bound=degradeX(2)*100=200ms; c=2's p95=120<=200 and throughput
# 18>=10, so c=2 is healthy and becomes the knee. sanityFloorPass(2, 1) is true. Computed by
# hand against experiments/src/sharing.ts's detectKnee/sanityFloorPass, not copied from any
# driver's output.
POINTS='[{"c":1,"throughput":10,"p95Ms":100},{"c":2,"throughput":18,"p95Ms":120}]'
KNEE_OUT="$("$TSX" -e '
  import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
  const points = JSON.parse(process.argv[1]);
  const knee = detectKnee(points, Number(process.argv[2]), 2);
  console.log(JSON.stringify({ knee, pass: sanityFloorPass(knee, Number(process.argv[3])) }));
' "$POINTS" "2" "1" 2>"$TMP/knee.err")"
echo "knee snippet stdout: $KNEE_OUT"
KNEE_VAL="$(printf '%s' "$KNEE_OUT" | jq -r .knee 2>/dev/null || echo)"
KNEE_PASS="$(printf '%s' "$KNEE_OUT" | jq -r .pass 2>/dev/null || echo)"
[ "$KNEE_VAL" = "2" ] && ok "knee snippet reads argv[1..3] correctly (knee=2)" ||
  { ko "knee snippet did not return knee=2 (got '$KNEE_VAL')"; cat "$TMP/knee.err"; }
[ "$KNEE_PASS" = "true" ] && ok "knee snippet's sanityFloorPass reads its own argv[3] (pass=true)" ||
  ko "knee snippet's pass should be true for minC=1 (got '$KNEE_PASS')"

# --- basis-resolution snippet, byte-for-byte e8-density.sh's corrected shape ----------------
# sandboxFloor(4, 8, 0.079) = max(1, ceil(4*8*0.079)) = ceil(2.528) = 3, and
# assertBasisConsistent(0.079, 12.6) does not throw (derivedRatio(0.079) ~= 12.7, within the 15%
# tolerance) -- both computed by hand against experiments/src/basis.ts, not copied from any
# driver's output.
BASIS_OUT="$("$TSX" -e '
  import { resolveBasis, sandboxFloor, describeBasis, assertBasisConsistent } from "../../experiments/src/basis.ts";
  const b = resolveBasis(process.argv[1]);
  const [w, s] = [Number(process.argv[2]), Number(process.argv[3])];
  assertBasisConsistent(b.duty[1], b.ratio[0]);
  console.log(JSON.stringify({ describe: describeBasis(b), floor: sandboxFloor(w, s, b.duty[1]) }));
' "e6-ocp" "4" "8" 2>"$TMP/basis.err")"
echo "basis snippet stdout: $BASIS_OUT"
BASIS_DESC="$(printf '%s' "$BASIS_OUT" | jq -r .describe 2>/dev/null || echo)"
BASIS_FLOOR="$(printf '%s' "$BASIS_OUT" | jq -r .floor 2>/dev/null || echo)"
printf '%s' "$BASIS_DESC" | grep -q 'e6-ocp' && ok "basis snippet resolves argv[1] as the basis name" ||
  { ko "basis snippet did not resolve 'e6-ocp' from argv[1] (got '$BASIS_DESC')"; cat "$TMP/basis.err"; }
[ "$BASIS_FLOOR" = "3" ] && ok "basis snippet computes the exact sandbox floor from argv[2]/argv[3] (floor=3)" ||
  { ko "basis snippet did not compute floor=3 from argv[2]=4 argv[3]=8 (got '$BASIS_FLOOR')"; cat "$TMP/basis.err"; }

# --- negative controls: the OLD (`--`, argv[2..4]) shape must fail, proving this file would ---
# have caught the bug it exists to guard against. Same snippet bodies as the drivers carried
# before this fix, unchanged; only the invocation (`-- ... argv[2..4]`) differs from above.
OLD_KNEE_OUT="$("$TSX" -e '
  import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
  const points = JSON.parse(process.argv[2]);
  const knee = detectKnee(points, Number(process.argv[3]), 2);
  console.log(JSON.stringify({ knee, pass: sanityFloorPass(knee, Number(process.argv[4])) }));
' -- "$POINTS" "2" "1" 2>"$TMP/old-knee.err")"
OLD_KNEE_RC=$?
if [ "$OLD_KNEE_RC" -ne 0 ] && grep -q 'points.find is not a function' "$TMP/old-knee.err"; then
  ok "negative control: pre-fix knee shape throws 'points.find is not a function' (this test would have caught it)"
else
  ko "negative control did not reproduce the pre-fix knee failure (rc=$OLD_KNEE_RC, stdout='$OLD_KNEE_OUT')"
  cat "$TMP/old-knee.err"
fi

OLD_BASIS_OUT="$("$TSX" -e '
  import { resolveBasis, sandboxFloor, describeBasis, assertBasisConsistent } from "../../experiments/src/basis.ts";
  const b = resolveBasis(process.argv[2]);
  const [w, s] = [Number(process.argv[3]), Number(process.argv[4])];
  assertBasisConsistent(b.duty[1], b.ratio[0]);
  console.log(JSON.stringify({ describe: describeBasis(b), floor: sandboxFloor(w, s, b.duty[1]) }));
' -- "e6-ocp" "4" "8" 2>"$TMP/old-basis.err")"
OLD_BASIS_RC=$?
if [ "$OLD_BASIS_RC" -ne 0 ] && grep -q "is not one of" "$TMP/old-basis.err"; then
  ok "negative control: pre-fix basis shape throws on a mistaken argv (this test would have caught it)"
else
  ko "negative control did not reproduce the pre-fix basis failure (rc=$OLD_BASIS_RC, stdout='$OLD_BASIS_OUT')"
  cat "$TMP/old-basis.err"
fi

[ "$FAIL" = 0 ] || exit 1
echo "# tsx argv-plumbing tests passed"
