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
export SH_STUB_TTFT_MS="${SH_STUB_TTFT_MS:-300}"
export SH_STUB_TOKEN_DELAY_MS="${SH_STUB_TOKEN_DELAY_MS:-12}"
export SH_STUB_OUTPUT_TOKENS="${SH_STUB_OUTPUT_TOKENS:-64}"
export SH_STUB_TOOL_CALL_RATE="${SH_STUB_TOOL_CALL_RATE:-0.07}"

echo "== P6 VM experiments (stub-driven) =="
echo "ladder='$V_LADDER' basis=$V_DUTY_BASIS"
echo "stub: ttft=${SH_STUB_TTFT_MS}ms delay=${SH_STUB_TOKEN_DELAY_MS}ms tokens=$SH_STUB_OUTPUT_TOKENS toolRate=$SH_STUB_TOOL_CALL_RATE"
echo "This is the stub-driven measurement path. It does NOT prove the VM path works against a"
echo "real model -- run deploy/vm/v-live-gate.sh separately for that (spec Sec 5.5)."

./e8-density.sh
# E9 needs a cluster; skip it rather than fail the whole invocation when there isn't one.
if [ -n "${KSVC_URL:-}" ] && [ -n "${V_STUB_URL:-}" ]; then
  ./e9-tiers.sh
else
  echo "SKIP E9 (set KSVC_URL and V_STUB_URL for the tier comparison)"
fi

echo "Results appended to ./EXPERIMENTS.md"
