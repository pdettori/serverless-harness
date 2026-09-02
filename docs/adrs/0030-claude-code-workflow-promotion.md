# ADR-0030: Promote local Claude Code workflows as a content-addressed config bundle

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-09-02
- **Deciders:** Serverless Harness team
- **Spec:** [`../specs/2026-09-02-claude-code-workflow-promotion-design.md`](../specs/2026-09-02-claude-code-workflow-promotion-design.md)

## Context

The harness runs Pi sessions well but is hard to author for: putting a useful workflow on it
means hand-assembling a prompt and hoping the runtime has what the prompt assumes. The same
person usually _already_ has that workflow working on their laptop in Claude Code — skills they
trust, a `CLAUDE.md`, accumulated memory, a slash command tying it together — and none of it
carries across.

Two findings make a promotion path tractable. Pi already speaks most of Claude Code's
configuration vocabulary: `core/skills.ts` implements the **Agent Skills standard** (`SKILL.md`
with `name`/`description` frontmatter and the same directory-discovery rules), and
`loadProjectContextFiles` (`resource-loader.ts:62`) already looks for `CLAUDE.md` beside
`AGENTS.md`. Pi's built-ins (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) are
near-isomorphic to Claude Code's. And the harness deliberately uses none of it:
`harness/src/run-turn.ts:463` builds `DefaultResourceLoader` with only
`{ cwd, agentDir, settingsManager, extensionFactories }`, `cwd` being the harness pod's own
directory. The gap is delivery and wiring, not capability.

The constraint is the fs-free split ([ADR-0020](0020-fs-free-harness.md)): the harness mounts no
shared writable volume — only an emptyDir `/tmp` — and tool calls execute in a _separate_ sandbox
pod, drawn from a shared pool ([ADR-0021](0021-shared-sandbox-pool.md)). A skill therefore
splits in two. Its prose must be readable by the **harness** process, because it feeds the
system prompt; anything it executes must exist in the **sandbox**. The halves travel differently
and must not drift apart. A measured laptop holds ~62 MB under `~/.claude` across 149 `SKILL.md`
files, of which ~11 MB is markdown and much is `cache/` duplicating `marketplaces/`.

## Decision

We will promote a local Claude Code workflow as a **content-addressed configuration bundle**,
uploaded once and referenced by a single new optional envelope field `configRef: sha256:…`. A
local `sh promote` CLI (with a thin Claude Code slash-command wrapper) resolves user and project
scope, dedupes, prunes, scans for secrets, uploads, and emits a **generated lockfile** — never a
hand-authored manifest.

Pruning is **by compatibility, never by relevance**: everything that can work travels, and only
what provably cannot is dropped, each with a machine-readable reason. The classifier has two
buckets and is a _curated_ deny-list plus narrow checks, not an inference engine. Tool-name drift
is handled by an injected `appendSystemPrompt` mapping note; skill prose is never rewritten.

Materialization follows the fs-free split from one digest. Skills and prompts unpack into the
harness pod's `/tmp/sh-config/<digest>/` and are wired through `additionalSkillPaths` /
`additionalPromptTemplatePaths`, with `noContextFiles: true` and context supplied via
`agentsFilesOverride`. Executable content overlays into the sandbox via the transport
`converge.ts` already uses, cached shared at `/workspace/.sh-config/<digest>/` under converge's
flock discipline and bound per-leaf. The sandbox exports `SH_SKILLS_DIR` and an injected note
states it, so relative paths inside skill instructions resolve. Absent `configRef`, harness
behavior is unchanged.

### Alternatives considered

- **Git-native profile ref, converged like a workspace** — cheapest to build and a commit SHA is a free digest, but scale-to-zero means every cold start pays a `git clone` against a sub-second target. Its audit property is stolen cheaply by committing the lockfile instead.
- **OCI artifact for everything** — right currency for binaries and free signing/scanning, but push-and-pull per promotion is hostile to the tweak-and-re-promote loop, and the harness pod would need its own pull client. Additive later, not a rival.
- **Mirror `~/.claude` wholesale, unpruned** — no meaningful preflight, and skills that provably cannot work would misfire remotely.
- **Session-derived manifest** — buys a smaller bundle by reintroducing omission, losing exactly the skills a _future_ run needs. Rejected once payload size was measured as single-digit MB.
- **Rewriting tool names across skill files** — a regex deciding whether "Read" is a tool reference or English will mangle prose, and the damage surfaces as a skill misbehaving remotely.

## Consequences

- Positive: promotion is one command with no manifest to maintain, and re-promotion of unchanged configuration uploads nothing because the digest is computed locally. The feature is opt-in by construction — an absent `configRef` leaves every existing path byte-identical. One digest covers both halves, so prose and scripts cannot drift. The resolver is pure with respect to the digest, so a promoted leaf stays replayable and the idempotency contract at `run-leaf.ts:67` survives. Existing machinery carries most of the weight: Pi's resource loader, `converge.ts`'s transport and flock discipline, and `packages/session-backend`.
- Negative / accepted cost: the deny-list is **curated**, so it rots — a new local skill family that cannot work remotely misfires until the list catches up. We accepted that over heuristic inference, because grepping for `Agent` false-positives on nearly every superpowers skill and a wrongly-dropped skill fails remotely and confusingly. Preflight cannot catch a whole tier of failures (binary present at a wrong version, missing credentials, denied egress, prose assuming absent host behavior), and it must state those edges rather than imply completeness. A blob store in Redis wants TTLs and size caps and is an object store's job if bundles grow. `noContextFiles: true` is load-bearing in a way that is invisible when wrong: without it, this repository's own `CLAUDE.md` leaks into every promoted session as if it were the user's. Cold start now has a fetch-and-unpack step on the critical path.
- Follow-up owed: CI must assert the checked-in sandbox binary inventory matches the image it describes, or preflight starts lying. Cold-start delta must be measured into `deploy/knative/EXPERIMENTS.md` against the README's sub-second claim, not assumed. Subagent support needs its own spec (Pi has no Task equivalent; `createAgentSession` is exported but budget roll-up, checkpoint interaction, and a depth cap are net-new). MCP promotion remains out of scope, deferred to the code-mode path ([ADR-0005](0005-mcp-code-mode.md)). Interaction-dependent skills warn under `--mode unattended` today; mapping them onto real human gates ([ADR-0016](0016-human-gate.md)) is a possible future.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
