#!/usr/bin/env bash
# E8 must not select a knee from a rung that failed the 0.95 success-rate floor.
#
# EXPERIMENTS.md: "Below a 95% success rate at a rung, that rung is not a capacity result and must
# not be quoted as one." The knee IS the quote, so warning about such a rung and then selecting it
# is the same defect the WARN exists to catch, one level up. Observed on the first authoritative
# run: c=16 succeeded on 360/480 (0.75) and c=32 on 360/960 (0.38), and knee_floor came back 16.
# Neither knee criterion can catch it by construction -- the filtered p95 excludes every failure so
# it stayed flat at ~1420ms on EVERY rung, and throughput plateaus at whatever the arm completed
# rather than falling.
#
# The second bug this guards is subtler and cost a whole run: the success counts live in $RECORDS,
# the rich per-rung array, NOT in $POINTS, the lean {c, throughput, p95Ms} array detectKnee
# consumes. Reading .attempts off $POINTS yields null, `null > 0` is false, and the ladder truncates
# at its FIRST rung -- refusing a perfectly healthy c=1 as "below the success floor".
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

# --- 1. The cut index must be computed from RECORDS, which is where ok_n/attempts live. --------
CUT_LINE="$(grep -n 'CUT_INDEX=' e8-density.sh | head -1 | cut -d: -f1)"
if [ -z "$CUT_LINE" ]; then
  ko "no CUT_INDEX computation found -- the success floor does not gate knee selection"
elif sed -n "${CUT_LINE},$((CUT_LINE + 3))p" e8-density.sh | grep -q 'RECORDS'; then
  ok "the success-floor cut is computed from \$RECORDS"
else
  ko "the cut is not computed from \$RECORDS -- reading ok_n/attempts off \$POINTS yields null and truncates at the first rung"
fi

# --- 2. detectKnee must be fed the truncated array, not the raw one. --------------------------
if grep -q '"\$POINTS_FOR_KNEE"' e8-density.sh; then
  ok "detectKnee is fed \$POINTS_FOR_KNEE"
else
  ko "detectKnee is not fed a truncated array"
fi
if grep -E '^\s*'"'"'\s+"\$POINTS"\s+"\$DEGRADE_X"' e8-density.sh | grep -q .; then
  ko "detectKnee is still passed the untruncated \$POINTS"
else
  ok "detectKnee is not passed the untruncated \$POINTS"
fi

# --- 3. A ladder with nothing left must refuse rather than report. ----------------------------
if grep -q 'every rung fell below the 0.95 success-rate floor' e8-density.sh; then
  ok "an all-failing ladder is refused rather than reported"
else
  ko "an all-failing ladder is not explicitly refused"
fi

# --- 4. Behaviour: the cut expression on a REALISTIC rich array. ------------------------------
# Mirrors the first authoritative run exactly, including its integer types.
RICH='[{"c":1,"ok_n":30,"attempts":30},{"c":2,"ok_n":60,"attempts":60},
       {"c":4,"ok_n":120,"attempts":120},{"c":8,"ok_n":240,"attempts":240},
       {"c":16,"ok_n":360,"attempts":480},{"c":32,"ok_n":360,"attempts":960}]'
GOT="$(printf '%s' "$RICH" | jq -r '
  (map((.attempts // 0) > 0 and ((.ok_n // 0) / (.attempts // 1)) >= 0.95) | index(false)) as $i |
  if $i == null then -1 else $i end')"
if [ "$GOT" = "4" ]; then
  ok "the cut lands on c=16 (index 4), the first rung below the floor"
else
  ko "the cut index was '$GOT', expected 4"
fi

# --- 5. Behaviour: a fully healthy ladder must NOT be truncated. ------------------------------
CLEAN='[{"c":1,"ok_n":30,"attempts":30},{"c":2,"ok_n":60,"attempts":60}]'
GOT="$(printf '%s' "$CLEAN" | jq -r '
  (map((.attempts // 0) > 0 and ((.ok_n // 0) / (.attempts // 1)) >= 0.95) | index(false)) as $i |
  if $i == null then -1 else $i end')"
if [ "$GOT" = "-1" ]; then
  ok "a fully healthy ladder is not truncated"
else
  ko "a healthy ladder was truncated at index '$GOT' -- this is the c=1 false-positive that cost a run"
fi

# --- 6. Behaviour: the LEAN array must be sliceable by that index. ----------------------------
# The regression in one line: $POINTS has no ok_n/attempts, so it must be SLICED by an index found
# elsewhere, never filtered on fields it does not carry.
LEAN='[{"c":1,"throughput":0.9,"p95Ms":1089},{"c":2,"throughput":1.7,"p95Ms":1414},
       {"c":4,"throughput":3.4,"p95Ms":1422},{"c":8,"throughput":7.0,"p95Ms":1422},
       {"c":16,"throughput":10.4,"p95Ms":1427},{"c":32,"throughput":10.4,"p95Ms":1414}]'
GOT="$(printf '%s' "$LEAN" | jq -c --argjson i 4 '[.[0:$i][].c]')"
if [ "$GOT" = "[1,2,4,8]" ]; then
  ok "slicing the lean array by the cut index keeps exactly the capacity rungs"
else
  ko "slicing the lean array gave '$GOT', expected [1,2,4,8]"
fi
# And prove the naive version really is broken, so check 1 is not decoration.
GOT="$(printf '%s' "$LEAN" | jq -r '(map(.attempts > 0) | index(false)) // "null"')"
if [ "$GOT" = "0" ]; then
  ok "confirmed: reading .attempts off the lean array truncates at index 0"
else
  ko "expected the naive predicate to fail at index 0 on the lean array, got '$GOT'"
fi

exit "$FAIL"
