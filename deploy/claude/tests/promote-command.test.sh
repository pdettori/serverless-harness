#!/usr/bin/env bash
# deploy/claude/tests/promote-command.test.sh
#
# Cluster-free tests for the /promote slash command asset. The command is a markdown prompt, so
# nothing type-checks it and nothing runs it in CI -- exactly the conditions under which
# promote-live-smoke.test.ts sat broken for a whole PR. These checks pin the parts that make it
# correct rather than merely present:
#
#   - `allowed-tools` must cover every command the body actually invokes, or the user approves a
#     permission prompt on every run and the "one command" claim is false.
#   - the two flags whose absence silently promotes the WRONG THING (`--project`, `HOME=`) must be
#     in the documented invocation. Both were verified by measurement: without --project the CLI
#     promotes the harness checkout it was launched from, and without HOME it resolves 56
#     travelling skills and cannot find the entry prompt at all.
#   - the redis tunnel must be 16379. On 6379 it reaches this repo's own test container, which
#     reports a successful upload and then a `config bundle not found` from the harness.
#
# No cluster required. Run: bash deploy/claude/tests/promote-command.test.sh
set -uo pipefail

CMD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/commands/promote.md"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

echo "== the asset exists and has frontmatter"
check "promote.md exists" "$([ -f "$CMD" ] && echo yes || echo no)" "yes"
[ -f "$CMD" ] || {
  echo "FAILED: no command file"
  exit 1
}
check "opens with a frontmatter fence" "$(head -1 "$CMD")" "---"
FM="$(awk '/^---$/{n++; next} n==1{print} n>1{exit}' "$CMD")"
for key in description argument-hint allowed-tools; do
  check "frontmatter has $key" "$(grep -cE "^$key:" <<< "$FM")" "1"
done

echo "== allowed-tools covers every command the body invokes"
# Permitted command prefixes, e.g. "Bash(kubectl:*)" -> kubectl
PERMITTED="$(grep -oE 'Bash\([a-z]+' <<< "$FM" | sed 's/Bash(//' | sort -u)"
check "permits at least pnpm and kubectl" \
  "$(grep -cE '^(pnpm|kubectl)$' <<< "$PERMITTED")" "2"
# Commands the body actually runs: the first word of every !`...` context probe, plus the first
# word of each line inside fenced bash blocks (skipping continuations and env assignments).
USED="$( {
  grep -oE '!`[^`]+`' "$CMD" | sed 's/^!`//; s/`$//'
  awk '/^```bash$/{f=1; next} /^```$/{f=0} f' "$CMD"
} | sed -E 's/^[[:space:]]+//' |
  sed -E 's/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|[^[:space:]]*)[[:space:]]+)+//' |
  grep -oE '^[a-z][a-z0-9_-]*' | sort -u | grep -vE '^(echo|then|else|fi|do|done)$')"
for c in $USED; do
  check "allowed-tools covers '$c'" "$(grep -cxF "$c" <<< "$PERMITTED")" "1"
done

echo "== the invocation cannot silently promote the wrong thing"
# Counted as present-or-absent: both legitimately appear twice, once in the invocation and once
# in the prose explaining why they are not redundant.
present() { [ "$1" -ge 1 ] && echo 1 || echo 0; }
check "passes --project explicitly" "$(present "$(grep -c -- '--project "\$PWD"' "$CMD")")" "1"
check "sets HOME to the project" "$(present "$(grep -c 'HOME="\$PWD"' "$CMD")")" "1"
check "runs the CLI via --dir on the harness checkout" \
  "$(grep -c -- '--dir "\$SH_HARNESS_DIR/harness"' "$CMD")" "1"
check "explains why --project is not redundant" \
  "$(grep -ciE 'do not "simplify"|not "simplify" them' "$CMD")" "1"

echo "== the redis tunnel is the private port, not 6379"
check "port-forwards 16379:6379" "$(grep -c '16379:6379' "$CMD")" "1"
check "REDIS_URL uses 16379" "$(grep -c 'redis://localhost:16379' "$CMD")" "1"
check "never points REDIS_URL at 6379" "$(grep -c 'redis://localhost:6379' "$CMD")" "0"
check "says why 6379 is wrong" "$(grep -ciE '0\.0\.0\.0:6379|test container publishes' "$CMD")" "1"

echo "== the three measured guards are all present"
check "guard: .git bounds the context walk" "$(grep -ciE '\.git' "$CMD" | awk '$1>0{print 1; exit} {print 0}')" "1"
check "guard: SH_HARNESS_DIR / inventory resolution" \
  "$(grep -ciE 'inventory_unavailable' "$CMD" | awk '$1>0{print 1; exit} {print 0}')" "1"
check "guard: cluster-side verification of the upload" \
  "$(grep -c 'redis-cli EXISTS' "$CMD")" "1"

echo "== exit codes are interpreted, not echoed"
check "explains exit 2 (preflight)" "$(grep -c 'exit 2' "$CMD")" "1"
check "explains exit 3 (structural secret)" "$(grep -c 'exit 3' "$CMD")" "1"
check "distinguishes warnings from errors" \
  "$(grep -ciE 'Warnings are not errors' "$CMD")" "1"

echo "== it does not overpromise what promotion carries"
check "names MCP and subagents as out of scope" \
  "$(grep -ciE 'MCP servers and subagents' "$CMD")" "1"
check "says memory travels read-only" "$(grep -ciE 'read-only' "$CMD" | awk '$1>0{print 1; exit} {print 0}')" "1"

if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails check(s)"
  exit 1
fi
echo "PASS"
