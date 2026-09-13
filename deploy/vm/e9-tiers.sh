#!/usr/bin/env bash
# E9 — VM-with-supervisor vs Knative-per-session on one workload (P6 spec §5.3, §5.5, §5.6).
#
# The comparison is only meaningful if everything except the deployment tier is held constant.
# Two pins, both enforced below rather than merely described:
#
#   PIN 1 (model tier). Both arms drive their OWN co-located stub instance — TWO stub processes,
#   one per arm, not one shared stub reached over two different network paths. Model tier is a
#   config property (the four SH_STUB_* values a stub resolves at its own boot), not a network
#   location: a single shared stub would let the two arms differ in SSE-per-flush round-trip time
#   for a reason unrelated to the tier under comparison (whichever arm is farther from the shared
#   instance pays extra RTT per flush), and it would not match how a stub is actually deployed in
#   production (co-located with its consumer, never centralised). Both instances run the
#   identical image and identical env, and that identity is verified below by comparing what each
#   stub's own /profile route reports at its own boot — not by comparing URLs or grepping for a
#   shared string, since with two instances there is no longer one string to grep for. E6 numbers
#   are not reused here: E6's existing Knative numbers were taken against a real model, and
#   reusing them would compare model backends, not deployment tiers. So the Knative arm is
#   RE-RUN with ANTHROPIC_BASE_URL pointing at its own co-located stub.
#
#   PIN 2 (tool tier). Both arms run relay + gRPC. Left alone the Knative arm would use
#   persistentExecInPod's fast channel, which the VM arm has no equivalent for — gRPC has no
#   persistent fast channel (deferred as #245). That would bias the result against the VM by an
#   amount unrelated to the tier under comparison. The VM arm's own supervisor.env.example
#   already runs SH_SANDBOX_DISCOVERY=records + SH_REMOTE_SANDBOX=1 (there is no cluster and no
#   kubeconfig on a VM, so records-only is not a choice, it is the only option). Pin 2 sets the
#   SAME two vars on the Knative arm's ksvc: with discovery=records, select-sandbox.ts's
#   candidate list is built with `pods = []` unconditionally (harness/src/select-sandbox.ts),
#   so every leased sandbox carries a GrpcRelayTransport and k8s-sandbox/src/extension.ts's
#   `opts?.transport ?? persistentExecInPod(...)` never evaluates the right-hand side — the fast
#   channel is not merely idle, it is never constructed. No new flag is added: this reuses the
#   VM arm's own existing convention instead of inventing a Knative-side-only mechanism, so the
#   two arms are pinned to literally the same tool tier rather than two mechanisms asserted to
#   be equivalent.
#
# Both results are FLOORS (see e8-density.sh).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=./lib-vm.sh
source ./lib-vm.sh

FAIL=0
RESULTS="${V_RESULTS:-./EXPERIMENTS.md}"

# Gate first, trap after: a SKIP must not restore ksvc env on a cluster it never touched.
[ "${V_LIVE:-0}" = "1" ] || {
  echo "SKIP (set V_LIVE=1 to run E9 against a live VM and a live cluster)"
  exit 0
}

# TSX and require_tsx come from lib-vm.sh. The check happens here, after the live gate, so a
# V_LIVE=0 run SKIPs and exits 0 without ever testing for the tsx binary.
require_tsx

VM_BASE="${V_BASE:-http://127.0.0.1:8080}"
METRICS_BASE="${V_METRICS_BASE:-http://127.0.0.1:8081}"
# Required-variable checks BEFORE the trap below, same property as the live gate above it: a
# missing variable must exit WITHOUT running restore_ksvc_env's real `kubectl patch` calls
# against a cluster this invocation never configured (its failures are swallowed by `|| true`,
# so a bogus patch here would fail silently and mutate state on the way out).
KSVC_URL="${KSVC_URL:?KSVC_URL must point at the Knative arm}"
# Two separate stub instances, one per arm (see PIN 1 above) — no default of one from the other,
# because defaulting would silently resurrect the single-shared-stub design this item removed.
VM_STUB_URL="${V_VM_STUB_URL:?V_VM_STUB_URL must be the stub URL the VM ARM can reach (its own co-located instance)}"
KNATIVE_STUB_URL="${V_KNATIVE_STUB_URL:?V_KNATIVE_STUB_URL must be the stub URL the CLUSTER can reach (its own co-located instance)}"

# Final review fix, part 3, item B2: derived (not declared) per arm, from that arm's own base
# URL — see generator_placement's comment in lib-vm.sh. This driver drives BOTH arms from wherever
# it itself runs, so the two can differ: a VM_BASE on loopback is on-box relative to the VM arm
# even when KSVC_URL (necessarily a routable cluster address, never loopback) is off-box relative
# to the Knative arm. Recorded once per run, per arm, in the run summary below, not per rung.
VM_GENERATOR_PLACEMENT="$(generator_placement "$VM_BASE")"
KNATIVE_GENERATOR_PLACEMENT="$(generator_placement "$KSVC_URL")"

# shellcheck source=../knative/lib.sh
source ../knative/lib.sh

# Ladder/basis defaults, the c=1 gate, and the basis-VALIDATION lookup — ALL of this must precede
# the trap installed below, same hazard and same fix as the live gate and the required-variable
# checks above: a typo'd V_LADDER (no c=1 rung) or an unknown V_DUTY_BASIS must exit BEFORE
# restore_ksvc_env's real `kubectl patch` calls are wired to run on exit, or they run against a
# cluster this invocation never actually configured. (This block used to live after the trap.)
#
# In-cluster relay Service DNS (packages/sandbox-relay), matching relay-leaf-smoke.sh's own
# convention. defaultExecClient (harness/src/select-sandbox.ts) falls back to
# sandbox-relay.default.svc.cluster.local:8443 if this is never set, which only happens to be
# correct when NS=default — set it explicitly rather than depend on that coincidence.
RELAY_ADDR="${V_RELAY_ADDR:-sandbox-relay.${NS}.svc:8443}"
LADDER="${V_LADDER:-1 2 4 8 16}"
DEGRADE_X="${V_DEGRADE_X:-2}"
MIN_C="${V_MIN_C:-4}"
TURNS_PER_RUNG="${V_TURNS_PER_RUNG:-30}"
BASIS="${V_DUTY_BASIS:-e6-ocp}"

case " $LADDER " in
*" 1 "*) ok "ladder includes the c=1 baseline rung" ;;
*)
  ko "ladder '$LADDER' has no c=1 baseline rung; detectKnee will throw"
  exit 1
  ;;
esac

# Basis-VALIDATION half, shared with e8-density.sh via lib-vm.sh's describe_duty_basis: resolves
# and validates $BASIS against experiments/src/basis.ts's table before anything below mutates
# the cluster. E9 has NO equivalent of E8's sandbox-pool-floor precondition
# (duty_basis_sandbox_floor needs a worker count and a per-worker turn cap that E9's two-arm
# ladder model has no analogue of — see that function's comment in lib-vm.sh). This is a real,
# currently-unaddressed gap, documented rather than papered over with a substitute check under
# the same name: an E9 rung that queues on the VM arm's own sandbox-lease pool would read
# exactly like the VM tier saturating, and nothing here catches it. See task-3-report.md's
# Part 2, Item 4.
DUTY_BASIS_DESC="$(describe_duty_basis "$BASIS")"
echo "duty_basis: $DUTY_BASIS_DESC"

# restore_ksvc_env() (deploy/knative/lib.sh) resets KAGENTI_SANDBOX_POD/EXEC_TIMING/CAP, the
# pool selector, autoscaling annotations, and the request timeout — it does NOT touch
# ANTHROPIC_BASE_URL, SH_REMOTE_SANDBOX, SH_SANDBOX_DISCOVERY, or SH_RELAY_ADDR (confirmed by
# reading it: none of the four appear in its patch calls). Widening that shared helper is out of
# scope here — many other drivers depend on it — but a note in a report is not a note the
# operator running this LIVE sees. KSVC_MUTATED is only set to 1 once set_ksvc_env below has
# actually run, so a run that fails before ever touching the cluster does not falsely warn.
KSVC_MUTATED=0
warn_ksvc_left_mutated() {
  [ "$KSVC_MUTATED" = 1 ] || return 0
  echo "" >&2
  echo "NOTE: ksvc $KSVC (namespace $NS) is left pointed at ANTHROPIC_BASE_URL=$KNATIVE_STUB_URL," >&2
  echo "      SH_REMOTE_SANDBOX=1, SH_SANDBOX_DISCOVERY=records, SH_RELAY_ADDR=$RELAY_ADDR." >&2
  echo "      restore_ksvc_env() does not reset these four. Reset them by hand (or re-apply" >&2
  echo "      service.yaml) before anyone else uses this cluster." >&2
}
trap 'restore_ksvc_env; warn_ksvc_left_mutated' EXIT

echo "== E9 tier comparison: ladder='$LADDER' basis=$BASIS =="
echo "generator: vm=$VM_GENERATOR_PLACEMENT (from \$VM_BASE=$VM_BASE) knative=$KNATIVE_GENERATOR_PLACEMENT (from \$KSVC_URL=$KSVC_URL) — loopback means on-box, see EXPERIMENTS.md"

# --- PIN 1 + PIN 2 applied to the Knative arm ----------------------------------------------
# ANTHROPIC_BASE_URL: the same stub, so the model tier is identical.
# SH_REMOTE_SANDBOX=1 + SH_SANDBOX_DISCOVERY=records (+ SH_RELAY_ADDR): the relay + gRPC path
# for every candidate, so the tool tier is identical. Without this, the cluster arm keeps
# persistentExecInPod's fast channel while the VM arm has no equivalent (#245) and the VM loses
# on a difference E9 is not measuring. One JSON-patch call, one new Revision (set_ksvc_env takes
# NAME=value tokens, not "NAME value" pairs — each var below is a single argument).
set_ksvc_env "ANTHROPIC_BASE_URL=$KNATIVE_STUB_URL" "SH_REMOTE_SANDBOX=1" \
  "SH_SANDBOX_DISCOVERY=records" "SH_RELAY_ADDR=$RELAY_ADDR"
wait_ksvc_ready
KSVC_MUTATED=1

# PIN 1 verification, profile comparison (final review fix, part 3, item A4): with two
# co-located stub instances there is no longer one shared URL to grep for, so "are both arms
# pointed at the same address" is not the question — by design they are NOT. The question is
# "are the two stubs running the identical resolved config", and the only source of truth for
# that is each stub's own /profile route (never this driver's or the ksvc's environment — see
# stub_profile's own comment in lib-vm.sh). A field-by-field diff, not just "not equal", so the
# operator is told exactly which of the four values drifted rather than an opaque "not ok".
VM_STUB_PROFILE="$(stub_profile "$VM_STUB_URL")"
KN_STUB_PROFILE="$(stub_profile "$KNATIVE_STUB_URL")"
if [ "$VM_STUB_PROFILE" != "$KN_STUB_PROFILE" ]; then
  DIFF_FIELDS="$(jq -n --argjson vm "$VM_STUB_PROFILE" --argjson kn "$KN_STUB_PROFILE" -r \
    '($vm | keys_unsorted) as $ks | $ks | map(select($vm[.] != $kn[.])) | join(", ")')"
  ko "the two stub instances are not running the same resolved profile — differing field(s): $DIFF_FIELDS (vm=$VM_STUB_PROFILE knative=$KN_STUB_PROFILE)"
fi

# The VM arm's supervisor must already be pointed at ITS OWN stub instance and running with pin
# 2; assert rather than assume, because a mismatched arm produces a plausible-looking number that
# means nothing. Both SH_REMOTE_SANDBOX and SH_SANDBOX_DISCOVERY are in /metrics' env allowlist
# alongside ANTHROPIC_BASE_URL (packages/supervisor/src/admin.ts's ENV_ALLOWLIST), so they are
# checkable the same way. This is a hard failure, not a WARN: an unpinned VM arm is not a
# degraded tier comparison, it is not a tier comparison at all, and letting the run continue
# would still write a labelled "floor" into EXPERIMENTS.md that means nothing.
# `|| true`: under `set -euo pipefail`, a curl failure (wrong port, closed connection, non-200
# with -f) or a jq parse failure on a non-JSON body would abort the WHOLE SCRIPT right here,
# before any of the three pin-diagnostic checks below get a chance to run and say why. The
# emptiness check below turns that silent abort into a named, actionable ko instead.
VM_ENV="$(curl -sf --max-time 5 "$METRICS_BASE/metrics" | jq -r '.env // {} | @json')" || true
if [ -z "$VM_ENV" ]; then
  ko "VM arm's /metrics at $METRICS_BASE did not return usable JSON (curl failure, non-200, or a mis-pointed data port reaching this admin endpoint) — cannot verify pins 1/2"
else
  # Exact match via jq -e, not a substring grep: $VM_ENV is already the pre-extracted `.env`
  # object (see the curl|jq line above), so the filter is `.ANTHROPIC_BASE_URL == $u`, not
  # `.env.ANTHROPIC_BASE_URL == $u` — the latter would look for a nested `.env` key that does not
  # exist at this point and would always evaluate false. A substring grep would also pass on a
  # URL that merely CONTAINS $VM_STUB_URL as a substring (e.g. a stray query string or a decoy
  # host sharing a suffix), which is a weaker guarantee than the exact equality this arm's
  # correctness actually depends on.
  printf '%s' "$VM_ENV" | jq -e --arg u "$VM_STUB_URL" '.ANTHROPIC_BASE_URL == $u' >/dev/null ||
    ko "VM arm's /metrics does not show ANTHROPIC_BASE_URL=$VM_STUB_URL exactly — verify /etc/serverless-harness/supervisor.env"
  printf '%s' "$VM_ENV" | grep -q '"SH_REMOTE_SANDBOX":"1"' ||
    ko "VM arm's /metrics does not show SH_REMOTE_SANDBOX=1 — pin 2 (tool tier) is not satisfied"
  printf '%s' "$VM_ENV" | grep -q '"SH_SANDBOX_DISCOVERY":"records"' ||
    ko "VM arm's /metrics does not show SH_SANDBOX_DISCOVERY=records — pin 2 (tool tier) is not satisfied"
fi
[ "$FAIL" = 0 ] || {
  echo "refusing to run: the VM arm is not pinned the same way as the Knative arm (§5.3)" >&2
  exit 1
}

BODY="${V_BODY:-{\"prompt\":\"summarise the diff\"}}"

# One arm, one ladder. Prints a JSON points array on stdout.
run_arm() {
  local label="$1" base="$2" work
  work="$(mktemp -d)"
  local points='[]'
  for C in $LADDER; do
    : >"$work/raw.$C"
    local t0
    t0="$(now_ms)"
    for i in $(seq 1 "$C"); do
      (
        for _ in $(seq 1 "$TURNS_PER_RUNG"); do
          vm_turn "$base" "e9-$label-c$C-s$i" "$BODY"
        done
      ) >>"$work/raw.$C" &
    done
    wait
    local wall n non200 attempts p95 tput
    wall="$(($(now_ms) - t0))"
    n="$(cut -f2 "$work/raw.$C" | grep -c '^200$' || true)"
    non200="$(cut -f2 "$work/raw.$C" | grep -vc '^200$' || true)"
    attempts="$((n + non200))"

    # Hard-fail HERE, before any further rung runs: an arm that answered nothing at its own
    # c=1 baseline cannot produce a meaningful ladder, and the failure mode is dangerous rather
    # than merely absent. detectKnee (experiments/src/sharing.ts) seeds `best` from the c=1
    # throughput; if that throughput is 0, `cur.throughput >= best` is `0 >= 0`, trivially true
    # forever, so a dead arm reports the ladder's TOP rung as a clean "floor" instead of erroring.
    # This must fire regardless of *why* c=1 saw no 200s — wrong URL, expired cert, firewall,
    # crashed revision — because none of those reasons make the resulting number less fabricated.
    # Lifted into lib-vm.sh's require_live_arm() so e8-density.sh cannot drift out of sync with
    # this check by omission (e8 calls the same function at its own OK_N). run_arm's stdout IS
    # its return channel (VM_POINTS="$(run_arm ...)" below) — every diagnostic in this function
    # must go to stderr, or it gets prepended/interleaved into the JSON points payload and
    # knee_of()'s JSON.parse throws; require_live_arm's own `ko` call already redirects for this
    # reason (lib-vm.sh), but the work dir is THIS function's own state, so it must still be
    # cleaned up here, before the call, since require_live_arm exits rather than returning.
    if [ "$C" -eq 1 ] && [ "$n" -eq 0 ]; then
      rm -rf "$work"
    fi
    require_live_arm "$C" "$n" "$label" "$base"

    # A partially-failing arm must be visible, not merely diluted into a lower throughput number
    # (same signal as e8-density.sh's SPURIOUS_429 WARN, generalised to any non-200 — the Knative
    # arm can fail closed in more ways than a 429). >&2 for the same reason as the ko above: this
    # is the common case a concurrency ladder exists to produce, so it fires on ordinary runs.
    if [ "$non200" -gt 0 ]; then
      echo "WARN $label rung c=$C saw $non200/$((C * TURNS_PER_RUNG)) non-200 responses — a knee here is suspect" >&2
    fi

    # General success-rate floor (deploy/vm/EXPERIMENTS.md), same rationale as e8-density.sh's:
    # the non200>0 WARN above already flags ANY failure, but it never blocks a rung from being
    # read as a capacity result. This makes the same 0.95 threshold explicit and comparable
    # across both drivers rather than leaving it as an implicit "some WARN fired" signal.
    if awk -v n="$n" -v a="$attempts" 'BEGIN {exit !(a>0 && n/a<0.95)}'; then
      echo "WARN $label rung c=$C succeeded on only $n/$attempts requests (below the 0.95 success-rate floor, see EXPERIMENTS.md) — this rung is not a capacity result" >&2
    fi

    # Percentiles are computed over 200-coded rows ONLY — see e8-density.sh's rung loop for the
    # full quantile-shift rationale (a mixed-status sample's naive p95 is really the successes'
    # own (0.95-f)/(1-f) quantile, where f is the failure fraction).
    p95="$(awk -F'\t' '$2==200{print $1}' "$work/raw.$C" | percentile 95)"
    tput="$(awk -v n="$n" -v ms="$wall" 'BEGIN {printf "%.3f", ms>0 ? n*1000/ms : 0}')"
    # Final review fix, part 3, item B3: contention proxy, read fresh at the end of THIS rung —
    # see load1's comment in lib-vm.sh. Recorded per arm per rung, since the two arms can be on
    # different boxes and can carry different contention.
    local load1_now
    load1_now="$(load1)"
    echo "-- $label c=$C p95=${p95}ms tput=$tput load1=$load1_now" >&2
    points="$(printf '%s' "$points" | jq -c \
      --argjson c "$C" --argjson t "$tput" --argjson p "$p95" \
      --argjson attempts "$attempts" --argjson non200 "$non200" \
      --arg load1 "$load1_now" \
      '. + [{c: $c, throughput: $t, p95Ms: $p, attempts: $attempts, non200: $non200, contention_load1: $load1}]')"
  done
  rm -rf "$work"
  printf '%s' "$points"
}

VM_POINTS="$(run_arm vm "$VM_BASE")"
KN_POINTS="$(run_arm knative "$KSVC_URL")"

knee_of() {
  "$TSX" -e '
    import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
    const knee = detectKnee(JSON.parse(process.argv[1]), Number(process.argv[2]), 2);
    console.log(JSON.stringify({ knee, pass: sanityFloorPass(knee, Number(process.argv[3])) }));
  ' "$1" "$DEGRADE_X" "$MIN_C"
}
# .pass (sanityFloorPass) used to be discarded here — only .knee was ever extracted — so a knee
# below MIN_C (e.g. detectKnee falling back to the c=1 rung itself) produced a clean-looking
# table row instead of a `ko`. Mirrors E8's own PASS handling (e8-density.sh's `[ "$PASS" =
# "true" ] || ko ...` right after its own knee_of-equivalent call).
VM_KNEE_JSON="$(knee_of "$VM_POINTS")"
KN_KNEE_JSON="$(knee_of "$KN_POINTS")"
VM_KNEE="$(printf '%s' "$VM_KNEE_JSON" | jq -r .knee)"
KN_KNEE="$(printf '%s' "$KN_KNEE_JSON" | jq -r .knee)"
VM_PASS="$(printf '%s' "$VM_KNEE_JSON" | jq -r .pass)"
KN_PASS="$(printf '%s' "$KN_KNEE_JSON" | jq -r .pass)"
[ "$VM_PASS" = "true" ] || ko "VM arm's knee floor $VM_KNEE is below the sanity floor $MIN_C"
[ "$KN_PASS" = "true" ] || ko "Knative arm's knee floor $KN_KNEE is below the sanity floor $MIN_C"

# Same SATURATED convention as e8-density.sh: SATURATED=no means the knee equals the ladder's
# own top rung, i.e. the arm was STILL healthy when the ladder ran out, so that arm's number is
# the ladder's limit, not a machine ceiling. SATURATED=yes means a genuine knee was found below
# the top rung — a real machine bound, not an artefact of how tall this ladder was. The two arms
# can land in different states (one tops out while the other genuinely knees), so this is
# tracked per arm rather than as one shared flag.
TOP_RUNG="${LADDER##* }"
VM_SATURATED=yes
[ "$VM_KNEE" = "$TOP_RUNG" ] && VM_SATURATED=no
KN_SATURATED=yes
[ "$KN_KNEE" = "$TOP_RUNG" ] && KN_SATURATED=no

echo "E9_RESULT vm_knee_floor=$VM_KNEE knative_knee_floor=$KN_KNEE degrade_x=$DEGRADE_X vm_saturated=$VM_SATURATED knative_saturated=$KN_SATURATED"

{
  echo ""
  echo "### E9 run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "| Arm | Sustained in-flight turns (floor) |"
  echo "| --- | --- |"
  echo "| VM + supervisor | $VM_KNEE |"
  echo "| Knative per-session | $KN_KNEE |"
  echo ""
  # Unconditional "both are floors, ladder topped out" prose used to run regardless of what the
  # ladder actually found — including on a genuine knee. Report which arms actually ran out of
  # ladder (SATURATED=no) versus which found a real bound (SATURATED=yes) instead.
  if [ "$VM_SATURATED" = no ] && [ "$KN_SATURATED" = no ]; then
    echo "Both are **floors**: each ladder topped out at $TOP_RUNG, so neither number is a"
    echo "machine ceiling. Extend \`V_LADDER\` to find either machine's real limit."
  elif [ "$VM_SATURATED" = yes ] && [ "$KN_SATURATED" = yes ]; then
    echo "Neither is ladder-limited: both arms found a genuine knee below the top rung"
    echo "($TOP_RUNG), so both $VM_KNEE and $KN_KNEE are machine bounds, not artefacts of how"
    echo "tall this ladder was."
  elif [ "$VM_SATURATED" = no ]; then
    echo "The VM arm's floor ($VM_KNEE) is the ladder's limit, **not the machine's**: top rung"
    echo "($TOP_RUNG) was still healthy. Extend \`V_LADDER\` to find the VM's real limit. The"
    echo "Knative arm found a genuine knee ($KN_KNEE) below the top rung, so that number **is**"
    echo "a machine bound."
  else
    echo "The Knative arm's floor ($KN_KNEE) is the ladder's limit, **not the machine's**: top"
    echo "rung ($TOP_RUNG) was still healthy. Extend \`V_LADDER\` to find its real limit. The VM"
    echo "arm found a genuine knee ($VM_KNEE) below the top rung, so that number **is** a"
    echo "machine bound."
  fi
  echo ""
  echo "Pins that make this a tier comparison (§5.3):"
  echo ""
  echo "- **Model tier:** each arm drove its OWN co-located stub instance — the VM arm at"
  echo "  \`$VM_STUB_URL\`, the Knative arm at \`$KNATIVE_STUB_URL\` — verified to be running the"
  echo "  identical resolved profile via /profile (\`$VM_STUB_PROFILE\`), not merely pointed at the"
  echo "  same address. E6's existing Knative numbers were taken against a real model and are"
  echo "  **not** comparable, so the Knative arm was re-run here rather than reused."
  echo "- **Tool tier:** both arms ran relay + gRPC (\`SH_REMOTE_SANDBOX=1\`,"
  echo "  \`SH_SANDBOX_DISCOVERY=records\`). Leaving \`persistentExecInPod\`'s fast channel enabled"
  echo "  on the Knative arm would penalise the VM for a tool-tier difference — gRPC has no"
  echo "  persistent fast channel (deferred, #245)."
  echo "- conns_per_turn: 1 on **both** arms. Each vm_turn/curl call is its own connection;"
  echo "  harmless here since both arms leave SH_ROUTING_POLICY at its leastInFlight default"
  echo "  (deploy/vm/env/supervisor.env.example:7 — the Knative arm has no equivalent affinity"
  echo "  knob either), so routing decides per request, not per session, and there is no session"
  echo "  affinity for a per-turn connection to defeat."
  echo "- duty_basis: $BASIS (one §2.3 row, taken whole)."
  echo "- Generator placement: VM arm **$VM_GENERATOR_PLACEMENT** (from \`\$VM_BASE=$VM_BASE\`),"
  echo "  Knative arm **$KNATIVE_GENERATOR_PLACEMENT** (from \`\$KSVC_URL=$KSVC_URL\`) — derived,"
  echo "  not declared. Either arm reading **on-box** makes that arm's numbers a caveated result,"
  echo "  not an equivalent one — see EXPERIMENTS.md's \"Where the generator ran\" section."
  echo "- Per-rung \`contention_load1\` (1-minute load average) is a contention PROXY, not a"
  echo "  generator-specific measurement — see EXPERIMENTS.md."
  echo ""
  echo '```json'
  jq -n --argjson vm "$VM_POINTS" --argjson kn "$KN_POINTS" '{vm: $vm, knative: $kn}'
  echo '```'
} >>"$RESULTS"

[ "$FAIL" = 0 ] || exit 1
