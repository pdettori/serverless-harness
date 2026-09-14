#!/usr/bin/env bash
# prepare-workload.sh must MEASURE duty, not compute it from the stub's profile.
#
# Two earlier versions were wrong, and the second is the interesting one.
#
# v1 aimed at ~470ms per tool call -- the reference workload's git cost. Wrong target: what the rig
# computes from is duty (`sandboxFloor = ceil(W*S*duty)`, `N ~ 1/duty`), not a millisecond figure.
#
# v2 aimed at duty, but DERIVED it as `rate * cost / (ttft + outputTokens*tokenDelay)`. That model was
# wrong twice over, and both errors were only visible by driving real turns:
#
#   - SH_STUB_TOOL_CALL_RATE is per REQUEST, and a tool turn spends TWO requests (the tool_use, then
#     the follow-up after the tool result). At rate 0.5 the tool fires on every even request, which is
#     once per TURN: an effective calls-per-turn of 1.0, not 0.5. Measured: 10 turns, 10 execs.
#   - `ttft + outputTokens*tokenDelay` is ONE model response. A tool turn pays a short tool_use
#     response, the exec, then a full 64-token response: 1068ms computed vs 1579ms measured.
#
# They pull opposite ways and do not cancel. The model reported duty 0.0707 while the measured value
# was 0.0950 -- above the band while claiming to be inside it. Which is why the contract is now
# "count the execs, time the turns, divide", and why this file pins that rather than any formula.
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

# --- 1. No hardcoded millisecond target, and no transcribed duty numbers. ----------------------
if printf '%s' "$CODE" | grep -qE '^\s*:\s*"\$\{TARGET_MS:='; then
  ko "$S takes TARGET_MS as an input -- the target must come from the duty band"
else
  ok "no hardcoded millisecond target"
fi
if printf '%s' "$CODE" | grep -qE '0\.061|0\.079'; then
  ko "$S has duty numbers transcribed into it"
else
  ok "no duty numbers transcribed into the script"
fi
if printf '%s' "$CODE" | grep -q 'resolveBasis'; then
  ok "the duty band comes from experiments/src/basis.ts"
else
  ko "the duty band is not read from basis.ts -- a transcribed number will drift"
fi

# --- 2. Duty is MEASURED: real turns are driven, and execs are counted. ------------------------
# This is the load-bearing property. A script that models duty from the profile cannot see either of
# the two errors described above.
if printf '%s' "$CODE" | grep -q '\$BASE/turn'; then
  ok "duty is measured by driving real turns through the supervisor"
else
  ko "no turns are driven -- duty is being modelled rather than measured"
fi
if printf '%s' "$CODE" | grep -q 'COUNTER' && printf '%s' "$CODE" | grep -q 'wc -l'; then
  ok "sandbox execs are COUNTED, not inferred from the tool-call rate"
else
  ko "execs are not counted -- calls-per-turn cannot be read off the rate (that was the v2 defect)"
fi
# And the formula that was wrong must not be back.
if printf '%s' "$CODE" | grep -qE 'rate \* cost|cost / turn_ms|mid \* turn / rate'; then
  ko "the profile-derived duty formula is back in the script"
else
  ok "duty is not derived from rate x cost / computed-turn"
fi

# --- 3. It refuses rather than reporting a number it cannot stand behind. ----------------------
for pat in 'no sandbox exec was recorded' 'could not land duty' 'cannot pin a duty'; do
  if printf '%s' "$CODE" | grep -q "$pat"; then
    ok "refuses: '$pat'"
  else
    ko "missing refusal: '$pat'"
  fi
done
if printf '%s' "$CODE" | grep -q 'SH_STUB_TOOL_CALL_RATE'; then
  ok "a zero tool-call rate is refused, naming the knob"
else
  ko "a zero tool-call rate is not refused"
fi

# --- 4. The output carries every input, so the duty can be checked. ---------------------------
for want in 'MEASURED DUTY' 'execs per turn' 'mean turn' 'per-exec cost' 'tool-call rate' 'repeat count'; do
  if printf '%s' "$CODE" | grep -q "$want"; then
    ok "the output reports '$want'"
  else
    ko "the output omits '$want' -- a duty without its inputs cannot be checked"
  fi
done

# --- 5. The timed command must be brace-wrapped before the redirect. --------------------------
# `$cmd >/dev/null 2>&1` on a CHAIN redirects only the last command, so earlier output contaminates
# the timing samples. On the rig that made the median come back as a filename.
if printf '%s' "$CODE" | grep -qE '\{ \$cmd ; \} >/dev/null'; then
  ok "the timed command is brace-wrapped, so all of its output is redirected"
else
  ko "the timed command is not brace-wrapped -- earlier commands in the chain will leak into the samples"
fi
# Demonstrate the precedence, so this is a fact rather than a claim.
LEAK="$(bash -c 'eval "echo LEAKED && echo x | cat >/dev/null 2>&1"' 2>/dev/null)"
if [ "$LEAK" = "LEAKED" ]; then
  ok "confirmed: an unwrapped redirect on a chain leaks earlier output"
else
  ko "expected the unwrapped form to leak 'LEAKED', got '$LEAK'"
fi

# --- 6. The counter must NOT be left in the shipped workload. ---------------------------------
# It exists for calibration; leaving it would grow a file unboundedly across a real ladder.
if printf '%s' "$CODE" | grep -q 'restart_stub_final'; then
  ok "the stub is left running the workload without the exec counter"
else
  ko "no final restart -- the shipped workload would keep appending to the counter file"
fi

exit "$FAIL"
