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
#
# CURL_OPTS/CURL_HDR are read as globals here, the same way deploy/knative/lib.sh itself treats
# them (BASE/CURL_OPTS/CURL_HDR are globals there too, read at ~16 call sites) — this is that
# file's own convention, not a new one. It matters because e9-tiers.sh's Knative arm sources
# knative/lib.sh, which sets CURL_OPTS="-k..." whenever KSVC_URL is a Route (self-signed/ingress
# cert); without threading that through here, every Knative /turn request fails TLS verification,
# `|| echo 000` swallows it, and the arm reports a perfect floor for zero successful requests.
# e8-density.sh sources ONLY this file, never knative/lib.sh, so on that path CURL_OPTS/CURL_HDR
# are not merely empty, they are undeclared. `${CURL_OPTS:-}` and the `${CURL_HDR[@]+...}`
# existence test (lib.sh's own array guard) keep this safe under `set -u` either way. Against
# E8's plain http://127.0.0.1 target, CURL_OPTS is empty and CURL_HDR unset, so -k is simply
# absent and E8's request is byte-for-byte what it was before.
vm_turn() {
  local base="$1" sid="$2" body="$3" t0 code
  t0="$(now_ms)"
  # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
  code="$(curl -s ${CURL_OPTS:-} -o /dev/null -w '%{http_code}' -XPOST "$base/turn" \
    ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
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
  # -f: curl itself fails (rather than returning the error body as if it were a metrics
  # payload) on a non-2xx response. Piped through `jq -c .` to validate the body actually
  # parses as JSON before it reaches a caller — a base pointed at the DATA port (which parses
  # nothing per connection in leastInFlight mode, see the comment above) rather than the admin
  # port would otherwise hand a caller plain text/HTML, which used to reach jq downstream (in
  # the caller) and abort the whole run under `set -e`. Either failure mode falls back to '{}',
  # matching the same "missing metric reads NaN, not 0" contract this function already documents.
  curl -sf --max-time 5 "$base/metrics" 2>/dev/null | jq -c . 2>/dev/null || echo '{}'
}

# Sum of container CPU seconds across the sandbox pool — the `bash -c` churn term in §5.2.
sandbox_cpu_seconds() {
  podman stats --no-stream --format '{{.CPU}}' 2>/dev/null |
    tr -d '%' | awk '{s+=$1} END {printf "%.2f", s+0}'
}

# tsx is a devDependency of experiments/ only, never root-hoisted, and deploy/ is not a
# workspace package -- `npx tsx` from either driver's CWD walks upward through node_modules,
# finds nothing, and either hard-fails offline or silently runs an unpinned fetched copy online
# (deploy/vm/systemd/sh-supervisor.service documents this exact bug class already hit once).
# Calling the workspace's own shim directly keeps resolution CWD-independent while leaving the
# driver's CWD, and therefore its import specifiers, unchanged.
TSX="../../experiments/node_modules/.bin/tsx"

# Same shape as require_build's preflight in setup-vm.sh: fail loudly and name the exact
# remediation rather than let a heredoc die later with ERR_MODULE_NOT_FOUND. Callers invoke this
# AFTER their own live gate, so a V_LIVE=0 run SKIPs and exits 0 without ever testing for tsx.
require_tsx() {
  [ -x "$TSX" ] || {
    echo "workspace is not built: $TSX is not executable (pnpm install has not run)" >&2
    echo "run: pnpm install" >&2
    exit 1
  }
}

# Dead-arm guard, shared by e8-density.sh and e9-tiers.sh (originally e9-tiers.sh-only; lifted
# here so no third caller can omit it by omission). Fires when an arm's c=1 baseline rung sees
# ZERO successful (200) responses. Without this, detectKnee (experiments/src/sharing.ts) seeds
# `best` from the c=1 throughput; if that throughput is 0, `cur.throughput >= best` is `0 >= 0`,
# trivially true forever, so a dead arm reports the ladder's TOP rung as a clean "floor" instead
# of erroring. Must fire regardless of *why* c=1 saw no 200s — wrong URL, expired cert, firewall,
# crashed revision, a dead supervisor that still answers /health — because none of those reasons
# make the resulting number less fabricated.
#
# Callers must do any of their OWN cleanup (e.g. removing a function-local work dir) BEFORE
# calling this: on a dead arm it calls `exit 1` rather than returning, so nothing after the call
# in the caller ever runs. `ko` (defined above) echoes to stdout by design — normally read by
# callers via `grep -q`, not captured — so callers whose stdout IS their return channel (e.g.
# e9-tiers.sh's run_arm, which prints a JSON points array to stdout for its caller to capture)
# must not let this function's message leak into that channel; hence the explicit >&2 here.
#
# Args: $1 = the rung's c (only fires when this is 1, the baseline rung); $2 = the success
# (200) count observed at that rung; $3 = a label naming the arm; $4 = the arm's base URL.
require_live_arm() {
  local rung="$1" ok_n="$2" label="$3" base="$4"
  [ "$rung" -eq 1 ] && [ "$ok_n" -eq 0 ] || return 0
  ko "$label arm: ZERO 200 responses at c=1 ($base) — refusing to run the ladder against an arm that never answered" >&2
  exit 1
}
