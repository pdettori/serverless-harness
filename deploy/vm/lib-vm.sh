#!/usr/bin/env bash
# Shared helpers for the P6 VM experiment drivers (E8, E9). Sourced, never executed.

ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  # shellcheck disable=SC2034  # read by the driver script that sources this file, not here
  FAIL=1
}

# Milliseconds since epoch, integer. Bash's own EPOCHREALTIME (seconds.microseconds, always
# 6 fractional digits, e.g. "1757622155.123456") rather than a python3 subprocess. vm_turn below
# no longer calls this at all -- it reads curl's own -w timing instead -- but the per-rung
# wall-clock timers in e8-density.sh and e9-tiers.sh still do, and a subprocess per call there is
# exactly the cost this part's B1 item exists to remove (see vm_turn's comment for the fuller
# story). If EPOCHREALTIME is ever unset (POSIX mode, an ancient bash), this prints garbage
# rather than failing loudly -- not a concern on the bash 5.x this repo already requires elsewhere.
now_ms() {
  local t="${EPOCHREALTIME/./}"
  printf '%s\n' "${t:0:-3}"
}

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
#
# B1 (final review fix, part 3): this used to call now_ms twice around the curl call -- three
# subprocesses per turn (python3, curl, python3), and at c=32 that is 32 concurrent chains of
# three spawns competing with the supervisor and its own workers for the same CPU the experiment
# is trying to measure. curl already times its own request, so one -w format now carries both the
# duration and the status code, and now_ms is gone from this function entirely.
#
# This is a measurement-boundary change, not just a speedup: curl's own %{time_total} excludes
# curl's own process startup (fork/exec, dynamic linking, TLS library init), where the old
# wall-clock measurement -- now_ms before spawning curl to now_ms after it exited -- included it.
# That is an improvement (the driver's own overhead should not be inside the number a rung
# reports), but it IS a change in what is measured, and whoever reads a knee number produced by
# this file deserves to know the two are not directly comparable to a pre-B1 run's numbers.
vm_turn() {
  local base="$1" sid="$2" body="$3" out ms code
  # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
  out="$(curl -s ${CURL_OPTS:-} -o /dev/null -w '%{time_total}\t%{http_code}' -XPOST "$base/turn" \
    ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
    -H 'content-type: application/json' -H "X-SH-Session-Id: $sid" -d "$body" || true)"
  # Verified empirically (connection-refused, DNS failure, --max-time timeout): curl still emits
  # its -w output on all three, with %{http_code}=000 and a real %{time_total} up to the failure,
  # so the `|| true` above exists only to stop `set -e` aborting the whole rung on one bad turn --
  # not, as the old `|| echo 000` was, to synthesize a fallback because curl printed nothing. The
  # empty-string defaults below are a second-order guard for a case not observed in that testing
  # (e.g. the curl binary itself missing), so a truly empty $out still yields a well-formed line.
  ms="${out%%$'\t'*}"
  code="${out#*$'\t'}"
  [ -n "$ms" ] || ms=0
  [ -n "$code" ] || code=000
  printf '%s\t%s\n' "$(awk -v s="$ms" 'BEGIN {printf "%.0f", (s + 0) * 1000}')" "$code"
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

# Fetches /profile from the model stub actually driving this run and prints it as JSON on
# stdout: {ttftMs, tokenDelayMs, outputTokens, toolCallRate}. Final review fix, part 3, item A:
# the stub is a separate long-lived process, configured by its OWN env at its OWN boot, so a
# driver's SH_STUB_* environment has no causal connection to what that process is actually doing
# — this is the only source of truth for the §5.7 claim sentence, which must quote what came
# back from here, never what the driver's own environment says.
#
# Unreachable (or a non-JSON body) is a HARD failure, not a fallback to a default — the same
# principle as require_live_arm above: a run whose profile cannot be established is not a
# result, and failing loudly here is cheaper than publishing a claim about load nobody verified.
# Shared by e8-density.sh and e9-tiers.sh so neither driver can drift onto reading its own
# environment again by omission.
stub_profile() {
  local url="$1" body
  body="$(curl -sf --max-time 5 "$url/profile" 2>/dev/null)" || {
    ko "stub profile unreachable at $url/profile — refusing to publish a load claim nobody verified" >&2
    exit 1
  }
  printf '%s' "$body" | jq -e '.' >/dev/null 2>&1 || {
    ko "stub profile at $url/profile did not return valid JSON: $body" >&2
    exit 1
  }
  printf '%s\n' "$body"
}

# Final review fix, part 3, item B2: where did the generator (this script) actually run,
# relative to the arm base URL it is about to drive? Derived, not declared: a flag someone sets
# can be wrong or stale in a way a loopback address cannot, because curl can only reach
# 127.0.0.1/localhost/::1 when the caller and the callee share a machine — that address IS the
# on-box proof, not merely a claim about it. Anything else is off-box by the same logic: this
# driver could not have reached that base URL without leaving the box, so leaving the box is what
# it did. Recorded once per run, per arm (not per rung — placement does not change mid-ladder).
generator_placement() {
  local base="$1"
  case "$base" in
  *127.0.0.1* | *localhost* | *://\[::1\]* | *://::1*) echo "on-box" ;;
  *) echo "off-box" ;;
  esac
}

# Final review fix, part 3, item B3: a per-rung contention indicator. The 1-minute load average
# (`uptime`) is the cheapest honest proxy available without adding a new dependency: it reflects
# everything else competing for this box's CPU while the rung ran, not just this driver's own
# curl calls or the supervisor's own workers. It is deliberately labelled `contention_load1`
# rather than something that implies precision or attribution to one process — it is a proxy for
# "how busy was this box overall", not a measurement scoped to the generator or the arm alone, and
# the point is exactly that: a co-located generator run that drives its own supervisor's load
# average up during a high-c rung will show it here, so that run cannot silently masquerade as a
# clean one just because throughput and the (failure-filtered) p95 still look healthy. `uptime`'s
# output differs cosmetically between Linux (comma-separated, "load average:") and macOS/BSD
# (space-separated, "load averages:") — the regex/awk below normalises both; the FIRST of the
# three trailing numbers is always the 1-minute average on both platforms. Falls back to "NaN",
# not "0", on any failure — same "missing metric reads NaN" contract worker_metrics already uses
# above, because a 0 would read as "no contention" and would exonerate a box that was actually busy.
load1() {
  local v
  v="$(uptime 2>/dev/null | sed -E 's/.*load average[s]?: *//' | awk -F'[, ]+' '{print $1}')"
  [ -n "$v" ] && printf '%s\n' "$v" || printf 'NaN\n'
}

# Resolves and validates a duty-basis name against experiments/src/basis.ts's §2.3 table and
# prints its one-line human-readable description on stdout. Shared by e8-density.sh and
# e9-tiers.sh — originally e8-density.sh-only, lifted here so a basis mistranscription (or a
# basis name the table doesn't have) can't drift between the two drivers by omission, the same
# reasoning as require_live_arm above.
#
# This is the basis-VALIDATION half only: resolveBasis (throws on an unknown name) +
# assertBasisConsistent (throws if the table's own duty/ratio pair for that row is internally
# inconsistent) + describeBasis (formats the result). The sandbox-pool-floor half
# (basis.ts's sandboxFloor) is deliberately NOT folded in here — see duty_basis_sandbox_floor
# below for why it stays e8-density.sh-only rather than being given a substitute here.
describe_duty_basis() {
  local basis="$1"
  "$TSX" -e '
    import { resolveBasis, describeBasis, assertBasisConsistent } from "../../experiments/src/basis.ts";
    const b = resolveBasis(process.argv[1]);
    // Belt and braces: if the table itself is ever mistranscribed, fail here.
    assertBasisConsistent(b.duty[1], b.ratio[0]);
    console.log(describeBasis(b));
  ' "$basis"
}

# K >= ceil(W * S * duty), the sandbox-pool floor for a (workers, turnsPerWorker) provisioning
# point (§2.3). e8-density.sh-ONLY, deliberately not called from e9-tiers.sh: sandboxFloor's
# inputs are a worker count and a per-worker in-flight-turn cap, both properties of E8's single
# supervisor, (W, S) provisioning model. E9 compares two DEPLOYMENT TIERS (a VM-supervisor arm
# against a Knative pod-per-session arm) via a concurrency ladder run directly against each
# arm's own base URL — it has no (W, S) point and no equivalent of either input. A per-arm
# container/pod count is not the same quantity a sandbox-pool floor measures, so rather than
# invent a substitute so E9 could call something under this same name, this stays asymmetric
# and documented: E9 currently has NO sandbox-pool-floor precondition, live or otherwise, so an
# E9 rung that queues on the VM arm's own lease pool would read exactly like the VM tier
# saturating, and nothing in e9-tiers.sh catches it today. See task-3-report.md's Part 2, Item 4.
duty_basis_sandbox_floor() {
  local basis="$1" workers="$2" turns_per_worker="$3"
  "$TSX" -e '
    import { resolveBasis, sandboxFloor } from "../../experiments/src/basis.ts";
    const b = resolveBasis(process.argv[1]);
    console.log(sandboxFloor(Number(process.argv[2]), Number(process.argv[3]), b.duty[1]));
  ' "$basis" "$workers" "$turns_per_worker"
}
