#!/usr/bin/env bash
# E9 — VM-with-supervisor vs Knative-per-session on one workload (P6 spec §5.3, §5.5, §5.6).
#
# The comparison is only meaningful if everything except the deployment tier is held constant.
# Two pins, both enforced below rather than merely described:
#
#   PIN 1 (model tier). Both arms drive the SAME stub. E6 numbers are not reused here: E6's
#   existing Knative numbers were taken against a real model, and reusing them would compare
#   model backends, not deployment tiers. So the Knative arm is RE-RUN with ANTHROPIC_BASE_URL
#   pointing at the stub.
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

# shellcheck source=../knative/lib.sh
source ../knative/lib.sh
trap 'restore_ksvc_env' EXIT

VM_BASE="${V_BASE:-http://127.0.0.1:8080}"
METRICS_BASE="${V_METRICS_BASE:-http://127.0.0.1:8081}"
KSVC_URL="${KSVC_URL:?KSVC_URL must point at the Knative arm}"
STUB_URL="${V_STUB_URL:?V_STUB_URL must be the stub URL the CLUSTER can reach (not 127.0.0.1)}"
# In-cluster relay Service DNS (packages/sandbox-relay), matching relay-leaf-smoke.sh's own
# convention. defaultExecClient (harness/src/select-sandbox.ts) falls back to
# sandbox-relay.default.svc.cluster.local:8443 if this is never set, which only happens to be
# correct when NS=default — set it explicitly rather than depend on that coincidence.
RELAY_ADDR="${V_RELAY_ADDR:-sandbox-relay.${NS}.svc:8443}"
LADDER="${V_LADDER:-1 2 4 8 16}"
DEGRADE_X="${V_DEGRADE_X:-2}"
MIN_C="${V_MIN_C:-4}"
TURNS_PER_RUNG="${V_TURNS_PER_RUNG:-30}"
CONNS_PER_SESSION="${V_CONNS_PER_SESSION:-1}"
BASIS="${V_DUTY_BASIS:-e6-ocp}"

case " $LADDER " in
*" 1 "*) ok "ladder includes the c=1 baseline rung" ;;
*)
  ko "ladder '$LADDER' has no c=1 baseline rung; detectKnee will throw"
  exit 1
  ;;
esac

echo "== E9 tier comparison: ladder='$LADDER' basis=$BASIS conns_per_session=$CONNS_PER_SESSION =="

# --- PIN 1 + PIN 2 applied to the Knative arm ----------------------------------------------
# ANTHROPIC_BASE_URL: the same stub, so the model tier is identical.
# SH_REMOTE_SANDBOX=1 + SH_SANDBOX_DISCOVERY=records (+ SH_RELAY_ADDR): the relay + gRPC path
# for every candidate, so the tool tier is identical. Without this, the cluster arm keeps
# persistentExecInPod's fast channel while the VM arm has no equivalent (#245) and the VM loses
# on a difference E9 is not measuring. One JSON-patch call, one new Revision (set_ksvc_env takes
# NAME=value tokens, not "NAME value" pairs — each var below is a single argument).
set_ksvc_env "ANTHROPIC_BASE_URL=$STUB_URL" "SH_REMOTE_SANDBOX=1" \
  "SH_SANDBOX_DISCOVERY=records" "SH_RELAY_ADDR=$RELAY_ADDR"
wait_ksvc_ready

# The VM arm's supervisor must already be running with the same two pins; assert rather than
# assume, because a mismatched arm produces a plausible-looking number that means nothing.
VM_ENV="$(curl -sf --max-time 5 "$METRICS_BASE/metrics" | jq -r '.env // {} | @json')"
printf '%s' "$VM_ENV" | grep -q "$STUB_URL" ||
  echo "WARN could not confirm the VM arm points at $STUB_URL — verify /etc/serverless-harness/supervisor.env"

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
    local wall n p95 tput
    wall="$(($(now_ms) - t0))"
    n="$(cut -f2 "$work/raw.$C" | grep -c '^200$' || true)"
    p95="$(cut -f1 "$work/raw.$C" | percentile 95)"
    tput="$(awk -v n="$n" -v ms="$wall" 'BEGIN {printf "%.3f", ms>0 ? n*1000/ms : 0}')"
    echo "-- $label c=$C p95=${p95}ms tput=$tput" >&2
    points="$(printf '%s' "$points" | jq -c --argjson c "$C" --argjson t "$tput" --argjson p "$p95" \
      '. + [{c: $c, throughput: $t, p95Ms: $p}]')"
  done
  rm -rf "$work"
  printf '%s' "$points"
}

VM_POINTS="$(run_arm vm "$VM_BASE")"
KN_POINTS="$(run_arm knative "$KSVC_URL")"

knee_of() {
  "$TSX" -e '
    import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
    const knee = detectKnee(JSON.parse(process.argv[2]), Number(process.argv[3]), 2);
    console.log(JSON.stringify({ knee, pass: sanityFloorPass(knee, Number(process.argv[4])) }));
  ' -- "$1" "$DEGRADE_X" "$MIN_C"
}
VM_KNEE="$(knee_of "$VM_POINTS" | jq -r .knee)"
KN_KNEE="$(knee_of "$KN_POINTS" | jq -r .knee)"

echo "E9_RESULT vm_knee_floor=$VM_KNEE knative_knee_floor=$KN_KNEE degrade_x=$DEGRADE_X"

{
  echo ""
  echo "### E9 run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "| Arm | Sustained in-flight turns (floor) |"
  echo "| --- | --- |"
  echo "| VM + supervisor | $VM_KNEE |"
  echo "| Knative per-session | $KN_KNEE |"
  echo ""
  echo "Both are **floors**: each ladder topped out at ${LADDER##* }, so neither number is a"
  echo "machine ceiling."
  echo ""
  echo "Pins that make this a tier comparison (§5.3):"
  echo ""
  echo "- **Model tier:** both arms drove the same stub at \`$STUB_URL\`. E6's existing Knative"
  echo "  numbers were taken against a real model and are **not** comparable, so the Knative arm"
  echo "  was re-run here rather than reused."
  echo "- **Tool tier:** both arms ran relay + gRPC (\`SH_REMOTE_SANDBOX=1\`,"
  echo "  \`SH_SANDBOX_DISCOVERY=records\`). Leaving \`persistentExecInPod\`'s fast channel enabled"
  echo "  on the Knative arm would penalise the VM for a tool-tier difference — gRPC has no"
  echo "  persistent fast channel (deferred, #245)."
  echo "- conns_per_session: $CONNS_PER_SESSION on **both** arms."
  echo "- duty_basis: $BASIS (one §2.3 row, taken whole)."
  echo ""
  echo '```json'
  jq -n --argjson vm "$VM_POINTS" --argjson kn "$KN_POINTS" '{vm: $vm, knative: $kn}'
  echo '```'
} >>"$RESULTS"

[ "$FAIL" = 0 ] || exit 1
