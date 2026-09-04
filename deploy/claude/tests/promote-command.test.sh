#!/usr/bin/env bash
# deploy/claude/tests/promote-command.test.sh
#
# Cluster-free tests for the /promote slash command asset. The command is a markdown prompt, so
# nothing type-checks it and nothing runs it in CI -- exactly the conditions under which
# promote-live-smoke.test.ts sat broken for a whole PR. These checks pin the parts that make it
# correct rather than merely present:
#
#   - `allowed-tools` must cover every command the body actually invokes -- including after `&&` and
#     `||`, which is where `echo` hid while an earlier version of this check claimed to cover
#     "every command" and did not -- or the user approves a permission prompt on every run and the
#     "one command" claim is false. Grants are matched whole, so tightening `kubectl:*` to per-verb
#     grants strengthens the check instead of bypassing it.
#   - the two flags whose absence silently promotes the WRONG THING (`--project`, `--home`) must be
#     in the documented invocation. Both were verified by measurement: without --project the CLI
#     promotes the harness checkout it was launched from, and without --home it resolves 56
#     travelling skills and cannot find the entry prompt at all.
#   - every command must be statically analyzable: no `$VAR`, no inline `VAR=value` prefix. This is
#     the check this file was missing. Claude Code parses each Bash command and matches a grant only
#     against one it can analyse, so `echo "${SH_HARNESS_DIR:-UNSET}"` and
#     `HOME="$PWD" pnpm --dir "$SH_HARNESS_DIR/harness" ...` matched NO grant however broad -- under
#     `defaultMode: dontAsk` the command aborted before the model saw the Context, and under `auto`
#     it was denied as `Contains expansion`. Every grant above can be correct and the command still
#     unrunnable, which is exactly what happened.
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
# Grants, kept WHOLE: "Bash(kubectl port-forward:*)" -> "kubectl port-forward". Collapsing these to
# a first word would accept any `kubectl` subcommand against a deliberately per-verb grant, so the
# check would silently weaken exactly when the grant is tightened.
PERMITTED="$(grep -oE 'Bash\([^):]+' <<< "$FM" | sed 's/^Bash(//' | sort -u)"
check "permits pnpm" "$(grep -cE '^pnpm' <<< "$PERMITTED")" "1"
check "grants kubectl per verb, not kubectl:*" \
  "$(grep -cxF 'kubectl' <<< "$PERMITTED")" "0"
# pnpm could not be narrowed while the invocation began with `HOME=... REDIS_URL=... pnpm`, because
# a grant matches from the first word. With those moved to flags it can be, so hold it there.
check "grants pnpm --dir, not pnpm:*" "$(grep -cxF 'pnpm' <<< "$PERMITTED")" "0"

# Every command the body actually runs, one per line: the ! probes plus the bash fences, split on
# && || ; | and newlines FIRST. Keeping only the first word of each probe hid every `&& echo`/
# `|| echo`, which is how `echo` stayed ungranted while a test claiming to cover "every command"
# passed. Env assignments are still stripped, so a reintroduced `HOME=... pnpm ...` is seen as pnpm
# by the coverage loop rather than vanishing from it -- the expansion section below is what rejects
# the prefix itself.
RUNS="$( {
  grep -oE '!`[^`]+`' "$CMD" | sed 's/^!`//; s/`$//'
  awk '/^```bash$/{f=1; next} /^```$/{f=0} f' "$CMD"
} | sed -E 's/[[:space:]]*(&&|\|\||;|\|)[[:space:]]*/\n/g' |
  sed -E 's/^[[:space:]]+//; s/^[0-9]*>[^[:space:]]*[[:space:]]*//' | grep -v '^$')"

# Second word kept when it is a flag (`-d`, `--dir`), not just a bare word: without that, the
# invocation `pnpm --dir ...` collapsed to `pnpm`, which the loop below then waved through as "a
# grant prefix, not an invocation" -- passing without ever checking the grant it was tightened to.
USED="$(sed -E 's/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|[^[:space:]]*)[[:space:]]+)+//' <<< "$RUNS" |
  grep -oE '^[a-z][a-z0-9_-]*([[:space:]]+-{0,2}[a-z][a-z0-9_-]*)?' | sort -u)"

# Each invocation must be covered by SOME grant, matched as a prefix so a two-word grant
# ("kubectl port-forward") covers a longer invocation and a one-word grant ("ls") still covers "ls -d".
for u in $(printf '%s\n' "$USED" | tr ' ' '@'); do
  inv="$(printf '%s' "$u" | tr '@' ' ')"
  covered=no
  while read -r g; do
    [ -z "$g" ] && continue
    case "$inv " in "$g "*) covered=yes; break ;; esac
    case "$inv" in "$g") covered=yes; break ;; esac
  done <<< "$PERMITTED"
  # A bare first word of a two-word grant is not itself an invocation (e.g. "kubectl" alone never
  # runs); skip it rather than demanding a grant that would have to be widened.
  if [ "$covered" = no ] && grep -qE "^$inv " <<< "$PERMITTED"; then covered=skip; fi
  case "$covered" in
    yes) echo "  ok: allowed-tools covers '$inv'" ;;
    skip) echo "  ok: '$inv' is a grant prefix, not an invocation" ;;
    *)
      echo "  FAIL: '$inv' is invoked but not granted"
      fails=$((fails + 1))
      ;;
  esac
done

# kubectl is instructed in prose (guard 3's port-forward, the redis-cli EXISTS verify) rather than
# inside a ! probe or a bash fence, so the extraction above cannot see it. This floor exists to
# cover that blind spot -- it is not redundant with the loop.
for needed in "kubectl port-forward" "kubectl exec"; do
  check "grants '$needed', which appears only in prose" \
    "$(grep -cxF "$needed" <<< "$PERMITTED")" "1"
done

echo "== every command is statically analyzable, or no grant can match it"
# The regression this section exists for: the asset can name every right flag, grant every right
# tool, and still be refused wholesale because the commands carry shell syntax the permission layer
# will not reason about. Scope is the extracted commands only -- prose legitimately writes
# `$SH_HARNESS_DIR` and `$ARGUMENTS` when talking ABOUT them.
check "no probe or fenced command contains a \$ expansion" \
  "$(grep -c '[$]' <<< "$RUNS")" "0"
check "no command carries an inline VAR=value prefix" \
  "$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' <<< "$RUNS")" "0"
# Pin the measured reason, not just the shape: a later edit that reintroduces "$PWD" for brevity
# should have to delete an explanation that says what it costs.
check "says why literal paths are required" \
  "$(grep -ciE 'Contains expansion' "$CMD" | awk '$1>0{print 1; exit} {print 0}')" "1"
check "tells the model to substitute the paths literally" \
  "$(tr '\n' ' ' < "$CMD" | grep -ciE 'never .\$PWD., never .\$SH_HARNESS_DIR.' | awk '$1>0{print 1; exit} {print 0}')" "1"

echo "== the grant's turn scope is stated, because it is what actually broke a run"
# `allowed-tools` holds only for the turn the slash command creates. A run that ended its turn on
# "I'll check the guards, then promote" lost the grant, and every later `pnpm` call was refused by
# permission-rule -- indistinguishable, from the user's side, from the command being broken. The
# instruction to finish in one turn, and to re-invoke rather than continue, is load-bearing.
check "tells the model to finish in this turn" \
  "$(tr '\n' ' ' < "$CMD" | grep -ciE 'this turn only' | awk '$1>0{print 1; exit} {print 0}')" "1"
check "says to re-run rather than continue in a new turn" \
  "$(tr '\n' ' ' < "$CMD" | grep -ciE 're-run .?/promote' | awk '$1>0{print 1; exit} {print 0}')" "1"
check "names the session-level grant that survives a stopped turn" \
  "$(grep -c -- '--allowedTools' "$CMD")" "1"

echo "== the invocation cannot silently promote the wrong thing"
# Counted as present-or-absent: each legitimately appears twice, once in the invocation and once
# in the prose explaining why it is not redundant.
present() { [ "$1" -ge 1 ] && echo 1 || echo 0; }
check "passes --project explicitly" "$(present "$(grep -c -- '--project <this-project>' "$CMD")")" "1"
check "points user scope at the project with --home" \
  "$(present "$(grep -c -- '--home <this-project>' "$CMD")")" "1"
# Present-or-absent, like the flags above: this now appears twice on purpose, once in the invocation
# and once in the `--allowedTools` rule the model is told to suggest when a guard stops the turn.
check "runs the CLI via --dir on the harness checkout" \
  "$(present "$(grep -c -- '--dir <harness-checkout>/harness' "$CMD")")" "1"
check "names the redis to upload to, rather than inheriting one" \
  "$(present "$(grep -c -- '--redis-url redis://localhost:16379' "$CMD")")" "1"
check "explains why --project is not redundant" \
  "$(grep -ciE 'do not "simplify"|not "simplify" them' "$CMD")" "1"

echo "== it self-excludes when it lives in the project it promotes"
# Without this the command ships itself as a prompt template whenever it is installed in the project
# (which is the placement that buys local/remote parity). The conditional matters as much as the
# flag: passing --exclude-prompt unconditionally would trip the flag's own typo guard.
check "probes whether the project carries this command" \
  "$(grep -c 'test -f .claude/commands/promote.md' "$CMD")" "1"
check "tells the model to pass --exclude-prompt promote" \
  "$(grep -c -- '--exclude-prompt promote' "$CMD")" "1"
# Folded to one line before matching: `grep` is line-based and this phrase wraps in promote.md, so
# an `only.*in that case` pattern never matched and the check passed on the warning name alone --
# leaving the conditionality it is named for unpinned against a reflow that dropped the "only".
check "says to add it ONLY when the command is local" \
  "$(tr '\n' ' ' < "$CMD" | grep -ciE 'add it [^.]*only[^.]*in that case' | awk '$1>0{print 1; exit} {print 0}')" "1"

echo "== the redis tunnel is the private port, not 6379"
check "port-forwards 16379:6379" "$(grep -c '16379:6379' "$CMD")" "1"
check "the redis url uses 16379" "$(grep -c 'redis://localhost:16379' "$CMD")" "1"
check "never points the redis url at 6379" "$(grep -c 'redis://localhost:6379' "$CMD")" "0"
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
