---
description: Promote this project's Claude Code workflow into the serverless harness
argument-hint: <entry-prompt> [--dry-run] [--deny <skill>] [--sandbox-image <ref>]
allowed-tools: Bash(pnpm:*), Bash(kubectl port-forward:*), Bash(kubectl exec:*), Bash(test:*), Bash(ls:*), Bash(lsof:*), Bash(pwd), Bash(echo:*), Bash(git init:*)
---

<!--
allowed-tools notes, so a later edit does not widen this back:
  * kubectl is granted per verb (port-forward, exec) rather than as `kubectl:*`, because this file is
    installed into real user scope and is therefore visible in every project -- `kubectl:*` would
    carry `kubectl delete` with it.
  * pnpm stays broad on purpose. The documented invocation begins with env assignments
    (`HOME="$PWD" REDIS_URL=... pnpm --dir ...`), so a narrower `Bash(pnpm --dir:*)` prefix is not
    reliably matched, and the env has to be inline because exports do not survive between tool calls.
  * echo is granted because the Context probes end in `&& echo`/`|| echo`.
  * the self-exclusion probe needs nothing new: `test -f` and `echo` are already granted.
  * jq and `git rev-parse` were granted but never invoked, and are gone. `git init` stays: guard 1
    offers it.
-->

## Context

- Project being promoted (this is what travels): !`pwd`
- Harness checkout (`$SH_HARNESS_DIR`): !`echo "${SH_HARNESS_DIR:-UNSET}"`
- Harness CLI present: !`test -f "${SH_HARNESS_DIR:-/nonexistent}/harness/package.json" && echo yes || echo NO`
- Workflow config here: !`ls -d .claude/skills .claude/commands 2>/dev/null || echo "no .claude/skills or .claude/commands"`
- Repo boundary for the context walk: !`test -e .git && echo ".git present" || echo "NO .git — see guard 1"`
- Cluster Redis tunnel on 16379: !`lsof -nP -iTCP:16379 -sTCP:LISTEN >/dev/null 2>&1 && echo "listening" || echo "absent"`
- This command lives in the project: !`test -f .claude/commands/promote.md && echo "yes — must self-exclude" || echo "no"`

## Your task

Promote the workflow in the current directory into the harness, then explain the result.

`$ARGUMENTS` — the **first** word is the entry prompt name (a file in `.claude/commands/<name>.md`).
Pass any remaining words through to the CLI verbatim. With no arguments, list the available entry
names from `.claude/commands/` and stop; do not guess one.

### Check the three guards first

These are not hypothetical — each one produced a confident, wrong result during development.

1. **No `.git` in this directory.** `promote` bounds its `CLAUDE.md` chain walk at a `.git` entry.
   Without one it climbs into ancestor directories and sweeps their context files — including a
   personal `~/CLAUDE.md` — into a bundle bound for a shared store. If the Context above says
   `NO .git`, say so and offer `git init` before promoting. Do not promote past this silently.

2. **`$SH_HARNESS_DIR` unset or wrong.** The CLI must run from the harness checkout: there is no
   installed binary, and the sandbox inventory is resolved relative to the harness _module_, so
   running it from here would silently degrade the binary check to `inventory_unavailable`. If it is
   unset or the CLI is missing, stop and tell the user to
   `export SH_HARNESS_DIR=/path/to/serverless-harness`.

3. **Redis.** Upload must go to the **cluster's** Redis. If the tunnel is `absent`, start it in the
   background: `kubectl port-forward -n default svc/redis 16379:6379`. Use **16379**, never 6379 —
   this repo's own test container publishes `0.0.0.0:6379`, and promoting into it reports a
   successful upload while the harness then fails with `config bundle not found` for that exact
   digest. If 16379 is in use by something that is not this tunnel, say so rather than assuming.

### Promote

```bash
HOME="$PWD" REDIS_URL=redis://localhost:16379 \
  pnpm --dir "$SH_HARNESS_DIR/harness" promote --entry <entry> --project "$PWD" <extra-args>
```

**If the Context above says this command lives in the project, add
`--exclude-prompt promote`.** Otherwise it ships itself into the bundle as a prompt template, since
`HOME="$PWD"` makes this project's `.claude/commands/` the prompts directory. Add it **only** in that
case: passing it when there is no local `promote.md` produces a `prompt_exclude_unmatched` warning,
which is the flag's own typo guard firing on a false alarm.

Two parts of that are load-bearing, so do not "simplify" them:

- **`HOME="$PWD"`** makes this directory its own user scope, so only this workflow travels. Without
  it, promote reads your real `~/.claude` — measured at 56 travelling skills and ~8.6 MB versus one
  skill and ~12 KB — and it is also what makes this project's `.claude/commands/` entry prompt
  visible at all, since promote reads prompts from user scope only.
- **`--project "$PWD"`** is passed explicitly even though it looks redundant: run without it the CLI
  promotes whatever directory the process started in, which through `pnpm --dir` is the harness
  checkout, not this project.

### Then verify and explain

- If the upload succeeded, confirm the bundle reached the **cluster's** store by reading it back
  through the cluster's own client, not through the tunnel — this is the only check that
  distinguishes the two Redises:
  `kubectl exec -n default deploy/redis -- redis-cli EXISTS "config:bundle:<digest>"` → expect `1`.
- Report: how many skills travelled, how many dropped and **why** for each, whether preflight was
  clean, the digest, the bundle size, whether the upload was skipped as unchanged, and the lockfile
  path.
- Show the dispatch envelope the CLI prints, with the real digest filled in.

Interpret the exit code rather than echoing the raw error:

- **exit 2 — preflight errors.** Name what blocked. `unknown_entry` means the entry prompt is not in
  the bundle; list what is.
- **exit 3 — a structural credential match.** Give the `path:line` and the rule that matched. Say
  plainly that this one blocks because a credential reaching a shared store cannot be un-shared by
  re-promoting, and that the fix is removing it or adding the file to a deny-list — not a retry.
- **Warnings are not errors.** A clean promotion can still carry warnings (a dropped skill, a
  binary the sandbox may not have). Summarise them; do not present them as failure.

Finally, note what promotion does **not** carry: MCP servers and subagents are out of scope, and
promoted memory travels read-only, so a remote run consumes what it was taught locally and returns
discoveries in the leaf result instead of writing back.
