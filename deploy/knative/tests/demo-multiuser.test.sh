#!/usr/bin/env bash
# deploy/knative/tests/demo-multiuser.test.sh
#
# Cluster-free tests for the multi-user demo. The demo itself needs a cluster, a registered GitHub
# OAuth app and two humans at a browser, so it cannot run on any PR -- but the things that make it
# either honest or dangerous are all statically checkable:
#
#   - it must SKIP, not fail, when SH_GITHUB_CLIENT_ID is unset (the env-gated live-smoke convention);
#   - it must run with SH_REQUIRE_AUTH=true, or it demonstrates the permissive default instead of the
#     property (spec §4.3.1);
#   - it must RESTORE that flag on exit, or it leaves the next smoke run 401ing on every /turn;
#   - it must never echo a token, a KEK or a device code into the transcript;
#   - it must state out loud that slice 1's sandbox pool is SHARED (spec §8.2), because a demo that
#     quietly implies isolation it does not have is worse than no demo.
#
# No cluster required. Run: bash deploy/knative/tests/demo-multiuser.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/demo-multiuser.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

echo "== the script exists and is shellcheck-shaped"
check "script exists" "$([ -f "$SCRIPT" ] && echo yes || echo no)" "yes"
check "has set -euo pipefail" "$(grep -c '^set -euo pipefail' "$SCRIPT")" "1"
check "sources lib.sh" "$(grep -q 'source ./lib.sh' "$SCRIPT" && echo 1 || echo 0)" "1"

echo "== it gates on the manual prerequisite and SKIPS rather than failing"
check "mentions SH_GITHUB_CLIENT_ID" \
  "$(grep -q 'SH_GITHUB_CLIENT_ID' "$SCRIPT" && echo 1 || echo 0)" "1"
check "skips (exit 0) when the client id is unset" \
  "$(grep -q 'SKIP' "$SCRIPT" && echo 1 || echo 0)" "1"
check "gates on MULTIUSER_LIVE_SMOKE like the other live gates" \
  "$(grep -q 'MULTIUSER_LIVE_SMOKE' "$SCRIPT" && echo 1 || echo 0)" "1"

echo "== it demonstrates the real property, not the permissive default"
check "turns SH_REQUIRE_AUTH on" \
  "$(grep -q 'SH_REQUIRE_AUTH=true' "$SCRIPT" && echo 1 || echo 0)" "1"
check "restores SH_REQUIRE_AUTH in cleanup" \
  "$(grep -q 'SH_REQUIRE_AUTH=false' "$SCRIPT" && echo 1 || echo 0)" "1"
check "has an EXIT trap, so an aborted run still restores it" \
  "$(grep -q 'trap cleanup EXIT' "$SCRIPT" && echo 1 || echo 0)" "1"
check "asserts the credential property with the ambient key present" \
  "$(grep -q 'credential_required' "$SCRIPT" && echo 1 || echo 0)" "1"
check "asserts a cross-tenant 404" "$(grep -q 'Claim 4' "$SCRIPT" && echo 1 || echo 0)" "1"
check "asserts session_mismatch" "$(grep -q 'session_mismatch' "$SCRIPT" && echo 1 || echo 0)" "1"
check "asserts token_required under the flag" \
  "$(grep -q 'token_required' "$SCRIPT" && echo 1 || echo 0)" "1"
check "reads /resources" "$(grep -q '/resources' "$SCRIPT" && echo 1 || echo 0)" "1"

echo "== it is honest about what slice 1 does NOT isolate"
check "says the sandbox pool is shared" \
  "$(grep -qi 'pool is shared\|shared pool' "$SCRIPT" && echo 1 || echo 0)" "1"

echo "== it never prints a secret"
# A demo transcript gets pasted into issues. Tokens, KEKs and device codes must not be in it.
#
# The pattern must admit BOTH `$VAR` and `${VAR}`: shellcheck pushes authors toward the braced form,
# so a guard matching only `\$(NAME|...)` would wave through `echo "${ALICE_TOKEN}"` -- the single most
# likely way this leak actually gets written. `printf` is covered for the same reason.
check "no echo/printf of a token, KEK or exchange secret, braced or bare" \
  "$(grep -Ec '(echo|printf).*\$\{?(ALICE_TOKEN|BOB_TOKEN|EXCHANGE_TOKEN|KEK|SH_CREDENTIAL_KEK|SH_EXCHANGE_TOKEN|SH_SESSION_TOKEN_PRIVATE_KEY)' "$SCRIPT")" "0"
check "the user_code IS printed (the operator must type it)" \
  "$(grep -q 'userCode' "$SCRIPT" && echo 1 || echo 0)" "1"

echo "== it applies the opt-in manifest rather than assuming it is deployed"
check "applies control-plane.yaml" \
  "$(grep -q 'control-plane.yaml' "$SCRIPT" && echo 1 || echo 0)" "1"
check "waits for the rollout" \
  "$(grep -q 'rollout status' "$SCRIPT" && echo 1 || echo 0)" "1"

echo "== the Makefile exposes it"
MK="$DIR/../../Makefile"
check "make demo-multiuser exists" "$(grep -q '^demo-multiuser:' "$MK" && echo 1 || echo 0)" "1"
check "make demo-multiuser-teardown exists" \
  "$(grep -q '^demo-multiuser-teardown:' "$MK" && echo 1 || echo 0)" "1"

if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all ok"
