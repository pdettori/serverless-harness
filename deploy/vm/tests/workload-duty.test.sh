#!/usr/bin/env bash
# prepare-workload.sh must calibrate against DUTY, not against a millisecond figure.
#
# Its first version aimed at ~470ms per tool call, that being the reference workload's git cost. Wrong
# target: what the rest of the rig computes from is the duty -- `sandboxFloor = ceil(W * S * duty)` and
# `N ~ 1/duty` both use it -- and duty is
#
#   duty = toolCallRate * toolCostMs / turnMs
#
# At the stub's own turn (300 + 64*12 = 1068ms) and its shipped rate of 0.07, a 470ms tool call gives
# duty 0.031, less than half the e6-ocp band. Aiming at 470ms would have produced a run still
# incomparable with its own denominator, only less obviously so.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

S=prepare-workload.sh
[ -f "$S" ] || {
  echo "not ok - $S missing"
  exit 1
}
CODE="$(grep -vE '^\s*#' "$S")"

# --- 1. No hardcoded millisecond target. -------------------------------------------------------
if printf '%s' "$CODE" | grep -qE '^\s*:\s*"\$\{TARGET_MS:='; then
  ko "$S still takes TARGET_MS as an input -- the target must be DERIVED from the duty band"
else
  ok "no hardcoded millisecond target"
fi

# --- 2. The duty band is read from basis.ts, not transcribed. ----------------------------------
# Transcribing 0.061/0.079 here is exactly the drift the §2.3 conventions exist to prevent, and
# basis.ts throws on an unknown or blended row, so reading it is also the validation.
if printf '%s' "$CODE" | grep -q 'resolveBasis'; then
  ok "the duty band comes from experiments/src/basis.ts"
else
  ko "the duty band is not read from basis.ts -- a transcribed number will drift"
fi
if printf '%s' "$CODE" | grep -qE '0\.061|0\.079'; then
  ko "$S has duty numbers transcribed into it"
else
  ok "no duty numbers transcribed into the script"
fi

# --- 3. Rate and turn duration come from the stub's /profile. ---------------------------------
# duty needs both, and taking either from this shell would describe a workload nobody ran -- the same
# reason both drivers fetch /profile rather than echoing their own environment.
if printf '%s' "$CODE" | grep -q '/profile'; then
  ok "the rate and turn duration are read from the stub's /profile"
else
  ko "the script does not read the stub's /profile"
fi

# --- 4. The output reports the derived duty and its three inputs. -----------------------------
for want in 'DERIVED DUTY' 'tool-call rate' 'stub turn' 'tool cost'; do
  if printf '%s' "$CODE" | grep -q "$want"; then
    ok "the output reports '$want'"
  else
    ko "the output omits '$want' -- a duty without its inputs cannot be checked"
  fi
done

# --- 5. The arithmetic, and the case it must refuse. ------------------------------------------
# At the shipped rate the required cost equals the whole turn, which is impossible: a tool call cannot
# occupy the sandbox for longer than the turn making it. The script must die naming the fix rather
# than calibrating toward something unreachable.
read -r IMPOSSIBLE POSSIBLE <<<"$(python3 -c "
turn = 300 + 64 * 12
low, high = 0.061, 0.079
mid = (low + high) / 2
print('yes' if mid * turn / 0.07 >= turn else 'no',
      'yes' if mid * turn / 0.5 < turn else 'no')
")"
if [ "$IMPOSSIBLE" = yes ]; then
  ok "at rate 0.07 the required cost is not below the turn -- the refusal branch is reachable"
else
  ko "expected rate 0.07 to be unreachable at this turn duration; the premise of the guard is wrong"
fi
if [ "$POSSIBLE" = yes ]; then
  ok "at rate 0.5 the required cost is achievable"
else
  ko "expected rate 0.5 to be achievable"
fi
if printf '%s' "$CODE" | grep -q 'cannot reach duty'; then
  ok "the script refuses an unreachable duty rather than calibrating toward it"
else
  ko "no refusal for a rate that cannot reach the duty band"
fi
# And the refusal must name the remedy, not just the failure.
if printf '%s' "$CODE" | grep -q 'SH_STUB_TOOL_CALL_RATE'; then
  ok "the refusal names the knob to change"
else
  ko "the refusal does not tell the operator what to change"
fi

exit "$FAIL"
