#!/usr/bin/env bash
# Seed each sandbox with a git working copy and calibrate a per-turn tool command against the duty
# basis, then print the SH_STUB_TOOL_INPUT to run the stub with.
#
# WHY THIS EXISTS
#
# E8's tool call defaults to `ls -la /workspace` -- a few milliseconds at most. Spec §2.3's duty
# bases, which E8 quotes and which `duty_basis_sandbox_floor` derives its precondition from, were
# measured against workloads whose git operations cost ~470ms on network-attached storage. So the
# shipped configuration exercises the hands tier STRUCTURALLY (the exec really does traverse
# relay -> leaf -> container) while it carries almost no load, and the measured duty cycle therefore
# describes a cheaper workload than the basis it is compared against. Concurrency figures from that
# configuration are optimistic against their own basis.
#
# This script does not guess the fix. It seeds a realistic workspace, MEASURES what a candidate
# command actually costs in the sandbox, and tunes the corpus size until the cost lands in the
# target band -- because the cost depends on the box's storage, and a hardcoded number would be a
# fabricated basis of exactly the kind this rig exists to refuse.
#
# WHAT IS CALIBRATED, AND WHY IT IS NOT A MILLISECOND FIGURE
#
# An earlier version of this script aimed at ~470ms per tool call, that being the reference
# workload's git cost. That is the wrong target. The quantity the rest of the rig computes from is
# the DUTY -- `sandboxFloor = ceil(W * S * duty)` and `N ~ 1/duty` both use it, and it is what the
# §2.3 table records -- and duty is not a millisecond figure:
#
#   duty = toolCallRate * toolCostMs / turnMs
#
# With the stub's own turn at ttft + outputTokens * tokenDelay = 1068ms and its shipped rate of 0.07,
# a 470ms tool call yields duty 0.031 -- less than half the e6-ocp band. Aiming at 470ms would have
# produced a run still incomparable with its own denominator, just less obviously so.
#
# So this script solves for the cost that lands DUTY in the basis band, given the rate and turn
# duration the stub actually reports. All four numbers go in the output, because a duty quoted
# without them cannot be checked.
#
# A related trap, worth knowing before changing the rate: SH_STUB_TOOL_CALL_RATE's default of 0.07 is
# numerically equal to the e6-ocp duty but is a DIFFERENT quantity -- the README defines it as the
# fraction of turns emitting a tool_use block, whereas duty is the fraction of wall time a sandbox is
# occupied. They coincide only if a tool call occupies the sandbox for exactly one turn's duration.
# Back-solving the reference workload (470ms of git inside a ~7s real-model turn) puts its actual
# tool-call rate near 1, not 0.07.
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
: "${MAX_ROUNDS:=8}"
: "${FILES_START:=64}"
: "${TSX:=../../experiments/node_modules/.bin/tsx}"

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

command -v podman >/dev/null || die "podman not found; run this on the target"
command -v curl >/dev/null || die "curl not found"
[ "$(id -u)" -eq 0 ] || die "run as root: the sandboxes are under root podman (setup-vm.sh requires root)"

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
# process actually generating the load rather than from this shell's idea of it -- the same reason
# both drivers fetch /profile instead of echoing their own environment.
read_stub_profile() {
  curl -sf --max-time 5 "$STUB_URL/profile" ||
    die "cannot reach the model stub at $STUB_URL/profile. Start it first: the turn duration and
    tool-call rate must come from the stub, because a duty computed from assumed values describes a
    workload nobody ran."
}

sandboxes() {
  local i
  for ((i = 0; i < SH_SANDBOX_COUNT; i++)); do echo "sh-sandbox-$i"; done
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

# Seed a repo with `files` files across a few commits, so `git diff`/`log`/`status` have real work.
# Content is generated deterministically so two sandboxes and two runs are comparable -- a random
# corpus would make the calibrated cost unreproducible, which is the same defect as a fabricated one.
seed_one() {
  local sb="$1" files="$2"
  podman exec "$sb" sh -c "
    set -e
    rm -rf $WORKSPACE/repo
    mkdir -p $WORKSPACE/repo
    cd $WORKSPACE/repo
    git init -q .
    git config user.email harness@example.invalid
    git config user.name harness
    i=0
    while [ \$i -lt $files ]; do
      # ~200 deterministic lines per file: awk is in coreutils, so no extra capability is needed.
      awk -v n=\$i 'BEGIN { for (l = 0; l < 200; l++) print \"pkg\" n \" line \" l \" tok\" (l * n % 97) }' > f\$i.txt
      i=\$((i + 1))
    done
    git add -A
    git commit -q -m base
    # A second commit touching a third of the corpus, so HEAD~1 diffs are non-trivial.
    i=0
    while [ \$i -lt $files ]; do
      if [ \$((i % 3)) -eq 0 ]; then echo 'edited' >> f\$i.txt; fi
      i=\$((i + 1))
    done
    git add -A
    git commit -q -m edit
  "
}

# The per-turn command being calibrated. Read-mostly and idempotent: it must not mutate the repo, or
# turn N would measure a different workspace from turn 1 and the rungs would not be comparable.
TURN_CMD='cd /workspace/repo && git status --porcelain && git diff HEAD~1 --stat && git log --oneline -20 && grep -rl tok42 . | head -20'

# Median of N runs inside the sandbox. Median, not mean: a single page-cache miss on the first run
# would drag a mean and misreport the steady-state cost the duty basis describes.
measure_ms() {
  local sb="$1" runs="${2:-5}"
  podman exec "$sb" sh -c "
    i=0
    while [ \$i -lt $runs ]; do
      s=\$(date +%s%N)
      $TURN_CMD >/dev/null 2>&1 || true
      e=\$(date +%s%N)
      echo \$(( (e - s) / 1000000 ))
      i=\$((i + 1))
    done
  " | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }'
}

main() {
  preflight

  # --- what duty are we aiming at, and what cost does that imply here? ------------------------
  local dlow dhigh cite
  read -r dlow dhigh cite <<<"$(read_duty_band)"
  log "duty basis $BASIS: $dlow-$dhigh [$cite]"

  local profile turn_ms rate
  profile="$(read_stub_profile)"
  # turnMs is the stub's own turn: time-to-first-token plus every token's delay.
  read -r turn_ms rate <<<"$(printf '%s' "$profile" | python3 -c '
import json, sys
p = json.load(sys.stdin)
print(p["ttftMs"] + p["outputTokens"] * p["tokenDelayMs"], p["toolCallRate"])
')"
  log "stub profile: turn ${turn_ms}ms, toolCallRate $rate"
  [ "$(printf '%s' "$rate" | awk '{ exit !($1 > 0) }' && echo ok)" = ok ] ||
    die "toolCallRate is $rate: with no tool calls the sandbox is never occupied, so no corpus size
    can reach a non-zero duty. Start the stub with a non-zero SH_STUB_TOOL_CALL_RATE."

  # cost = duty * turnMs / rate, at the middle of the band.
  local target_ms tol_ms
  read -r target_ms tol_ms <<<"$(python3 -c "
low, high, turn, rate = $dlow, $dhigh, $turn_ms, $rate
mid = (low + high) / 2
target = mid * turn / rate
# The band's own width, expressed in milliseconds of tool cost, so the tolerance is the basis's
# rather than a number invented here.
tol = (high - low) / 2 * turn / rate
print(int(round(target)), max(1, int(round(tol))))
")"
  log "to land duty in $dlow-$dhigh at rate $rate, a tool call must cost ${target_ms}ms (+/- ${tol_ms}ms)"

  # A required cost at or above the whole turn means the rate is too low to reach this duty at all:
  # the sandbox would have to be busy for longer than the turn that is using it.
  if [ "$target_ms" -ge "$turn_ms" ]; then
    die "the required tool cost (${target_ms}ms) is not below the turn duration (${turn_ms}ms), so
    rate $rate cannot reach duty $dlow-$dhigh: a tool call would have to occupy the sandbox for
    longer than the turn making it. Raise SH_STUB_TOOL_CALL_RATE -- 0.5 gives EVERY=2, the smallest
    value that avoids the rate-1.0 degeneracy where every response is another tool_use (an infinite
    tool loop). At rate 0.5 the required cost is about $((turn_ms / 14))ms."
  fi

  local TARGET_MS="$target_ms" TOLERANCE_MS="$tol_ms"
  local files="$FILES_START" round=0 ms=0
  while [ "$round" -lt "$MAX_ROUNDS" ]; do
    round=$((round + 1))
    log "round $round: seeding sh-sandbox-0 with $files files"
    seed_one sh-sandbox-0 "$files"
    ms="$(measure_ms sh-sandbox-0)"
    log "round $round: the candidate command costs ${ms}ms (target ${TARGET_MS} +/- ${TOLERANCE_MS})"

    local low=$((TARGET_MS - TOLERANCE_MS)) high=$((TARGET_MS + TOLERANCE_MS))
    if [ "$ms" -ge "$low" ] && [ "$ms" -le "$high" ]; then
      log "in band after $round round(s)"
      break
    fi
    [ "$ms" -gt 0 ] || die "measured 0ms -- date +%s%N is not giving nanoseconds in this image"
    # Cost is roughly linear in corpus size; scale toward the target and clamp the step so one wild
    # reading cannot send the search somewhere it takes every remaining round to walk back.
    local next=$((files * TARGET_MS / ms))
    [ "$next" -lt $((files / 4)) ] && next=$((files / 4))
    [ "$next" -gt $((files * 4)) ] && next=$((files * 4))
    [ "$next" -lt 4 ] && next=4
    files="$next"
  done

  local low=$((TARGET_MS - TOLERANCE_MS)) high=$((TARGET_MS + TOLERANCE_MS))
  if [ "$ms" -lt "$low" ] || [ "$ms" -gt "$high" ]; then
    die "could not reach ${TARGET_MS}+/-${TOLERANCE_MS}ms in $MAX_ROUNDS rounds (last: ${ms}ms at
    $files files). Do NOT run E8 against an uncalibrated workload and quote it against the duty
    basis -- either widen TOLERANCE_MS deliberately and record that, or investigate why the cost
    does not scale here."
  fi

  log "seeding the remaining sandbox(es) with the calibrated $files files"
  local sb
  for sb in $(sandboxes); do
    [ "$sb" = sh-sandbox-0 ] && continue
    seed_one "$sb" "$files"
  done

  # Verify every sandbox actually lands in band, not just the one used to search. A sandbox that was
  # seeded but is slower (different storage, a busy neighbour) would skew whichever rungs lease it.
  for sb in $(sandboxes); do
    local each
    each="$(measure_ms "$sb" 3)"
    log "$sb: ${each}ms"
    if [ "$each" -lt "$low" ] || [ "$each" -gt "$high" ]; then
      die "$sb measures ${each}ms, outside the band. Rungs that lease it would carry a different
      workload from rungs that lease the others, and the ladder would not be comparable."
    fi
  done

  cat <<EOF

==> calibrated against the $BASIS duty band

  corpus                 $files files
  tool cost (median)     ${ms}ms      (target ${TARGET_MS} +/- ${TOLERANCE_MS})
  stub turn              ${turn_ms}ms
  tool-call rate         $rate
  DERIVED DUTY           $(python3 -c "print(round($rate * $ms / $turn_ms, 4))")   (band $dlow-$dhigh)

Start the model stub with this, so the sandbox is occupied for the fraction of wall time the §2.3
basis actually describes:

  SH_STUB_TOOL_INPUT='{"command":"$TURN_CMD"}'

Record ALL FIVE numbers above in the run record, not just the duty. duty = rate * cost / turn, so a
duty quoted without its three inputs cannot be checked, and the cost is a property of THIS box's
storage -- a run on different hardware must recalibrate rather than reuse it. The stub's /profile
reports the rate and the turn duration; nothing reports the cost, so it has no other witness.

Do NOT carry this corpus size to another box, and do not quote a density number against $BASIS
without showing the derived duty.
EOF
}

main "$@"
