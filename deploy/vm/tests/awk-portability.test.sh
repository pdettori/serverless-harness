#!/usr/bin/env bash
# awk portability regression for the drivers' throughput computation.
#
# Both drivers compute a rung's throughput with an awk ternary. Written WITHOUT parentheses --
# `printf "%.3f", ms>0 ? n*1000/ms : 0` -- it is a hard syntax error under gawk, which is the
# system awk on Ubuntu and Amazon Linux, i.e. on every VM these drivers are meant to run on:
#
#   awk: cmd. line:1: BEGIN {printf "%.3f", ms>0 ? n*1000/ms : 0}
#   awk: cmd. line:1:                            ^ syntax error
#
# macOS's BWK awk accepts it, which is exactly why this shipped: it was authored and tested on a
# Mac and aborted the E8 run at the FIRST rung on real hardware (under `set -e`, the failing
# assignment ends the driver). Every existing test in this directory is a grep over script text or
# an in-process unit call, so none of them executed this expression.
#
# This file therefore does both halves, following tsx-argv.test.sh's pattern: it RUNS the
# expression under whatever awk is installed here, and it GREPS both drivers so that reverting the
# parentheses fails the suite rather than passing it.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

# --- 1. The parenthesised form must actually run under THIS awk and yield the right number. ----
# n=5 successes over ms=1000 wall-milliseconds is 5.000 turns/second.
OUT="$(awk -v n=5 -v ms=1000 'BEGIN {printf "%.3f", (ms>0 ? n*1000/ms : 0)}' 2>&1)"
if [ "$OUT" = "5.000" ]; then
  ok "parenthesised ternary runs under $(basename "$(readlink -f "$(command -v awk)")") and yields 5.000"
else
  ko "parenthesised ternary did not yield 5.000 under this awk: got '$OUT'"
fi

# --- 2. The ms=0 guard must yield 0, not a divide-by-zero. ------------------------------------
# This is the branch that exists so a rung whose wall time rounds to zero reports 0 throughput
# rather than aborting -- and detectKnee treats 0 throughput as unhealthy, which is the intent.
OUT="$(awk -v n=5 -v ms=0 'BEGIN {printf "%.3f", (ms>0 ? n*1000/ms : 0)}' 2>&1)"
if [ "$OUT" = "0.000" ]; then
  ok "ms=0 guard yields 0.000 rather than a divide-by-zero"
else
  ko "ms=0 guard did not yield 0.000: got '$OUT'"
fi

# --- 3. Revert guard: neither driver may carry an UNPARENTHESISED printf ternary. -------------
# Matches `printf "<fmt>", <something> ? ` -- i.e. a ternary that begins immediately after
# printf's format argument with no opening parenthesis. grep -c with `|| true` so a zero count
# (the passing case) does not trip `set -e`-style aborts in callers.
#
# Comment lines are stripped FIRST, because both drivers deliberately quote the broken form in a
# comment to explain why the parentheses matter -- without this, the guard fires on its own
# documentation, which is how the first version of this test failed.
for f in e8-density.sh e9-tiers.sh; do
  N="$(grep -vE '^[[:space:]]*#' "$f" |
    grep -cE 'printf[^,]*,[[:space:]]*[^(,]+[[:space:]]*\?' || true)"
  if [ "$N" = "0" ]; then
    ok "$f has no unparenthesised printf ternary"
  else
    ko "$f has $N unparenthesised printf ternary/ternaries -- gawk will reject it at run time"
  fi
done

# --- 4. Both drivers must still compute a throughput at all. ----------------------------------
# Guards the reverse mistake: 'fixing' item 3 by deleting the computation.
for f in e8-density.sh e9-tiers.sh; do
  if grep -qE 'n\*1000/ms' "$f"; then
    ok "$f still computes turns/second from successes and wall time"
  else
    ko "$f no longer computes a throughput"
  fi
done

exit "$FAIL"
