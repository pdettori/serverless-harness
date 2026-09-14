#!/usr/bin/env bash
# Seed each sandbox with a git working copy and calibrate a per-turn tool command against the duty
# basis, then print the SH_STUB_TOOL_INPUT to run the stub with.
#
# WHY THIS EXISTS
#
# E8's tool call defaults to `ls -la /workspace` -- a few milliseconds at most. Spec §2.3's duty
# bases, which E8 quotes and which `duty_basis_sandbox_floor` derives its precondition from, describe
# workloads that occupy a sandbox 6.1-7.9% of the time. So the shipped configuration exercises the
# hands tier STRUCTURALLY (the exec really does traverse relay -> leaf -> container) while it carries
# almost no load, and the measured duty cycle therefore describes a cheaper workload than the basis it
# is compared against. Concurrency figures from that configuration are optimistic against their own
# denominator.
#
# WHAT IS CALIBRATED, AND WHY IT IS NOT A MILLISECOND FIGURE
#
# An earlier version aimed at ~470ms per tool call, that being the reference workload's git cost. Wrong
# target. The quantity the rest of the rig computes from is the DUTY -- `sandboxFloor = ceil(W*S*duty)`
# and `N ~ 1/duty` both use it -- and duty is not a millisecond figure:
#
#   duty = toolCallRate * toolCostMs / turnMs
#
# With the stub's own turn at ttft + outputTokens*tokenDelay = 1068ms and its shipped rate of 0.07, a
# 470ms tool call yields duty 0.031, less than half the e6-ocp band. So this script solves for the cost
# that lands DUTY in the band, given the rate and turn duration the stub actually reports, and prints
# all of them plus the derived duty -- a duty quoted without its inputs cannot be checked.
#
# A related trap, worth knowing before changing the rate: SH_STUB_TOOL_CALL_RATE's default of 0.07 is
# numerically equal to the e6-ocp duty but is a DIFFERENT quantity -- the README defines it as the
# fraction of turns emitting a tool_use block, whereas duty is the fraction of wall time a sandbox is
# occupied. They coincide only if a tool call occupies the sandbox for exactly one turn's duration.
# Back-solving the reference workload (470ms of git inside a ~7s real-model turn) puts its actual rate
# near 1, not 0.07. At rate 0.07 this script REFUSES, because the required cost is not below the turn.
#
# WHY THE KNOB IS A REPEAT COUNT AND NOT THE CORPUS SIZE
#
# Growing the corpus is the obvious approach and it does not work. Measured on the rig: 1024 files cost
# 68ms, 2258 cost 55ms, 6158 cost 99ms -- non-monotonic, because at that size the cost is dominated by
# page-cache state rather than by the work. The search converged on a median (153ms) that an immediate
# re-measurement of the same sandbox did not reproduce (117ms).
#
# That is not a tolerance to widen. A per-turn cost that swings +/-30% makes the duty swing +/-30%, and
# duty is what the comparison rests on -- so an unstable workload is not a basis even when its median
# lands in the band. A repo small enough to stay in cache, iterated N times, has a cost that is linear
# and repeatable in N. N is the knob.
#
# USAGE (on the target, as root)
#
#   ./prepare-workload.sh                       # calibrate against the e6-ocp duty band
#   BASIS=e6-kind ./prepare-workload.sh         # a different §2.3 row
#   SH_SANDBOX_COUNT=6 ./prepare-workload.sh
#   STUB_URL=http://127.0.0.1:18081 ./prepare-workload.sh
#
# It is idempotent: re-running reseeds from scratch.
set -euo pipefail

: "${SH_SANDBOX_COUNT:=3}"
: "${BASIS:=e6-ocp}"
: "${WORKSPACE:=/workspace}"
: "${STUB_URL:=http://127.0.0.1:18081}"
: "${MAX_ROUNDS:=10}"
: "${REPS_START:=8}"
: "${SAMPLES:=9}"
# Maximum acceptable (max-min)/median across samples. A workload noisier than this cannot pin a duty.
: "${MAX_SPREAD_PCT:=35}"
: "${TSX:=../../experiments/node_modules/.bin/tsx}"
# Fixed, deliberately small: large enough that git has real work per iteration, small enough to stay
# in page cache so the cost is repeatable.
: "${FILES:=256}"

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

command -v podman >/dev/null || die "podman not found; run this on the target"
command -v curl >/dev/null || die "curl not found"
command -v python3 >/dev/null || die "python3 not found"
[ "$(id -u)" -eq 0 ] || die "run as root: the sandboxes are under root podman (setup-vm.sh requires root)"

sandboxes() {
  local i
  for ((i = 0; i < SH_SANDBOX_COUNT; i++)); do echo "sh-sandbox-$i"; done
}

# The duty band comes from experiments/src/basis.ts, never from a number typed here. That file throws
# on an unknown basis and on a blended row, so reading it is also the validation -- and transcribing
# 0.061/0.079 into this script would be exactly the drift the §2.3 conventions exist to prevent.
read_duty_band() {
  cd "$(dirname "$0")"
  [ -x "$TSX" ] || die "tsx not found at $TSX (run pnpm install in the workspace; see require_tsx in lib-vm.sh)"
  "$TSX" -e '
    import { resolveBasis } from "../../experiments/src/basis.ts";
    const b = resolveBasis(process.argv[1]);
    console.log(`${b.duty[0]} ${b.duty[1]} ${b.cite}`);
  ' "$BASIS"
}

# The stub reports its RESOLVED profile, so the turn duration and tool-call rate are read from the
# process actually generating the load rather than from this shell's idea of it -- the same reason both
# drivers fetch /profile instead of echoing their own environment.
read_stub_profile() {
  curl -sf --max-time 5 "$STUB_URL/profile" ||
    die "cannot reach the model stub at $STUB_URL/profile. Start it first: the turn duration and
    tool-call rate must come from the stub, because a duty computed from assumed values describes a
    workload nobody ran."
}

# Every sandbox must exist and carry git, or the workload cannot be what the basis assumes. The leaf
# advertises git in its `probed` capability list, so a sandbox without it is also advertising falsely.
preflight() {
  local sb
  for sb in $(sandboxes); do
    podman inspect "$sb" >/dev/null 2>&1 || die "$sb is not running (run setup-vm.sh first)"
    podman exec "$sb" sh -c 'command -v git >/dev/null' ||
      die "$sb has no git. The leaf advertises git in cmd/worker/main.go's \`probed\` list, so this
      image is advertising a capability it lacks -- rebuild with an image that installs it. Without
      git the tool call cannot resemble the workload spec §2.3's duty bases were measured from."
    podman exec "$sb" test -d "$WORKSPACE" ||
      die "$sb has no $WORKSPACE. Every exec would die on \`cd\` before running anything."
  done
  log "preflight ok: $SH_SANDBOX_COUNT sandbox(es), git present, $WORKSPACE present"
}

# Seed a repo with $FILES files across two commits, so status/diff/log all have real work. Content is
# generated deterministically so two sandboxes and two runs are comparable -- a random corpus would
# make the calibrated cost unreproducible, which is the same defect as a fabricated one.
seed_one() {
  local sb="$1"
  podman exec "$sb" sh -c "
    set -e
    rm -rf $WORKSPACE/repo
    mkdir -p $WORKSPACE/repo
    cd $WORKSPACE/repo
    git init -q .
    git config user.email harness@example.invalid
    git config user.name harness
    i=0
    while [ \$i -lt $FILES ]; do
      awk -v n=\$i 'BEGIN { for (l = 0; l < 200; l++) print \"pkg\" n \" line \" l \" tok\" (l * n % 97) }' > f\$i.txt
      i=\$((i + 1))
    done
    git add -A
    git commit -q -m base
    i=0
    while [ \$i -lt $FILES ]; do
      if [ \$((i % 3)) -eq 0 ]; then echo 'edited' >> f\$i.txt; fi
      i=\$((i + 1))
    done
    git add -A
    git commit -q -m edit
  "
}

# The per-turn command: a read-mostly git chain, repeated $1 times. Read-mostly and idempotent, or turn
# N would measure a different workspace from turn 1 and the rungs would not be comparable.
turn_cmd() {
  printf 'cd %s/repo && n=0; while [ $n -lt %d ]; do git status --porcelain; git diff HEAD~1 --stat; git log --oneline -20; n=$((n+1)); done' \
    "$WORKSPACE" "$1"
}

# Raw per-run millisecond samples.
#
# The command is wrapped in braces before the redirect. Written `$cmd >/dev/null 2>&1` the redirect
# binds to the LAST simple command only -- `&&` and `;` bind looser -- so every earlier command still
# wrote to stdout, its output mixed into the timing samples, and the median came back as a FILENAME.
# The `grep -E` is belt and braces on the same class: only pure integers can reach the median.
measure_raw() {
  local sb="$1" reps="$2" runs="${3:-$SAMPLES}" cmd
  cmd="$(turn_cmd "$reps")"
  podman exec "$sb" sh -c "
    i=0
    while [ \$i -lt $runs ]; do
      s=\$(date +%s%N)
      { $cmd ; } >/dev/null 2>&1 || true
      e=\$(date +%s%N)
      echo \$(( (e - s) / 1000000 ))
      i=\$((i + 1))
    done
  " | grep -E '^[0-9]+$'
}

# "median spread_pct". Both are needed: a stable median with a wide spread is still not a basis,
# because the duty it implies varies run to run. The cheapest sample is dropped as the cold-cache
# warm-up, so what is reported is the steady-state cost the §2.3 bases describe.
measure_stats() {
  measure_raw "$1" "$2" "${3:-$SAMPLES}" | python3 -c '
import sys
xs = sorted(int(l) for l in sys.stdin if l.strip().isdigit())
if not xs:
    print("")
    raise SystemExit
xs = xs[1:] or xs
med = xs[len(xs) // 2]
spread = 0 if med == 0 else round(100 * (xs[-1] - xs[0]) / med)
print(f"{med} {spread}")
'
}

require_numeric() {
  case "${1:-}" in
  '' | *[!0-9]*)
    die "the measurement returned '${1:-<empty>}', which is not a millisecond count. Something other
    than the timing lines reached the median -- check that the timed command's output is fully
    redirected inside measure_raw."
    ;;
  esac
}

main() {
  preflight

  local dlow dhigh cite
  read -r dlow dhigh cite <<<"$(read_duty_band)"
  log "duty basis $BASIS: $dlow-$dhigh [$cite]"

  local profile turn_ms rate
  profile="$(read_stub_profile)"
  read -r turn_ms rate <<<"$(printf '%s' "$profile" | python3 -c '
import json, sys
p = json.load(sys.stdin)
print(p["ttftMs"] + p["outputTokens"] * p["tokenDelayMs"], p["toolCallRate"])
')"
  log "stub profile: turn ${turn_ms}ms, toolCallRate $rate"
  printf '%s' "$rate" | awk '{ exit !($1 > 0) }' ||
    die "toolCallRate is $rate: with no tool calls the sandbox is never occupied, so no repeat count
    can reach a non-zero duty. Start the stub with a non-zero SH_STUB_TOOL_CALL_RATE."

  local target_ms tol_ms
  read -r target_ms tol_ms <<<"$(python3 -c "
low, high, turn, rate = $dlow, $dhigh, $turn_ms, $rate
mid = (low + high) / 2
print(int(round(mid * turn / rate)), max(1, int(round((high - low) / 2 * turn / rate))))
")"
  log "to land duty in $dlow-$dhigh at rate $rate, a tool call must cost ${target_ms}ms (+/- ${tol_ms}ms)"

  # A required cost at or above the whole turn means the rate is too low to reach this duty at all: the
  # sandbox would have to be busy for longer than the turn using it.
  if [ "$target_ms" -ge "$turn_ms" ]; then
    local at_half
    at_half="$(python3 -c "print(int(round(($dlow + $dhigh) / 2 * $turn_ms / 0.5)))")"
    die "the required tool cost (${target_ms}ms) is not below the turn duration (${turn_ms}ms), so
    rate $rate cannot reach duty $dlow-$dhigh: a tool call would have to occupy the sandbox for longer
    than the turn making it. Raise SH_STUB_TOOL_CALL_RATE -- 0.5 gives EVERY=2, the smallest value that
    avoids the rate-1.0 degeneracy where every response is another tool_use (an infinite tool loop). At
    rate 0.5 the required cost would be about ${at_half}ms."
  fi

  local low=$((target_ms - tol_ms)) high=$((target_ms + tol_ms))

  log "seeding sh-sandbox-0 with $FILES files (fixed; the repeat count is the knob)"
  seed_one sh-sandbox-0

  local reps="$REPS_START" round=0 ms=0 spread=0
  while [ "$round" -lt "$MAX_ROUNDS" ]; do
    round=$((round + 1))
    read -r ms spread <<<"$(measure_stats sh-sandbox-0 "$reps")"
    require_numeric "$ms"
    log "round $round: reps=$reps costs ${ms}ms (spread ${spread}%, target $target_ms +/- $tol_ms)"
    [ "$ms" -gt 0 ] ||
      die "measured 0ms at reps=$reps: either the command is too cheap to time at millisecond
      resolution, or \`date +%s%N\` is not giving nanoseconds in this image."
    if [ "$ms" -ge "$low" ] && [ "$ms" -le "$high" ]; then
      log "in band after $round round(s)"
      break
    fi
    # Cost is linear in reps, so scale straight at the target; clamp the step so one noisy reading
    # cannot send the search somewhere it takes every remaining round to walk back.
    local next=$((reps * target_ms / ms))
    [ "$next" -lt $((reps / 4)) ] && next=$((reps / 4))
    [ "$next" -gt $((reps * 4)) ] && next=$((reps * 4))
    [ "$next" -lt 1 ] && next=1
    [ "$next" = "$reps" ] && next=$((reps + 1))
    reps="$next"
  done

  if [ "$ms" -lt "$low" ] || [ "$ms" -gt "$high" ]; then
    die "could not land duty in $dlow-$dhigh within $MAX_ROUNDS rounds (last: ${ms}ms at reps=$reps,
    target ${target_ms}+/-${tol_ms}). Do NOT run E8 against an uncalibrated workload and quote it
    against this basis."
  fi
  if [ "$spread" -gt "$MAX_SPREAD_PCT" ]; then
    die "the cost varies ${spread}% across samples (limit ${MAX_SPREAD_PCT}%), so this workload cannot
    pin a duty: the duty would vary by the same proportion during a run. Reduce \$FILES so the repo
    stays in page cache, or raise \$SAMPLES, before treating any number from it as a basis."
  fi

  log "seeding the remaining sandbox(es)"
  local sb
  for sb in $(sandboxes); do
    [ "$sb" = sh-sandbox-0 ] && continue
    seed_one "$sb"
  done

  # Verify EVERY sandbox lands in band, not just the one the search used. A sandbox that is slower
  # (different storage, a busy neighbour) would give rungs that lease it a different workload from
  # rungs that lease the others, and the ladder would not be comparable.
  for sb in $(sandboxes); do
    local each espread
    read -r each espread <<<"$(measure_stats "$sb" "$reps")"
    require_numeric "$each"
    log "$sb: ${each}ms (spread ${espread}%)"
    if [ "$each" -lt "$low" ] || [ "$each" -gt "$high" ]; then
      die "$sb measures ${each}ms, outside $low-$high. Rungs that lease it would carry a different
      workload from rungs that lease the others."
    fi
    if [ "$espread" -gt "$MAX_SPREAD_PCT" ]; then
      die "$sb's cost varies ${espread}% across samples (limit ${MAX_SPREAD_PCT}%)."
    fi
  done

  local duty
  duty="$(python3 -c "print(round($rate * $ms / $turn_ms, 4))")"
  cat <<EOF

==> calibrated against the $BASIS duty band

  repo                   $FILES files (fixed)
  repeat count           $reps      <-- the calibrated knob
  tool cost (median)     ${ms}ms    (target ${target_ms} +/- ${tol_ms}, spread ${spread}%)
  stub turn              ${turn_ms}ms
  tool-call rate         $rate
  DERIVED DUTY           $duty   (band $dlow-$dhigh)

Start the model stub with this, so the sandbox is occupied for the fraction of wall time the §2.3
basis actually describes:

  SH_STUB_TOOL_INPUT='{"command":"$(turn_cmd "$reps")"}'

Record ALL of the above in the run record, not just the duty. duty = rate * cost / turn, so a duty
quoted without its three inputs cannot be checked, and the cost is a property of THIS box's storage --
a run on different hardware must recalibrate rather than reuse it. The stub's /profile reports the rate
and the turn duration; nothing reports the cost, so it has no other witness.
EOF
}

main "$@"
