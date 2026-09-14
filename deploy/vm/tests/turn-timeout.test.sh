#!/usr/bin/env bash
# vm_turn must carry a per-turn deadline, and a timed-out turn must become DATA, not a stall.
#
# Its absence cost a full ladder run. When all four supervisor workers exited simultaneously
# mid-rung (a Redis client leak, fixed separately), the four turns in flight on them were never
# answered — and with no --max-time the curl blocked forever, the rung's `wait` never returned, and
# the driver sat at 874/960 for 19 minutes until it was killed by hand, having reported nothing.
# There is no rung-level deadline either, so this per-turn one is the only bound in the design.
#
# The behaviour that makes a timeout useful rather than merely safe: curl exits 28 on --max-time but
# STILL emits its -w output, with %{http_code}=000. So the turn lands in `attempts` and not in
# `ok_n`, which drags the rung's success rate under the 0.95 floor and gets it correctly reported as
# "not a capacity result" — instead of hanging the ladder.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

# --- 1. The flag is present on vm_turn's curl. ------------------------------------------------
BODY="$(sed -n '/^vm_turn() {/,/^}/p' lib-vm.sh)"
if printf '%s' "$BODY" | grep -q -- '--max-time'; then
  ok "vm_turn passes --max-time"
else
  ko "vm_turn has no --max-time: one unanswered turn hangs the whole ladder"
fi

# --- 2. It is operator-overridable, with a default. -------------------------------------------
if printf '%s' "$BODY" | grep -qE 'V_TURN_TIMEOUT_S:-[0-9]+'; then
  ok "the deadline is overridable via V_TURN_TIMEOUT_S with a default"
else
  ko "no V_TURN_TIMEOUT_S default: the deadline is either hardcoded or absent"
fi

# --- 3. The default is generous against the measured p95, not a guess. -------------------------
# Measured p95 stayed ~1.42s even at c=64, so anything below ~10s risks clipping real turns and
# manufacturing failures — which would be worse than the hang, because it would look like a result.
DEF="$(printf '%s' "$BODY" | grep -oE 'V_TURN_TIMEOUT_S:-[0-9]+' | head -1 | grep -oE '[0-9]+$')"
if [ -n "$DEF" ] && [ "$DEF" -ge 10 ]; then
  ok "default deadline is ${DEF}s, comfortably above the measured p95 (~1.42s)"
else
  ko "default deadline '$DEF' is too tight against a ~1.42s p95 — it would clip real turns"
fi

# --- 4. Behaviour: curl really does emit -w output on a timeout, with http_code 000. -----------
# This is the property the whole design leans on. Verified against a real socket rather than
# asserted: a listener that accepts and never responds is exactly the observed failure.
if command -v python3 >/dev/null 2>&1; then
  PORT=0
  PIDFILE="$(mktemp)"
  PORTFILE="$(mktemp)"
  python3 - "$PORTFILE" <<'PY' &
import socket, sys, time
s = socket.socket()
s.bind(('127.0.0.1', 0))
s.listen(4)
open(sys.argv[1], 'w').write(str(s.getsockname()[1]))
# Accept and then hold: never write a response. This is the hang being defended against.
conns = []
end = time.time() + 20
while time.time() < end:
    s.settimeout(0.5)
    try:
        c, _ = s.accept()
        conns.append(c)
    except OSError:
        pass
PY
  echo $! >"$PIDFILE"
  for _ in $(seq 1 40); do
    PORT="$(cat "$PORTFILE" 2>/dev/null)"
    [ -n "$PORT" ] && break
    sleep 0.1
  done
  if [ -n "$PORT" ] && [ "$PORT" != "0" ]; then
    OUT="$(curl -s --max-time 2 -o /dev/null -w '%{time_total}\t%{http_code}' \
      -XPOST "http://127.0.0.1:$PORT/turn" -d '{}' || true)"
    CODE="${OUT#*$'\t'}"
    if [ "$CODE" = "000" ]; then
      ok "a timed-out turn yields http_code 000 (counted as an attempt, not a success)"
    else
      ko "expected http_code 000 from a timed-out turn, got '$CODE' (raw: $(printf '%q' "$OUT"))"
    fi
    # And it must have returned in roughly the deadline, not hung.
    SECS="${OUT%%$'\t'*}"
    if awk -v s="$SECS" 'BEGIN { exit !(s > 0 && s < 10) }' 2>/dev/null; then
      ok "it returned after about the deadline (${SECS}s), rather than blocking"
    else
      ko "timed-out turn reported an implausible duration '${SECS}'"
    fi
  else
    echo "ok - SKIP: could not bind a local listener to exercise the timeout"
  fi
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE" "$PORTFILE"
else
  echo "ok - SKIP: python3 absent, cannot stand up a hanging listener"
fi

# --- 5. A 000 must not be counted as a success anywhere. --------------------------------------
# Both drivers filter percentiles and ok_n on `$2==200`, so a 000 is excluded from latency and from
# the success count by construction. Guard that, since counting it either way would hide the hang.
for f in e8-density.sh e9-tiers.sh; do
  if grep -q '\$2==200' "$f"; then
    ok "$f counts only 200s toward its latency sample"
  else
    ko "$f no longer filters its latency sample on status 200"
  fi
done

exit "$FAIL"
