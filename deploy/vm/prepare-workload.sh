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
# USAGE (on the target, as root)
#
#   ./prepare-workload.sh                 # seed + calibrate, print the SH_STUB_TOOL_INPUT
#   TARGET_MS=470 ./prepare-workload.sh   # aim for a different cost
#   SH_SANDBOX_COUNT=6 ./prepare-workload.sh
#
# It is idempotent: re-running reseeds from scratch.
set -euo pipefail

: "${SH_SANDBOX_COUNT:=3}"
: "${TARGET_MS:=470}"          # spec §2.3's git-operation cost on network-attached storage
: "${TOLERANCE_MS:=120}"       # accept TARGET +/- this; the band, not a point, is what matters
: "${WORKSPACE:=/workspace}"
: "${MAX_ROUNDS:=8}"
: "${FILES_START:=64}"

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

command -v podman >/dev/null || die "podman not found; run this on the target"
[ "$(id -u)" -eq 0 ] || die "run as root: the sandboxes are under root podman (setup-vm.sh requires root)"

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

==> calibrated: $files files, median ${ms}ms per tool call (target ${TARGET_MS}ms)

Start the model stub with this, so a tool call costs what spec §2.3's duty basis assumes:

  SH_STUB_TOOL_INPUT='{"command":"$TURN_CMD"}'

Record BOTH the file count and the measured cost in the run record: the number is a property of this
box's storage, not of the software, so a run on different hardware must recalibrate rather than reuse
it. The stub's /profile reports the tool-call RATE; it cannot report the tool call's COST, so the cost
has no other witness.
EOF
}

main "$@"
