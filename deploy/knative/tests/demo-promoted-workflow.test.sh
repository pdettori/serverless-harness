#!/usr/bin/env bash
# deploy/knative/tests/demo-promoted-workflow.test.sh
#
# Cluster-free tests for the promoted-workflow demo. The demo itself needs a cluster and two real
# model calls, so it cannot run on every PR -- but its FIXTURE can rot silently, and a rotted
# fixture turns the demo into a green run that proves nothing. Specifically:
#
#   - the A/B hinges on one unguessable string (the ticket id) living ONLY in the memory file, and
#     on one token living ONLY in the skill's references/ subdirectory. If an edit moves either into
#     CLAUDE.md or SKILL.md, the bare arm could produce it from the prompt alone and the demo's
#     central claim quietly becomes untestable.
#   - the constants the script greps for must match the fixture's contents. A typo in either makes
#     every claim fail against a working cluster, which reads as a broken feature.
#
# No cluster required. Run: bash deploy/knative/tests/demo-promoted-workflow.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX="$DIR/fixtures/promoted-demo"
SCRIPT="$DIR/demo-promoted-workflow.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else
  echo "  FAIL: $1 (want '$3', got '$2')"
  fails=$((fails + 1))
fi; }

echo "== fixture layout"
for f in CLAUDE.md skills/ship-note/SKILL.md skills/ship-note/references/release-token.md \
  commands/ship-note.md memory/MEMORY.md memory/auth-timeout-incident.md; do
  check "$f exists" "$([ -f "$FIX/$f" ] && echo yes || echo no)" "yes"
done

echo "== the script's constants match the fixture"
TICKET=$(grep -E '^TICKET=' "$SCRIPT" | head -1 | cut -d'"' -f2)
TOKEN=$(grep -E '^TOKEN=' "$SCRIPT" | head -1 | cut -d'"' -f2)
check "TICKET is set" "$([ -n "$TICKET" ] && echo yes || echo no)" "yes"
check "TOKEN is set" "$([ -n "$TOKEN" ] && echo yes || echo no)" "yes"
check "the ticket is in the memory file" \
  "$(grep -q "$TICKET" "$FIX/memory/auth-timeout-incident.md" && echo yes || echo no)" "yes"
check "the token is the release-token file's content" \
  "$(tr -d '[:space:]' < "$FIX/skills/ship-note/references/release-token.md")" "$TOKEN"

echo "== the unguessable strings leak nowhere else in the fixture"
# The ticket must not be reachable from anything the harness injects into the system prompt, or the
# bare arm gets it for free and stops being a control.
for f in CLAUDE.md skills/ship-note/SKILL.md commands/ship-note.md memory/MEMORY.md; do
  check "$f does not contain the ticket" \
    "$(grep -q "$TICKET" "$FIX/$f" && echo leaked || echo clean)" "clean"
done
# The token must exist ONLY in references/, so producing it requires a sandbox read.
check "SKILL.md does not contain the token" \
  "$(grep -q "$TOKEN" "$FIX/skills/ship-note/SKILL.md" && echo leaked || echo clean)" "clean"
check "CLAUDE.md does not contain the token" \
  "$(grep -q "$TOKEN" "$FIX/CLAUDE.md" && echo leaked || echo clean)" "clean"
check "the prompt the script sends does not contain the ticket" \
  "$(grep -E '^PROMPT=' "$SCRIPT" | grep -q "$TICKET" && echo leaked || echo clean)" "clean"

echo "== the skill is loadable by pi's resolver"
# resolve.ts reads the bare frontmatter `name`; classify.ts dedupes on it. A missing or namespaced
# name silently changes the bundle path the script asserts against.
check "SKILL.md has frontmatter name: ship-note" \
  "$(awk '/^name:/{print $2; exit}' "$FIX/skills/ship-note/SKILL.md")" "ship-note"
check "SKILL.md has a description (required by the Agent Skills spec)" \
  "$(grep -cE '^description:' "$FIX/skills/ship-note/SKILL.md")" "1"
# pi puts only name+description in the system prompt and tells the model to read the body, so the
# description is what decides whether the skill is ever loaded at all.
check "the description mentions a ship note, so the task matches it" \
  "$(grep -iE '^description:.*ship note' "$FIX/skills/ship-note/SKILL.md" >/dev/null && echo yes || echo no)" "yes"

echo "== SKILL.md instructs the sibling read the demo asserts"
check "SKILL.md names references/release-token.md" \
  "$(grep -q 'references/release-token.md' "$FIX/skills/ship-note/SKILL.md" && echo yes || echo no)" "yes"
check "SKILL.md tells the model to fail honestly rather than guess" \
  "$(grep -q 'unavailable' "$FIX/skills/ship-note/SKILL.md" && echo yes || echo no)" "yes"

echo "== MEMORY.md links resolve (a dangling link is a preflight warning)"
while read -r target; do
  [ -z "$target" ] && continue
  check "MEMORY.md link '$target' exists" \
    "$([ -f "$FIX/memory/$target" ] && echo yes || echo no)" "yes"
done < <(grep -oE '\]\([^)]+\.md\)' "$FIX/memory/MEMORY.md" | sed 's/](//; s/)//')

echo "== the script's own guards"
check "refuses a sandbox dir it did not create (marker gate)" \
  "$(grep -q 'REFUSING to touch' "$SCRIPT" && echo yes || echo no)" "yes"
check "does not default the redis forward to 6379" \
  "$(grep -qE '^REDIS_PORT=.*:-6379\}' "$SCRIPT" && echo bad || echo ok)" "ok"
check "gates on the deployed image implementing configRef" \
  "$(grep -q 'unknown digest' "$SCRIPT" && echo yes || echo no)" "yes"
check "purges the shared sandbox cache before the control run" \
  "$(grep -q 'sh-config' "$SCRIPT" && echo yes || echo no)" "yes"
check "verifies the upload landed in the cluster's redis" \
  "$(grep -q 'config:bundle:' "$SCRIPT" && echo yes || echo no)" "yes"

echo "== --teardown is sandbox-scoped and touches no cluster"
# Same property demo-teardown-scope.test.sh pins for the remote-worker demo: a teardown must not
# delete infrastructure it did not create. This demo's teardown removes a /tmp sandbox and nothing
# else, so any kind/kubectl call on that path is a regression. kind/kubectl/docker are mocked and
# only the call log is asserted.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/calls.log"
: > "$MOCK_LOG"
mkdir -p "$TMP/bin"
for b in kind kubectl docker pnpm; do
  cat > "$TMP/bin/$b" <<EOF
#!/usr/bin/env bash
echo "$b \$*" >> "\$MOCK_LOG"
exit 0
EOF
  chmod +x "$TMP/bin/$b"
done

# A sandbox carrying the marker: teardown must remove exactly this, via plain rm, not via a cluster.
SBX="$TMP/sandbox"
mkdir -p "$SBX"
touch "$SBX/.sh-demo-sandbox"
PATH="$TMP/bin:$PATH" SH_DEMO_SANDBOX="$SBX" bash "$SCRIPT" --teardown > "$TMP/out" 2>&1
check "teardown exits 0" "$?" "0"
check "the marked sandbox is gone" "$([ -e "$SBX" ] && echo present || echo gone)" "gone"
check "no kind calls" "$(grep -c '^kind ' "$MOCK_LOG")" "0"
check "no kubectl calls" "$(grep -c '^kubectl ' "$MOCK_LOG")" "0"

# An unmarked directory must survive: this is the guard against a mistyped SH_DEMO_SANDBOX.
UNMARKED="$TMP/not-ours"
mkdir -p "$UNMARKED"
touch "$UNMARKED/precious.txt"
PATH="$TMP/bin:$PATH" SH_DEMO_SANDBOX="$UNMARKED" bash "$SCRIPT" --teardown > "$TMP/out2" 2>&1
check "an unmarked directory is left alone" \
  "$([ -f "$UNMARKED/precious.txt" ] && echo kept || echo DELETED)" "kept"

if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails check(s)"
  exit 1
fi
echo "PASS"
