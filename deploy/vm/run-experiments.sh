#!/usr/bin/env bash
# Run E8 and E9 under ONE configuration, so their records are comparable.
#
# This is the stub-driven measurement path: it produces the headline numbers. It is NOT proof
# that the VM path works against a real model -- that is v-live-gate.sh (spec Sec 5.5).
set -euo pipefail
cd "$(dirname "$0")"

[ "${V_LIVE:-0}" = "1" ] || {
  echo "SKIP (set V_LIVE=1 to run the P6 VM experiments)"
  exit 0
}

: "${SH_WORKERS:?SH_WORKERS must match the running supervisor}"
: "${SH_TURNS_PER_WORKER:?SH_TURNS_PER_WORKER must match the running supervisor (no default: Sec 3.8)}"

export V_LADDER="${V_LADDER:-1 2 4 8 16 32}"
export V_DEGRADE_X="${V_DEGRADE_X:-2}"
export V_MIN_C="${V_MIN_C:-4}"
export V_DUTY_BASIS="${V_DUTY_BASIS:-e6-ocp}"
# Both drivers must read telemetry from the same admin listener, or their attribution columns
# describe two different supervisors (plan 1 Task 11).
export V_METRICS_BASE="${V_METRICS_BASE:-http://127.0.0.1:8081}"
# Final review fix, part 3, item A3: SH_STUB_* used to be exported here unconditionally, but the
# stub is a separate long-lived process configured by ITS OWN env at ITS OWN boot -- an export
# here cannot affect a process that is already running. Its only effect was to make a wrong
# value LOOK deliberate. Both drivers now fetch the stub's own /profile route instead (see
# stub_profile in lib-vm.sh); this script no longer names a stub config at all.

echo "== P6 VM experiments (stub-driven) =="
echo "ladder='$V_LADDER' basis=$V_DUTY_BASIS"
echo "This is the stub-driven measurement path. It does NOT prove the VM path works against a"
echo "real model -- run deploy/vm/v-live-gate.sh separately for that (spec Sec 5.5)."

./e8-density.sh
# E9 needs a cluster and its own second, co-located stub instance (item A4: one stub per arm,
# never one shared instance); skip it rather than fail the whole invocation when there isn't one.
if [ -n "${KSVC_URL:-}" ] && [ -n "${V_VM_STUB_URL:-}" ] && [ -n "${V_KNATIVE_STUB_URL:-}" ]; then
  ./e9-tiers.sh
else
  echo "SKIP E9 (set KSVC_URL, V_VM_STUB_URL, and V_KNATIVE_STUB_URL for the tier comparison)"
fi

echo "Results appended to ./EXPERIMENTS.md"
