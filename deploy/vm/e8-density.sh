#!/usr/bin/env bash
# E8 — single-VM turn density (P6 spec §5.1, §5.2, §5.4, §5.6).
#
# Sweeps OFFERED CONCURRENCY against one supervisor at one (W, S) point and reports the highest
# rung whose p95 stays within DEGRADE_X of its own c=1 baseline. The answer is a FLOOR: the
# ladder cannot see past its top rung.
#
# Two vocabularies, never conflated (§5.1):
#   - concurrent in-flight turns  -> what this measures; the resource-consuming quantity
#   - sessions addressable        -> a Redis capacity statement; NOT measured here
#
# Sweep (W, S) by invoking this repeatedly. S is SH_TURNS_PER_WORKER, a restart-time constant:
# changing it mid-ladder would reset every worker's in-flight state and mix a cold rung into a
# warm series.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=./lib-vm.sh
source ./lib-vm.sh

FAIL=0
RESULTS="${V_RESULTS:-./EXPERIMENTS.md}"

# --- live gate, BEFORE any trap ------------------------------------------------------------
# Installing the trap first would mean a SKIP runs cleanup against a system it never touched.
[ "${V_LIVE:-0}" = "1" ] || {
  echo "SKIP (set V_LIVE=1 to run E8 against a live VM supervisor)"
  exit 0
}

# TSX and require_tsx come from lib-vm.sh. The check happens here, after the live gate, so a
# V_LIVE=0 run SKIPs and exits 0 without ever testing for the tsx binary.
require_tsx

BASE="${V_BASE:-http://127.0.0.1:8080}"
# Telemetry lives on the loopback admin listener (SH_ADMIN_PORT, plan 1 Task 11), not on $BASE.
METRICS_BASE="${V_METRICS_BASE:-http://127.0.0.1:8081}"
LADDER="${V_LADDER:-1 2 4 8 16 32}"
DEGRADE_X="${V_DEGRADE_X:-2}"
MIN_C="${V_MIN_C:-4}"
TURNS_PER_RUNG="${V_TURNS_PER_RUNG:-30}"
BASIS="${V_DUTY_BASIS:-e6-ocp}"
# Optional. Unset means the memory bound is never attributed, rather than attributed against a
# number nobody chose: "RSS looked high" is not a budget, and how much RSS is too much depends
# on what else the VM runs. Set it to the per-worker RSS you are actually willing to pay for.
RSS_BUDGET_BYTES="${V_RSS_BUDGET_BYTES:-0}"
WORKERS="${SH_WORKERS:?SH_WORKERS must name the worker count this supervisor was started with}"
# No default, deliberately (§3.8): S is the per-worker cap on in-flight turns, and its right
# value is an OUTPUT of this experiment. A default here would quietly answer the question E8 asks.
TURNS_PER_WORKER="${SH_TURNS_PER_WORKER:?SH_TURNS_PER_WORKER must be set to the S this supervisor was started with}"
# Final review fix, part 3, item A: the stub this supervisor's ANTHROPIC_BASE_URL actually points
# at is a separate long-lived process, configured by ITS OWN env at ITS OWN boot -- this driver's
# own SH_STUB_* environment (if any) has no causal connection to it. No default: a wrong URL here
# would make stub_profile below either hang against nothing or, worse, quietly succeed against
# some OTHER stub, which is precisely the fabrication path this item exists to close.
# No apostrophe in this message: shellcheck cannot parse one inside a ${VAR:?msg} expansion
# (SC1073/SC1072 -- verified empirically, not a style nit) -- it reads the apostrophe as opening
# a single-quoted string and aborts parsing the rest of the file.
STUB_URL="${V_STUB_URL:?V_STUB_URL must be the model stub URL this supervisors ANTHROPIC_BASE_URL points at, so this driver can fetch /profile from the stub actually driving the run (see deploy/knative/model-stub/README.md)}"

# Final review fix, part 3, item B2: derived (not declared) from $BASE — see generator_placement's
# comment in lib-vm.sh. Recorded once per run, in the run summary below, not per rung.
GENERATOR_PLACEMENT="$(generator_placement "$BASE")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== E8 density: W=$WORKERS S=$TURNS_PER_WORKER basis=$BASIS ladder='$LADDER' =="
echo "generator: $GENERATOR_PLACEMENT (derived from \$BASE=$BASE; loopback means on-box — see EXPERIMENTS.md)"

# --- refuse to measure something meaningless -----------------------------------------------
# detectKnee throws 'detectKnee: no c=1 baseline point' without this rung. Checking here costs
# nothing; discovering it after an hour of measurement costs the run.
case " $LADDER " in
*" 1 "*) ok "ladder includes the c=1 baseline rung" ;;
*)
  ko "ladder '$LADDER' has no c=1 baseline rung; detectKnee will throw"
  exit 1
  ;;
esac

# Resolve the duty basis and the sandbox floor it implies — one row, taken whole (§2.3).
# describe_duty_basis (lib-vm.sh) is the basis-VALIDATION half, shared with e9-tiers.sh;
# duty_basis_sandbox_floor stays here (e8-density.sh-only) — see its comment in lib-vm.sh for
# why that half is not lifted for E9.
DUTY_BASIS_DESC="$(describe_duty_basis "$BASIS")"
SANDBOX_FLOOR="$(duty_basis_sandbox_floor "$BASIS" "$WORKERS" "$TURNS_PER_WORKER")"
echo "duty_basis: $DUTY_BASIS_DESC"
echo "sandbox floor for W=$WORKERS S=$TURNS_PER_WORKER: K >= $SANDBOX_FLOOR"

SANDBOX_COUNT="$(podman ps --format '{{.Names}}' | grep -c '^sh-sandbox-' || true)"
if [ "$SANDBOX_COUNT" -lt "$SANDBOX_FLOOR" ]; then
  # Do NOT proceed. Turns would queue on lease acquisition, and lease waits on a rung look
  # exactly like the worker tier saturating — the knee would be attributed to the wrong bound.
  ko "sandbox pool has $SANDBOX_COUNT containers, floor is $SANDBOX_FLOOR (SH_SANDBOX_COUNT=$SANDBOX_FLOOR ./setup-vm.sh)"
  exit 1
fi
ok "sandbox pool satisfies the floor ($SANDBOX_COUNT >= $SANDBOX_FLOOR)"

curl -sf --max-time 5 "$BASE/health" >/dev/null || {
  ko "no supervisor answering at $BASE"
  exit 1
}

# Final review fix, part 3, item A3: fetch the stub's OWN resolved profile rather than trust this
# driver's environment. stub_profile (lib-vm.sh) hard-fails (exit 1) if the stub is unreachable
# or returns something that is not valid JSON -- a run whose profile cannot be established is not
# a result, same principle as require_live_arm above.
STUB_PROFILE_JSON="$(stub_profile "$STUB_URL")"
STUB_TTFT="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.ttftMs')"
STUB_TOKEN_DELAY="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.tokenDelayMs')"
STUB_TOKENS="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.outputTokens')"
STUB_TOOL_RATE="$(printf '%s' "$STUB_PROFILE_JSON" | jq -r '.toolCallRate')"
echo "model stub profile (from $STUB_URL/profile, as resolved at the stub's own boot): $STUB_PROFILE_JSON"

BODY="${V_BODY:-{\"prompt\":\"summarise the diff\"}}"
POINTS='[]'
RECORDS='[]'

for C in $LADDER; do
  echo "-- rung c=$C"
  : >"$WORK/lat.$C"
  : >"$WORK/code.$C"

  CPU0="$(sandbox_cpu_seconds)"
  T0="$(now_ms)"

  # C concurrent virtual sessions, TURNS_PER_RUNG turns each. vm_turn (lib-vm.sh) opens one
  # curl connection per turn, not one per session. That is harmless here: both drivers leave
  # SH_ROUTING_POLICY at its leastInFlight default (deploy/vm/env/supervisor.env.example:7),
  # under which routing decides per REQUEST, not per session, so there is no session affinity
  # in play for a per-turn connection to defeat. This records what the driver actually does
  # (conns_per_turn: 1 below), not a knob — exercising stickyBySession's session affinity is a
  # separate, not-yet-covered gap, not something this rung loop measures.
  for i in $(seq 1 "$C"); do
    (
      for _ in $(seq 1 "$TURNS_PER_RUNG"); do
        vm_turn "$BASE" "e8-c$C-s$i" "$BODY"
      done
    ) >>"$WORK/raw.$C" &
  done
  wait

  WALL_MS="$(($(now_ms) - T0))"
  cut -f2 "$WORK/raw.$C" >"$WORK/code.$C"

  OK_N="$(grep -c '^200$' "$WORK/code.$C" || true)"
  ATTEMPTS="$(wc -l <"$WORK/code.$C" | tr -d ' ')"

  # Hard-fail HERE, before any further rung runs, on a dead arm — see lib-vm.sh's
  # require_live_arm for why (shared with e9-tiers.sh's run_arm, so neither driver can drift
  # out of sync with this check by omission). Unlike run_arm's own local work dir, $WORK here is
  # cleaned up by the EXIT trap installed above, so no cleanup is needed before this call.
  require_live_arm "$C" "$OK_N" "e8" "$BASE"

  # Percentiles are computed over 200-coded rows ONLY. A latency sample that mixes fast
  # failures (a refused or errored request returns in a fraction of a real response's time)
  # with genuine responses is not a latency distribution: sorted ascending, the failures pile
  # up at the bottom, so the naive p95 over ALL rows is really the successes' own
  # (0.95-f)/(1-f) quantile, where f is the failure fraction — at f=0.5 that quietly reports
  # the successes' p90 labelled p95. See the synthetic demonstration in task-3-report.md.
  awk -F'\t' '$2==200{print $1}' "$WORK/raw.$C" >"$WORK/lat.$C"

  SPURIOUS_429="$(grep -c '^429$' "$WORK/code.$C" || true)"
  P50="$(percentile 50 <"$WORK/lat.$C")"
  P95="$(percentile 95 <"$WORK/lat.$C")"
  THROUGHPUT="$(awk -v n="$OK_N" -v ms="$WALL_MS" 'BEGIN {printf "%.3f", ms>0 ? n*1000/ms : 0}')"

  # General success-rate floor (deploy/vm/EXPERIMENTS.md): unlike the SPURIOUS_429-only WARN
  # below, this fires on ANY failure mode — a 500/503/000 storm produces no field and no
  # warning today, and throughput saturates at the arm's real capacity regardless of which
  # status code did the refusing, so a heavily-failing rung can read healthy on both the
  # throughput and (percentile-filtered) latency criteria. 0.95 is this driver's floor; see the
  # report for why.
  if awk -v n="$OK_N" -v a="$ATTEMPTS" 'BEGIN {exit !(a>0 && n/a<0.95)}'; then
    echo "WARN rung c=$C succeeded on only $OK_N/$ATTEMPTS requests (below the 0.95 success-rate floor, see EXPERIMENTS.md) — this rung is not a capacity result"
  fi

  M1="$(worker_metrics "$METRICS_BASE")"
  LOOP_LAG_P99="$(printf '%s' "$M1" | jq -c '[.workers[]?.loop_lag_p99_ms // "NaN"]')"
  RSS_BYTES="$(printf '%s' "$M1" | jq -c '[.workers[]?.rss_bytes // "NaN"]')"
  FILE_OP_MS="$(printf '%s' "$M1" | jq -r '.file_op_p95_ms // "NaN"')"
  OVER_ADMISSION="$(printf '%s' "$M1" | jq -r '.counters.over_admission // "NaN"')"
  # Refusals the supervisor's own next `load` convicted as unnecessary. Distinct from
  # spurious_429 below: that one is what the CLIENT saw and is what truncates a rung; this one
  # is what attributes those 429s to IPC staleness rather than to genuine saturation.
  REFUSALS_CONVICTED="$(printf '%s' "$M1" | jq -r '.counters.spurious_refusals // "NaN"')"
  LEASE_SATURATION="$(printf '%s' "$M1" | jq -r '.lease_saturation // "NaN"')"
  SANDBOX_CPU="$(awk -v a="$CPU0" -v b="$(sandbox_cpu_seconds)" 'BEGIN {printf "%.2f", b-a}')"
  # Final review fix, part 3, item B3: contention proxy, read fresh at the end of THIS rung (not
  # once per run) so a rung that drove load up shows it at the rung it happened, not smeared
  # across the whole run. See load1's comment in lib-vm.sh for why this is 1-minute load average.
  CONTENTION_LOAD1="$(load1)"

  # A 429 storm is the dangerous reading: refusals shorten a rung's completed work, so
  # throughput flattens and the ladder reports a knee that is an admission-control artefact
  # rather than a machine limit (§3.9). Say so at the rung, not in a post-mortem.
  if [ "$SPURIOUS_429" -gt 0 ]; then
    echo "WARN rung c=$C saw $SPURIOUS_429 refusals (429); S=$TURNS_PER_WORKER may be under-set — a knee here is suspect"
  fi

  POINTS="$(printf '%s' "$POINTS" | jq -c \
    --argjson c "$C" --argjson t "$THROUGHPUT" --argjson p "$P95" \
    '. + [{c: $c, throughput: $t, p95Ms: $p}]')"
  RECORDS="$(printf '%s' "$RECORDS" | jq -c \
    --argjson c "$C" --argjson t "$THROUGHPUT" --argjson p50 "$P50" --argjson p95 "$P95" \
    --argjson lag "$LOOP_LAG_P99" --argjson rss "$RSS_BYTES" \
    --arg fop "$FILE_OP_MS" --arg scpu "$SANDBOX_CPU" --arg lease "$LEASE_SATURATION" \
    --arg over "$OVER_ADMISSION" --arg recon "$REFUSALS_CONVICTED" \
    --argjson s429 "$SPURIOUS_429" --arg basis "$BASIS" \
    --argjson attempts "$ATTEMPTS" --argjson ok_n "$OK_N" \
    --arg load1 "$CONTENTION_LOAD1" \
    '. + [{c: $c, throughput: $t, p50Ms: $p50, p95Ms: $p95,
           loop_lag_p99: $lag, rss_bytes: $rss, file_op_ms: $fop, sandbox_cpu: $scpu,
           lease_saturation: $lease, over_admission: $over, spurious_refusals: $recon,
           spurious_429: $s429, conns_per_turn: 1, duty_basis: $basis,
           attempts: $attempts, ok_n: $ok_n, contention_load1: $load1}]')"
done

# --- knee ----------------------------------------------------------------------------------
KNEE_JSON="$("$TSX" -e '
  import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
  const points = JSON.parse(process.argv[1]);
  const knee = detectKnee(points, Number(process.argv[2]), 2);
  console.log(JSON.stringify({ knee, pass: sanityFloorPass(knee, Number(process.argv[3])) }));
' "$POINTS" "$DEGRADE_X" "$MIN_C")"
KNEE="$(printf '%s' "$KNEE_JSON" | jq -r .knee)"
PASS="$(printf '%s' "$KNEE_JSON" | jq -r .pass)"
[ "$PASS" = "true" ] || ko "knee floor $KNEE is below the sanity floor $MIN_C"

TOP_RUNG="${LADDER##* }"
SATURATED=yes
[ "$KNEE" = "$TOP_RUNG" ] && SATURATED=no

# --- which tier ran out (§5.7's "the bound observed at ...") --------------------------------
# §5.7's claim sentence names a tier, so the driver derives it from the rung's own telemetry
# instead of leaving it to whoever writes the sentence up later. The important branch is the
# last one: when nothing crossed a threshold the answer is `unattributed`, which is a true
# statement about the run. A guessed tier would put a cause into a document people cite, and
# `spurious_429` is checked FIRST because a truncated rung is not a tier bound at all — it is
# the knee reading early (§3.9).
BOUND_JSON="$(printf '%s' "$RECORDS" | jq -c \
  --argjson knee "$KNEE" --argjson budget "$RSS_BUDGET_BYTES" '
  def num($x): if ($x | type) == "number" then $x else null end;
  def peak($a): [($a // [])[] | num(.)] | map(select(. != null))
                | if length == 0 then null else max end;
  (map(select(.c == 1)) | first) as $b |
  (map(select(.c <= $knee)) | last) as $k |
  (peak($k.loop_lag_p99)) as $lag | (peak($b.loop_lag_p99)) as $lag0 |
  if $k == null then
    { tag: "unattributed", prose: "unattributed (no rung at or below the knee)" }
  elif ($k.spurious_429 // 0) > 0 then
    { tag: "admission-control",
      prose: "admission control — \($k.spurious_429) refusals truncated the rung, so this knee reads early rather than marking a machine limit" }
  elif (($k.lease_saturation | tonumber?) // 0) >= 0.95 then
    { tag: "sandbox-pool",
      prose: "the sandbox lease pool (saturation \($k.lease_saturation)) — provision more containers and re-run before quoting this as a VM limit" }
  elif ($lag != null and $lag0 != null and $lag0 > 0 and ($lag / $lag0) >= 4) then
    { tag: "event-loop",
      prose: "the event loop — worst-worker p99 loop lag \($lag)ms against \($lag0)ms at c=1" }
  elif ($budget > 0 and (peak($k.rss_bytes) // 0) >= $budget) then
    { tag: "memory", prose: "memory — worst-worker RSS \(peak($k.rss_bytes)) bytes against the \($budget)-byte budget" }
  else
    { tag: "unattributed",
      prose: "unattributed — no tier crossed its threshold at the knee, so the bound is not identified by this run" }
  end')"
BOUND_TAG="$(printf '%s' "$BOUND_JSON" | jq -r .tag)"
BOUND="$(printf '%s' "$BOUND_JSON" | jq -r .prose)"
[ "$BOUND_TAG" != unattributed ] ||
  echo "WARN bound unattributed: §5.2's columns did not identify a tier (all NaN? see plan 1 Task 11)"

echo "E8_RESULT knee_floor=$KNEE degrade_x=$DEGRADE_X min_c=$MIN_C workers=$WORKERS s=$TURNS_PER_WORKER saturated=$SATURATED bound=$BOUND_TAG"

{
  echo ""
  echo "### E8 run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "- **Concurrent in-flight turns sustained (floor): $KNEE** at W=$WORKERS, S=$TURNS_PER_WORKER."
  if [ "$SATURATED" = no ]; then
    echo "  - Top rung ($TOP_RUNG) was still healthy: this is the ladder's limit, **not the machine's**."
    echo "    Extend \`V_LADDER\` to find the machine's."
  fi
  echo "- Criterion: p95 within ${DEGRADE_X}x its own c=1 baseline, patience 2. Sanity floor $MIN_C: $PASS."
  echo "- **This is a turn-concurrency number, not a session count.** Sessions addressable is a"
  echo "  Redis capacity statement and is not measured here (§5.1)."
  echo "- duty_basis: $DUTY_BASIS_DESC"
  echo "- conns_per_turn: 1. Each vm_turn call is its own connection; harmless under"
  echo "  SH_ROUTING_POLICY=leastInFlight (the only policy either driver sets — routing decides"
  echo "  per request, not per session, so there is no session affinity here to preserve)."
  echo "- Sandbox pool: $SANDBOX_COUNT containers (floor $SANDBOX_FLOOR)."
  echo "- Model stub profile (fetched from $STUB_URL/profile, as resolved at the stub's own boot — not this driver's environment): ttft=${STUB_TTFT}ms tokenDelay=${STUB_TOKEN_DELAY}ms tokens=${STUB_TOKENS} toolRate=${STUB_TOOL_RATE}"
  echo "- Generator placement: **$GENERATOR_PLACEMENT** (derived from \`\$BASE=$BASE\`, not"
  echo "  declared). An **on-box** run is a caveated result, not an equivalent one — see"
  echo "  EXPERIMENTS.md's \"Where the generator ran\" section for why and for the off-box/pinning"
  echo "  guidance."
  echo "- Bound observed at: **$BOUND**"
  echo "- \`lease_saturation\` and \`file_op_ms\` are expected to read \`NaN\` above: no lease-pool"
  echo "  state and no file-op-p95 counter exist anywhere in \`harness/src\` or"
  echo "  \`packages/k8s-sandbox/src\` for a worker to report (plan 1 Task 11's note). That is a"
  echo "  known gap in the shipped surface, not a defect in this driver — the sandbox-pool and"
  echo "  relay tiers are therefore **unattributed** by this run rather than given a fabricated"
  echo "  reading."
  echo ""
  echo "**§5.7 claim, as measured.** Quote this sentence; do not rewrite it from the numbers above:"
  echo ""
  echo "> On a single VM, $WORKERS workers each admitting up to $TURNS_PER_WORKER in-flight turns"
  echo "> sustained **$KNEE concurrent turns** with p95 within ${DEGRADE_X}x the single-session"
  echo "> baseline, with the model tier modelled at ttft=${STUB_TTFT}ms"
  echo "> tokenDelay=${STUB_TOKEN_DELAY}ms tokens=${STUB_TOKENS}"
  echo "> toolRate=${STUB_TOOL_RATE} (as reported by the stub's own /profile route, not this"
  echo "> driver's environment), and the bound observed at $BOUND."
  if [ "$SATURATED" = no ]; then
    echo ">"
    echo "> _Ladder-limited: $KNEE was the top rung, so the sentence understates the machine._"
  fi
  echo ""
  echo "§5.7's sentence has a second half — what the Knative pod-per-session arm sustained against"
  echo "this same stub — and E9 produces it. A P6 claim quoting only the half above is incomplete:"
  echo "a density figure with nothing to compare it to is not an argument for either architecture."
  echo ""
  echo "Per-rung records (§5.2 attribution: loop_lag_p99 -> worker CPU/mux; rss_bytes -> memory per"
  echo "live session; file_op_ms -> relay round trip; sandbox_cpu -> \`bash -c\` churn;"
  echo "lease_saturation -> pool provisioning; over_admission -> IPC staleness; spurious_429 -> a"
  echo "knee read early rather than a real ceiling; contention_load1 -> 1-minute load average, a"
  echo "contention PROXY not a generator-specific measurement — see EXPERIMENTS.md):"
  echo ""
  echo '```json'
  printf '%s\n' "$RECORDS" | jq .
  echo '```'
} >>"$RESULTS"

[ "$FAIL" = 0 ] || exit 1
