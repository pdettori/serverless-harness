# Demo: "The workflow you built on your laptop, running in the cluster"

A ~8-minute walkthrough of **workflow promotion**: you author an agent workflow in Claude Code — a
skill, a `CLAUDE.md`, a memory file, a slash command — and run it **unchanged** in the harness by
adding one field to a dispatch.

The task — write a ship note — is just a vehicle. The real show is **what the remote agent knows**.
You will send the same prompt twice, to the same cluster, differing only by `configRef`, and watch
one run ask what a ship note even is while the other cites an incident id that exists nowhere but
your laptop's memory directory.

```
laptop                                    cluster
------                                    -------
/tmp/sh-demo               promote        harness pod (fs-free)      sandbox pod
  CLAUDE.md          --> canonical tar -->  /tmp/sh-config/<digest>/   /workspace/.sh-config/<digest>/
  .claude/skills/          sha256 in           skills/  context/            skills/
  .claude/commands/         Redis              (system prompt)         (what `read` can see)
  .claude/projects/*/memory/
```

One digest names both halves. The dispatch carries the digest and nothing else about the workflow.

| Act                    | What "move my workflow to the server" normally needs               | What promotion needs                                                               |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **1 — Author small**   | A hand-written manifest listing what to ship, kept in sync by hand | **One env var.** `HOME=$SANDBOX` makes the sandbox its own user scope              |
| **2 — Promote**        | An image rebuild, a redeploy, a registry push                      | `pnpm promote` — a 12 KB tar, content-addressed; re-promotion uploads **nothing**  |
| **3 — Run it**         | A bespoke endpoint that knows about your skills                    | **One field.** `"configRef": "sha256:…"` on the existing prompt envelope           |
| **4 — Know it landed** | Read the pod logs and hope                                         | The run cites a fact only your memory holds, and a token only the sandbox can read |

Prefer it non-interactive? `make demo-promoted-workflow` does all of this and asserts every claim.
This document is the version you drive by hand so you can explain each move.

---

## Act 0: Install

You need a **warm** harness cluster whose image contains the promotion feature (merged in
[#214](https://github.com/rossoctl/serverless-harness/pull/214)). If you do not have one:

```bash
git clone --recurse-submodules https://github.com/rossoctl/serverless-harness.git
cd serverless-harness
cd pi-fork && npm ci && npm run build && cd ..
pnpm install

export ANTHROPIC_API_KEY=sk-...    # ...or a gateway: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
./deploy/knative/setup-kind.sh
```

> The model must be reachable **from the cluster** — both runs are real model calls.

If your cluster is already warm but predates #214, rebuild and **force a new Revision**. The image
tag is mutable, so re-applying an unchanged spec rolls nothing and you would keep serving the old
code:

```bash
docker build --load -t dev.local/serverless-harness:local .
kind load docker-image dev.local/serverless-harness:local --name sh-knative
kubectl -n default patch ksvc serverless-harness --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"deploy.sh/build-ts\":\"$(date +%s)\"}}}}}"
kubectl wait ksvc/serverless-harness -n default --for=condition=Ready --timeout=180s
```

Set the convenience vars used throughout:

```bash
export NS=default KSVC=serverless-harness
export HOSTHDR='Host: serverless-harness.default.example.com'
export BASE=http://localhost:8080
export SANDBOX=/tmp/sh-demo
export MODEL=claude-haiku-4-5
```

### Open the two tunnels

```bash
kubectl port-forward -n kourier-system svc/kourier 8080:80 &
kubectl port-forward -n default svc/redis 16379:6379 &
export REDIS_URL=redis://localhost:16379
```

> **Why 16379 and not 6379.** A listener on 6379 is not evidence it is _this cluster's_ Redis. This
> repo's own test container (`sh-tdd-redis`) publishes `0.0.0.0:6379`; promote will happily upload
> into it, print `uploaded`, and then the harness — reading the cluster's Redis — fails with
> `config bundle not found` for the digest sitting right there in your terminal. Bind a private port
> instead. This cost the author two model calls before the failure surfaced.

### 0a. Prove the cluster implements promotion before you trust anything else

An unknown digest must fail **before** any model call. An image without the feature ignores the
field and answers normally — which would make Act 3's contrast look like a model mood swing rather
than a missing deployment:

```bash
curl -s -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d '{"sessionId":"probe-1","kind":"prompt","prompt":"say hi",
       "configRef":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}' \
  $BASE/runs | jq -c .
```

```json
{ "status": "failed", "reason": "error", "message": "config bundle not found: sha256:ffff…" }
```

> If you get `{"status":"responded", …}` instead, the cluster is serving a pre-#214 image. Stop and
> do the forced roll above. A green demo on the wrong image proves nothing.

---

## Act 1: Author in a sandbox, not in your whole `~/.claude`

> **Say this out loud, because it is the part people get wrong.** The tempting demo is "promote my
> real Claude Code setup". Don't. Measured on the author's laptop: a real `~/.claude` resolves **62
> skills**, 56 of which travel, into an ~8.6 MB bundle with dozens of preflight warnings — nearly
> all from skills the workflow never uses. A curated sandbox ships **one** skill in **12 KB** with
> **zero** findings. That is the design's own recommendation ([spec §11]) and this act is it.

### 1a. Build the workflow

Four files. A skill that defines a format, a `CLAUDE.md` that sets a house rule, a memory file
holding a fact, and a slash command as the entry point:

```bash
mkdir -p $SANDBOX/.claude/skills/ship-note/references $SANDBOX/.claude/commands
cp -R deploy/knative/fixtures/promoted-demo/skills/. $SANDBOX/.claude/skills/
cp -R deploy/knative/fixtures/promoted-demo/commands/. $SANDBOX/.claude/commands/
cp deploy/knative/fixtures/promoted-demo/CLAUDE.md $SANDBOX/CLAUDE.md

# Claude Code's own memory layout: every path separator in the project path becomes '-'
MEM="$SANDBOX/.claude/projects/-$(echo "${SANDBOX#/}" | tr '/' '-')/memory"
mkdir -p "$MEM" && cp deploy/knative/fixtures/promoted-demo/memory/*.md "$MEM/"

git -C $SANDBOX init -q
```

> **Why `git init`.** `promote` bounds its `CLAUDE.md` walk at a `.git` entry. Without one it climbs
> past your sandbox into ancestor directories and sweeps their context files — including a personal
> `~/CLAUDE.md` — into a bundle bound for a shared store.

The memory file is the one to read aloud, because it is what makes Act 3 undeniable:

```bash
cat "$MEM/auth-timeout-incident.md"
```

It records that the regression is tracked as **KAG-4471** and ships behind
`auth.idle_reaper_v2`. Nothing else in the demo knows that.

### 1b. Watch it work locally first

```bash
cd $SANDBOX && claude
```

Ask it: `Write the ship note for the auth timeout fix.` You get the house `SHIP NOTE` block with
the ticket and the risk line. This is the "works on my laptop" baseline — the thing that normally
does not survive the trip.

> Leave this Claude Code session open. You will drive the rest of the demo _from it_: it is the
> terminal where the workflow was authored, so promoting and dispatching from here is the point.

---

## Act 2: Promote

### 2a. One command, and one env var that is the whole idea

```bash
HOME=$SANDBOX pnpm --dir ~/path/to/serverless-harness/harness promote \
  --entry ship-note --project $SANDBOX
```

```
project:    /tmp/sh-demo
inventory:  …/sandbox-inventory/ghcr.io_rossoctl_serverless-harness-sandbox_latest.json (347 binaries)
  resolved   1 skills
  travels    1
  dropped    0
  context    2 file(s), 1 memory file(s)
  secrets    no blocking findings
  entry      ship-note

preflight: no findings

  bundle     sha256:46ee1106…  (12288 bytes, uploaded)
  lockfile   .claude/promoted.lock.json

dispatch with:  {"sessionId":"<run>/<item>","kind":"prompt","prompt":"…","configRef":"sha256:46ee1106…"}
```

> **`HOME=$SANDBOX` is the demo, not a shortcut.** `promote` reads _user_ scope from
> `$HOME/.claude`. Pointing `HOME` at the sandbox makes the sandbox its own user scope, so the
> bundle holds this workflow and nothing else. It is also what makes the **slash command** travel:
> `promote` reads prompts from user scope only, so a project-scope `.claude/commands/` file is
> invisible to it without this.
>
> Note `travels 1`, `preflight: no findings`, and `12288 bytes`. Those three numbers are the
> argument for sandbox-first authoring, and the last line hands you the exact dispatch envelope.

The lockfile is committable, and it is also the most convenient place to read the digest back from:

```bash
export DIGEST=$(jq -r .digest $SANDBOX/.claude/promoted.lock.json)
echo $DIGEST
# => sha256:46ee11062906cf70d6770a1a9c58b01429836ba4b16861b65110673904603bb4
```

### 2b. Verify it landed in the cluster's Redis, not somewhere else

Read the key back through the cluster's **own** client rather than your port-forward. A forward
pointing at the wrong Redis passes every check up to here:

```bash
kubectl exec -n $NS deploy/redis -- redis-cli EXISTS "config:bundle:$DIGEST"
# => 1
```

### 2c. Re-promotion is free

```bash
HOME=$SANDBOX pnpm --dir harness promote --entry ship-note --project $SANDBOX | tail -3
```

```
  bundle     sha256:46ee1106…  (12288 bytes, unchanged — upload skipped)
```

> Same digest, no upload. The bundle is content-addressed over a **canonical** tar — sorted paths,
> normalised mtimes and modes — so re-promoting unchanged configuration is a no-op, and the digest
> does not even depend on which directory you authored in.

---

## Act 3: The same prompt, one field apart

Both dispatches are byte-identical but for `configRef`. Same cluster, same model, same prompt.

### 3a. Purge the shared cache first, or your control is not a control

**Do not skip this on a warm cluster.** The overlay materialises the bundle into a digest-keyed
cache inside the **shared pool sandbox** and leaves it there for reuse. It is world-readable, it
contains `context/agents/0-CLAUDE.md` and `memory/`, and it **outlives the leaf**:

```bash
kubectl exec -n $NS sandbox-0 -- find /workspace/.sh-config -type f | sed 's|.*/sha256-[0-9a-f]*/||'
# context/MEMORY.md
# context/agents/0-CLAUDE.md
# memory/auth-timeout-incident.md
# skills/ship-note/SKILL.md
# skills/ship-note/references/release-token.md
```

> **This bit the author, so it will bite you.** On the second run of this demo the _bare_ arm
> answered `TICKET: KAG-4471 / TOKEN: SHIPNOTE-7F3A-SANDBOX-OK` and opened with "following the house
> rules" — having been told none of it. A bare leaf that leases a sandbox where a previous promoted
> leaf ran can simply _explore the filesystem_ and answer from someone else's promoted workflow.
> The A/B still looked plausible; it had just stopped proving anything.

```bash
for p in $(kubectl get pods -n $NS -l 'sh.kagenti.io/sandbox-pool=default' -o name | sed 's|pod/||'); do
  kubectl exec -n $NS "$p" -- rm -rf "/workspace/.sh-config/sha256-${DIGEST#sha256:}"
done
```

### 3b. Run A — bare

```bash
curl -s -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$MODEL" '{sessionId:"demo-bare-1", kind:"prompt", model:$m,
        prompt:"Write the ship note for the auth timeout fix."}')" \
  $BASE/runs | jq -r .text
```

```
The workspace appears to be empty. Could you provide me with:

1. **Where is the code/project?** …
3. **Format for the ship note:**
   - Is there an existing SHIP_NOTES, CHANGELOG, or similar file I should follow?
```

> It does not know what a ship note is here, has no incident to cite, and asks you. This is the
> harness's normal behaviour, unchanged — which is the back-compat guarantee, stated as output.

### 3c. Run B — the same prompt, plus the digest

```bash
curl -s -H "$HOSTHDR" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg m "$MODEL" --arg c "$DIGEST" '{sessionId:"demo-promoted-1", kind:"prompt", model:$m,
        prompt:"Write the ship note for the auth timeout fix.", configRef:$c}')" \
  $BASE/runs | jq -r .text
```

```
SHIP NOTE · auth-idle-reaper-fix
WHAT:   Fixed sessions disconnecting after 30 seconds of inactivity
WHY:    The idle reaper was measuring time since connection open instead of last activity
TICKET: KAG-4471
RISK:   low — fix is reversible behind auth.idle_reaper_v2 feature flag
TOKEN:  SHIPNOTE-7F3A-SANDBOX-OK
```

> **Pause here and read the four lines back one at a time.** Each one is a different channel
> arriving, and each is separately checkable:
>
> - **The format** came from the skill. Pi puts only a skill's _name and description_ in the system
>   prompt and tells the model to `read` the body when it matches — and that read runs in the
>   **sandbox pod**.
> - **`TICKET: KAG-4471`** came from your memory directory. The model cannot guess it; Run A
>   demonstrably did not produce it. Memory travels **read-only**
>   ([ADR-0031](../adrs/0031-promoted-memory-read-only.md)), so a promoted run consumes what you
>   taught it and stays replayable.
> - **`RISK:`** came from `CLAUDE.md`, injected as an agents file — the deterministic channel.
> - **`TOKEN:`** is the load-bearing one. It lives in `references/release-token.md` _inside_ the
>   skill's own directory. Producing it means the bundle materialised on the **sandbox** side of the
>   fs-free split **and** a relative sibling path resolved against the absolute skills root the leaf
>   injects. The skill even says "if you cannot read that file, write `TOKEN: unavailable`", so a
>   failed read shows up as an honest gap instead of a hallucinated token.

### 3d. Prove the sandbox half on the filesystem, not in the model's prose

The `TOKEN:` line is the model _telling_ you it read the file. Now check the claim directly — this
holds even on a run where the model declines to read:

```bash
kubectl exec -n $NS sandbox-0 -- \
  cat "/workspace/.sh-config/sha256-${DIGEST#sha256:}/skills/ship-note/references/release-token.md"
# => SHIPNOTE-7F3A-SANDBOX-OK
```

> You purged this path in 3a and dispatched nothing but a digest. It is back, `references/` and all,
> because the overlay put it there under `flock` and made it read-only with `chmod -R a-w` — which
> is how [ADR-0031](../adrs/0031-promoted-memory-read-only.md)'s read-only guarantee is enforced by
> the filesystem rather than by convention.

### 3e. Status is durable, not just a response body

```bash
curl -s -H "$HOSTHDR" "$BASE/runs/status?sessionId=demo-promoted-1" | jq -c '{status, reason}'
# => {"status":"responded","reason":null}
```

> The verdict is persisted under the session id, so a re-dispatch of the same id resumes rather than
> re-pays, and a fan-out driver can collect results after the fact. This is the existing leaf
> idempotency contract; promotion did not change it.

---

## What just happened

You moved a workflow off your laptop without writing a manifest:

1. **Authored small** — one skill, a `CLAUDE.md`, one memory file, one slash command, in a
   throwaway sandbox. `HOME=$SANDBOX` made it its own user scope: **1 skill, 12 KB, zero preflight
   findings**, against 56 skills and ~8.6 MB for a real `~/.claude` (Act 1, 2a).
2. **Promoted with one command** — content-addressed over a canonical tar, so the second promotion
   uploaded nothing and the digest was identical (Act 2a, 2c).
3. **Dispatched with one field** — `configRef` on the existing prompt envelope. No new endpoint, no
   redeploy, no image rebuild (Act 3c).
4. **Proved all three channels arrived** — the skill's format, the `CLAUDE.md` rule, and an
   incident id that exists only in your memory directory, with a bare run standing next to it as a
   control you made honest by purging the shared cache first (Act 3a, 3b, 3c).
5. **Proved the sandbox half twice** — once in the model's words (a token readable only by a `read`
   executed in the separate sandbox pod, through a path the leaf translated) and once on the
   filesystem, which does not depend on the model cooperating (Act 3c, 3d).
6. **Kept the old contract** — the bare run behaved exactly as the harness always did, and
   `/runs/status` replayed the verdict (Act 3b, 3e).

To replay all of it non-interactively with every claim asserted:

```bash
make demo-promoted-workflow
```

---

# Cleanup

```bash
make demo-promoted-workflow-teardown        # removes the sandbox (refuses any dir it did not create)
pkill -f 'kubectl port-forward -n kourier-system svc/kourier'
pkill -f 'kubectl port-forward -n default svc/redis'
```

The bundle stays in Redis under a 30-day TTL. It is immutable and content-addressed, so leaving it
costs 12 KB and makes the next run of this demo skip the upload. To drop it:

```bash
kubectl exec -n $NS deploy/redis -- redis-cli DEL "config:bundle:$DIGEST"
```

---

# Notes and limits

- **The `TOKEN:` line is the one model-dependent claim.** The format and the token both require the
  model to choose to `read` the skill body. `CLAUDE.md` says it MUST, and the deterministic channel
  carries that instruction, so it is reliable in practice — but it is not a mechanical guarantee the
  way `TICKET:` is. If it ever comes back `unavailable`, that is the skill being honest, not the
  overlay silently failing.
- **The shared config cache is visible to other leaves, and that is worth saying out loud.** The
  digest-keyed directory in the pool sandbox is what makes reuse cheap, and the overlay makes it
  read-only — but read-only is not invisible. Any leaf leasing that sandbox can read another
  workflow's promoted `CLAUDE.md` and `memory/`, with or without a `configRef` of its own. Act 3a
  works around it for the demo's sake; on a pool shared between tenants it is a confidentiality
  question, not a demo detail, and ADR-0031 speaks to write-protection rather than to visibility.
- **This demo does not show MCP servers or subagents.** Both are explicitly out of scope for
  promotion (spec §2, §9). Do not let a room infer that a promoted workflow carries its MCP config.
- **Memory is read-only in the promoted run.** The remote agent cannot write back what it learns;
  discoveries surface in the leaf result instead. That is deliberate
  ([ADR-0031](../adrs/0031-promoted-memory-read-only.md)) and it is what keeps leaf replay
  reproducible.
- **`promote` reads slash commands from user scope only.** A project-scope `.claude/commands/` file
  does not travel unless `HOME` points at that project — which the sandbox pattern does anyway, but
  it will surprise someone promoting a real repo.
- **Preflight blocks on facts and warns on heuristics.** The secret scan refuses the upload only on
  structural credential formats (AWS key ids, PEM blocks, GitHub/Slack/OpenAI tokens); prose-shaped
  matches warn. Do not promise that promotion cannot leak a pasted password — it can, and it warns.
  A curated sandbox like this one yields zero findings, which is the state in which blocking
  preflight would become safe to restore (spec §6 D10, §11).
- **`--dry-run` shows you the bundle without uploading it**, which is the safe way to inspect what a
  real `~/.claude` would ship before you ship it.

[spec §11]: ../specs/2026-09-02-claude-code-workflow-promotion-design.md

Reference: [`../../deploy/knative/demo-promoted-workflow.sh`](../../deploy/knative/demo-promoted-workflow.sh),
[ADR-0030](../adrs/0030-claude-code-workflow-promotion.md),
[ADR-0031](../adrs/0031-promoted-memory-read-only.md).
