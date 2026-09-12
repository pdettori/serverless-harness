#!/usr/bin/env bash
# Shared helpers for the P6 VM experiment drivers (E8, E9). Sourced, never executed.

ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  # shellcheck disable=SC2034  # read by the driver script that sources this file, not here
  FAIL=1
}

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# p50/p95 from newline-separated integers on stdin. Nearest-rank, no interpolation — the same
# convention lib.sh's median uses, so E6 and E8 percentiles are comparable.
percentile() {
  local p="$1"
  sort -n | awk -v p="$p" '{a[NR]=$1} END {
    if (NR==0) { print "NaN"; exit }
    i=int((p/100)*NR+0.9999); if (i<1) i=1; if (i>NR) i=NR; print a[i]
  }'
}

# One turn against the supervisor. Prints elapsed ms and the HTTP status, tab-separated, so the
# caller can separate "slow" from "refused" — conflating them is how a 429 storm reads as a knee.
vm_turn() {
  local base="$1" sid="$2" body="$3" t0 code
  t0="$(now_ms)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$base/turn" \
    -H 'content-type: application/json' -H "X-SH-Session-Id: $sid" -d "$body" || echo 000)"
  printf '%s\t%s\n' "$(($(now_ms) - t0))" "$code"
}

# Event-loop lag p99 and RSS per worker, from the supervisor's loopback ADMIN listener (plan 1
# Task 11) — deliberately not the data port, which parses nothing per connection in the default
# leastInFlight mode and must keep it that way. Falls back to NaN rather than 0: a missing metric
# must be visibly missing in the record, because a 0 would read as "no lag" and would exonerate
# the tier that actually saturated.
worker_metrics() {
  local base="${1:-$METRICS_BASE}"
  curl -s --max-time 5 "$base/metrics" 2>/dev/null || echo '{}'
}

# Sum of container CPU seconds across the sandbox pool — the `bash -c` churn term in §5.2.
sandbox_cpu_seconds() {
  podman stats --no-stream --format '{{.CPU}}' 2>/dev/null |
    tr -d '%' | awk '{s+=$1} END {printf "%.2f", s+0}'
}

# Highest simultaneous lease count observed in a sampling window; an under-provisioned pool
# shows up here first, and mistaking it for worker saturation attributes the knee to the wrong
# tier (§5.2).
max_leases_seen() {
  local log="$1"
  awk '{if ($1>m) m=$1} END {print m+0}' "$log" 2>/dev/null || echo 0
}
