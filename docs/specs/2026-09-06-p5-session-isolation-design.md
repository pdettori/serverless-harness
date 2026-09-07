# Multi-Session Harness Isolation — Per-Request Subject, No Ambient Credential — Design

Version: 1.0 — September 6, 2026
Status: Proposed
Scope: Make **N concurrent Pi sessions in one harness process** provably isolated, by carrying the
LLM identity **per request** and removing every ambient (process-global) credential source that a
second session could inherit. Realizes the concurrency-safety half of
[issue #220](https://github.com/rossoctl/serverless-harness/issues/220).
Builds on (reuse, no redesign): the harness lock-down's secret-free container
([Z2](2026-06-26-harness-lockdown-design.md), [ADR-0011](../adrs/0011-harness-lockdown.md)), the
inference injector's "harness holds no provider key"
([Z3](2026-06-26-inference-injector-design.md), [ADR-0012](../adrs/0012-inference-injector.md)),
RC1's `static-inject` placeholder swap
([RC1](2026-07-10-authbridge-egress-control-plane-poc-design.md),
[ADR-0026](../adrs/0026-rc1-static-inject-plugin.md)), and Pi's **already per-session** request-auth
path (`AgentSession._getRequiredRequestAuth` → per-instance `ModelRegistry`).

> **What this slice is NOT.** Not the deployment-model change — KEDA `ScaledJob` → elastic pod pool,
> the 100× density claim, and the #55 overload-handling shift from pod-level to session-level are a
> **separate slice** and a separate issue. Not end-to-end multi-tenancy: that additionally needs
> **per-subject resolution at the injector**, which is Z5's deferred per-user / RFC 8693 half
> ([ADR-0026](../adrs/0026-rc1-static-inject-plugin.md) "only the Z5 per-user / token-exchange source
> … remains") and lives in `kagenti-extensions`, not here. Not a `SessionContext` threaded through
> `pi-fork` — §4 explains why four of the issue's five items are pinned rather than refactored. Not a
> change to the leaf `ScaledJob` path, which is one pod per leaf and stays ambient by design.

---

## 1. Goal & motivation

The harness runs one session per process. Each session idles 80–90% of wall-clock waiting on the
model and on tool calls, yet owns a whole pod, so 10,000 concurrent sessions means 10,000 pods.
Issue #220 proposes multiplexing N sessions per process and identifies five process-global mutable
states as the blockers.

**The five-blocker framing does not survive tracing the code.** One is real, one is unreachable, one
is largely false, and two are low-severity — while the actual prerequisite for multi-tenant
multiplexing is something the issue never mentions: _no per-session credential ever enters the
harness at all_. §2 records what the code does, with citations, because the issue's own severity
table was written from reading rather than tracing, and this spec's value is the corrected map.

The goal of this slice is a single enforceable property:

> **A request's upstream identity is determined solely by that request, and no identity is reachable
> from process-global state.**

Both clauses are load-bearing. The first alone is unenforceable: while an ambient credential exists,
"we passed the right one" is a behaviour we hope holds, not a fact the process guarantees. The
second clause turns it into a precondition the process cannot violate — a credential-less session
**fails closed** instead of silently borrowing its neighbour's identity.

## 2. Current state — verified, with citations

Every claim here was traced in the tree at `f78081f`, not inferred from the issue.

### 2.1 The issue's severity table, corrected

| #                               | Issue says                                                             | Code says                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. `ANTHROPIC_API_KEY` mutation | Showstopper — "sessions with different auth tokens corrupt each other" | **Real, and different in kind.** `run-turn.ts:310-312` is write-once-**if-absent**, so session A's token sticks process-wide and B..N silently authenticate **as A**. A cross-tenant identity leak, not mutual corruption — the two framings imply different fixes.      |
| 2. `stdoutTakeoverState`        | Showstopper                                                            | **Unreachable in server mode.** `takeOverStdout()` is called only from `main.ts:511` (CLI) and `rpc-mode.ts:54`; the harness enters Pi via `createAgentSession` (`run-turn.ts:1-8`).                                                                                     |
| 3. `sessionResourceCleanups`    | Showstopper — "cleanup for A tears down B"                             | **Largely false.** The sole registrant repo-wide (`openai-codex-responses.ts:786`) already filters by session: `closeOpenAICodexWebSocketSessions(sessionId)` closes only that session's cached socket (`:769-784`), and `agent-session.ts:733` passes `this.sessionId`. |
| 4. `fileMutationQueues`         | Race — "sessions serialize through same promise chain"                 | **Wrong mechanism.** The map is keyed by `realpath` (`file-mutation-queue.ts:16-26, :35`), so different files already run in parallel. The only true global is `registrationQueue` (`:5`), which serializes one `realpath()` call — throughput, not correctness.         |
| 5. `commandResultCache`         | Stale data                                                             | **Low.** Only caches values beginning with `!` (`resolve-config-value.ts:81-86, :211-219`). The harness supplies credentials as config/env, never as `!cmd`.                                                                                                             |

### 2.2 Pi is already per-session on the credential path

This is the finding that shapes the design. Pi does **not** rely on ambient credentials:

- `AgentSession` resolves auth **per request** via `_getRequiredRequestAuth` (`agent-session.ts:357-381`),
  which reads from `this._modelRegistry` — a **per-instance** field (`:353-355`).
- The resolved `apiKey` is passed **explicitly** into stream options (`agent-session.ts:1705`, `:1978`, `:2791`).
- `withEnvApiKey` (`stream.ts:22-30`) consults the environment **only when no explicit key was
  given**: `if (hasExplicitApiKey(options?.apiKey)) return options;` at `:26`, before
  `getEnvApiKey(model.provider)` at `:27`.

So the env var is a _fallback beneath an already-per-session mechanism_. The harness's seed at
`run-turn.ts:310-312` is precisely what activates that fallback and defeats the isolation Pi already
provides. **Nothing in `pi-fork` needs to change for the credential path.**

### 2.3 The gap the issue never names: no per-session identity inflow

Every caller fills the credential from process env:

- `packages/knative-server/src/server.ts:66-73` — `buildConfig()` takes no arguments and reads
  `process.env.ANTHROPIC_AUTH_TOKEN` (`:71`), `ANTHROPIC_BASE_URL` (`:70`), and `cwd` (`:69`).
  Called at `:111` (sync turn), `:174` (async dispatch), `:411`/`:415` (leaf).
- `packages/knative-server/src/leaf-job.ts:13-18`, used at `:77`.
- `harness/src/cli.ts:13`.

`TurnConfig.anthropicAuthToken` exists as a field (`run-turn.ts:64`) but no caller ever populates it
from a request. **The pod's environment _is_ the credential, one per deployment.** Consequently,
deleting the env seed alone would not fix a leak — it would leave every session with no credential
at all. The ordering in §3.2 follows from this.

A `tenant` concept does already exist, partially: `run-leaf.ts:111` (`tenant?: string` — "namespaces
the session id"), `leafSessionId` at `:157-160`, and `server.ts:442` reads `tenant` as a query
parameter on the leaf-result path. The turn path has no equivalent.

### 2.4 The architecture already forbids the obvious fix

Passing a real credential to the harness per request contradicts three accepted ADRs:

- **[ADR-0011](../adrs/0011-harness-lockdown.md)** — the harness holds no provider key and has no
  public egress, so its default-deny boundary is enforceable.
- **[ADR-0012](../adrs/0012-inference-injector.md)** — a separate injector pod holds the keys,
  strips client auth, sets the real credential, and is the only component with public egress.
- **[ADR-0026](../adrs/0026-rc1-static-inject-plugin.md)** — the `static-inject` AuthBridge plugin
  rewrites `Authorization: Bearer <placeholder>` → `Bearer <real>` from a mounted `secret_dir`,
  fail-closed. Its **rejected** alternative #3 is literally "bake the credential into the workload
  env — defeats the entire 'workload never holds the secret' invariant."

So the harness must carry an **inert placeholder plus a subject**, never a secret. That invariant is
today **documented prose with nothing pinning it** — the same failure mode that let #182's spec
entry go stale for two months.

## 3. Design

### 3.1 The isolation contract

Three statements, each testable:

1. **Per-request identity.** Every upstream request's `Authorization` header derives from the
   subject on the inbound request, and from nothing else.
2. **No ambient identity.** In server mode the process holds no provider credential and no
   tenant-bearing placeholder. The only ambient value is an inert sentinel identical for every
   tenant (§3.3), so `withEnvApiKey`'s fallback (`stream.ts:27`) can never resolve to anyone's
   identity.
3. **Fail closed, twice.** A request with no subject is rejected before a session is created. A
   subject with no placeholder resolution makes **no upstream request at all**.

### 3.2 Three ordered steps (the order is forced by §2.3)

**Step 1 — per-request subject inflow.** `buildConfig()` becomes `buildConfig(req)` in
`packages/knative-server/src/server.ts`, reading the subject from the inbound request and deriving
the per-request placeholder from it. The turn path gains what the leaf path already has (§2.3).

Subject transport: a dedicated header, **`X-SH-Subject`**, not `Authorization`. `Authorization` is
unused on inbound requests today (the server consumes no auth header), but its meaning there is "may
this caller use the harness" — and ADR-0011's lock-down implies caller auth is coming. Overloading
one header with _authorize the caller_ and _whose budget to spend upstream_ collides exactly when
that lands. The subject is also **not** taken from the request body: the body is parsed, logged, and
persisted, and identity should not ride in a field that gets written to Redis.

Placeholder derivation is a **pure, non-secret mapping** from subject → placeholder, from mounted
non-secret configuration. It contains no credentials, so it may be logged and asserted on in tests.

**Step 2 — remove the ambient fallbacks.** In `harness/src/run-turn.ts::applyModelGateway`, delete
the `process.env.ANTHROPIC_API_KEY` seed (`:310-312`) and the `|| process.env.ANTHROPIC_AUTH_TOKEN`
fallback (`:306`). The signature does not change — only what it trusts. **Only safe after step 1**,
which is the whole reason for the ordering.

**Step 3 — scrub at the server entrypoint.** At server startup, **replace** `ANTHROPIC_API_KEY` with
an inert sentinel and **delete** `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` (the first two
are the names `getApiKeyEnvVars` returns for the `anthropic` provider, `env-api-keys.ts:96-99`).

The scrub belongs at the **server entrypoint only** — not in `run-turn`, not in `leaf-job`. This is
what keeps the leaf path working: a leaf `ScaledJob` is one pod per leaf, so ambient env is correct
there and multiplexing never applies. Scrubbing inside `run-turn` would break leaf mode, since both
paths share it.

### 3.3 Why the sentinel, and why it is not a hole

`ANTHROPIC_API_KEY` **cannot simply be deleted.** `run-turn.ts:150-155` documents why, and it is
load-bearing: pi resolves the request key **by provider name**, so
`authStorage.getApiKey('anthropic')` → `getEnvApiKey('anthropic')` → `process.env.ANTHROPIC_API_KEY`.
With it absent, `_getRequiredRequestAuth` (`agent-session.ts:357-381`) throws
`No API key found for "anthropic"` before any request is attempted — and `createAgentSession`
(`run-turn.ts:499-504`) exposes **no** seam to pass a per-session key into the session's
`ModelRegistry`. Deleting the variable would therefore break gateway mode outright.

So server mode sets `ANTHROPIC_API_KEY` to a **fixed, non-secret sentinel** (e.g.
`sh-unused-see-authorization-header`), which satisfies pi's existence check while the real identity
travels in the per-request `Authorization: Bearer <placeholder>` header that `applyModelGateway`
installs on the model. This is safe rather than a workaround, for three reasons:

1. The sentinel is **identical for every tenant**, so it asserts no identity and cannot leak one.
   Clause 2 of §3.1 is about _identity_, and the sentinel carries none.
2. It never reaches the wire as auth: `applyModelGateway` sets `'x-api-key': null` (`run-turn.ts:337`)
   whenever a gateway token is in play, so the sentinel is stripped, not sent.
3. It is **assertable**: a test can require that the ambient key equals the sentinel exactly, which
   fails loudly if a real credential or a tenant placeholder is ever reintroduced into the
   environment. Deletion cannot be asserted this precisely — an absent variable and a variable
   deleted-then-repopulated look identical.

The alternative — a `pi-fork` seam threading a per-session `apiKey` into `ModelRegistry` — is the
only way to remove the ambient value entirely. It is deliberately **not** taken here: it reopens the
fork divergence this design avoids, for a value that carries no identity. If a future change needs
per-session _provider_ selection (not just per-session identity), that seam becomes worth adding, and
this is the place to revisit.

### 3.4 Why an ambient _placeholder_ is as dangerous as an ambient key

Under lock-down the harness never holds a secret, so it is tempting to treat placeholder leakage as
cosmetic. It is not. A placeholder is an identity assertion: if session B inherits tenant A's
placeholder, the injector faithfully swaps in **A's real credential**. The result is A's budget
spent on B's work, A's data scope granted to B's session, and an injector audit trail that records
the request as legitimately A's — so the one mechanism that would otherwise catch the error instead
certifies it. Placeholder isolation is therefore in scope, at the same strictness as key isolation.

### 3.5 Deliberate YAGNI

- **`anthropicBaseUrl` stays deployment-level.** The gateway is infrastructure, not tenant identity.
  Extension point noted: a tenant needing its own gateway makes base URL subject-derived too.
- **The non-turn `buildConfig()` call sites keep ambient config** (`server.ts:174`, `:411`, `:415`;
  `leaf-job.ts:77`) until the deployment model changes. They are on the 1:1 path today.
- **`registrationQueue` is left alone** (§4).

## 4. The other four globals — pinned, not refactored

The principle: **an inert global should be proven inert and left alone.** Refactoring it raises
`pi-fork` divergence to fix nothing, while a reachability test catches the thing actually feared —
that it quietly becomes reachable later.

| Global                                               | Disposition                          | Pinned by                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `stdoutTakeoverState` (`output-guard.ts:7`)          | Unreachable in server mode           | `isStdoutTakenOver()` stays false across a server turn                                                                        |
| `sessionResourceCleanups` (`session-resources.ts:3`) | Already session-scoped               | Cleaning up A leaves B's resources intact; the no-arg `cleanupSessionResources()` form is never reached from the harness path |
| `fileMutationQueues` (`file-mutation-queue.ts:4`)    | Left alone deliberately              | Documented, not changed — keyed by `realpath`, so the residual global is one serialized `realpath()`                          |
| `commandResultCache` (`resolve-config-value.ts:10`)  | Unreachable with harness config      | No harness config value begins with `!`                                                                                       |
| `cwd` (`server.ts:69`)                               | **Not in the issue**; must be pinned | No session-scoped file operation resolves against `process.cwd()`                                                             |

Two notes on this table:

**`output-guard` hides a worse hazard than the one the issue lists.** `writeRawStdout`'s failure
path calls `process.exit(1)` (`output-guard.ts:91`). In a CLI that is a reasonable response to an
unwritable stdout; in a multiplexed server it is a **fleet-wide outage triggered by one session's
write error**. Pinning the module unreachable covers both, and is a further argument against ever
routing server output through it.

**`cwd` is the one item that could change this slice's verdict.** It is process-wide, so if any
session-scoped file operation resolves against `process.cwd()`, that is a genuine second blocker and
the scope grows. Under FS-free two-tier (P1) file operations go to the sandbox, so it is expected to
be inert — but expected is not proven, and a failure here must upgrade scope rather than be papered
over.

## 5. Testing & verification gate

The load-bearing test is a **two-tenant interleaved turn test that fails on `main` today**: two
sessions with different subjects, turns interleaved, against a stub upstream that records the
`Authorization` header of each request; assert each request carried its own subject's placeholder and
never its neighbour's. It fails today for the most basic reason available — no per-request subject
exists at all (§2.3).

**Interleaving must happen at `await` boundaries, not sequentially.** Node is single-threaded, so
the hazard shape is precisely "a global mutated between two awaits". A sequential two-session test
would pass while the bug remained, which makes it worse than no test.

| Test                          | Asserts                                                                                                                         | Fails today because                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Two-tenant interleaved turns  | Each upstream request carries its own subject's placeholder                                                                     | No per-request subject exists        |
| Fail-closed: no subject       | 401 before a session is created, **and no upstream request made**                                                               | Ambient env silently supplies one    |
| Ambient-absence               | With a real tenant token in `ANTHROPIC_API_KEY` before startup, a subject-less session still fails rather than borrowing it     | This is the leak (`run-turn.ts:310`) |
| Sentinel identity (§3.3)      | After startup `ANTHROPIC_API_KEY` equals the sentinel **exactly**, and is byte-identical across two differently-subjected turns | No scrub exists                      |
| Lock-down invariant           | No real provider credential is reachable from the harness process in server mode                                                | Unpinned prose today (§2.4)          |
| Four reachability guards (§4) | Each inert global stays inert                                                                                                   | New guards                           |

Homes: `harness/test` and `packages/knative-server/test` — both typechecked since #190, which is the
gate that made this work sequenceable (threading per-session identity is exactly the change whose
test fakes need compiler checking).

The ambient-absence test deserves emphasis: it is the only test that would have caught the original
defect, and it must set the env var _deliberately_ and assert failure anyway. A test that merely
omits the env var proves nothing.

## 6. Scope / YAGNI — explicitly NOT building

- **The deployment model.** `ScaledJob` → elastic pod pool, the pod-count and activation-latency
  numbers, and #55's overload shift from pod-level to session-level. Separate slice, separate issue;
  this one is its prerequisite.
- **The injector's per-subject half.** Z5's per-user / RFC 8693 token-exchange source replacing
  `static_inject`'s static `secret_dir`. Different repo (`kagenti-extensions`), deferred plane
  (`specs/README.md:152`).
- **`SessionContext` threaded through `pi-fork`.** §2.2 and §4: the credential path is already
  per-session, and the other globals are inert. Four `pi-fork` refactors would add divergence and
  fix nothing.
- **Caller authentication.** `X-SH-Subject` states _who the work is for_, not _who may ask_. Caller
  auth is ADR-0011's lock-down work; §3.2 keeps `Authorization` free for it.
- **Per-tenant sandbox or data isolation.** Untouched here.

## 7. Dependencies & what #220 may claim

**Deliverable now, without Z5:** everything in §3 and §5. The harness becomes tenancy-_neutral_ —
it carries a per-request subject and holds no ambient identity — so enabling mixed tenancy later is
an injector configuration change rather than a harness rewrite.

**Not claimable until Z5's per-user half lands:** end-to-end multi-tenant safety. Today
`static-inject` resolves by destination host or a static key (ADR-0026), i.e. one credential per
deployment. The harness half is the **strict prerequisite** — the injector cannot key on a subject
the harness never sends — so this slice unblocks that work and must not advertise more.

`#220` should therefore be split: this slice, the deployment-model slice, and the injector
dependency tracked against Z5. Its severity table needs the §2.1 corrections before anyone scopes
from it.

## 8. Implementation notes for a fresh session

Verified mechanics, so a clean session does not rediscover them.

**Files this slice touches.** `packages/knative-server/src/server.ts` (`buildConfig` → request-scoped,
subject header parsing, startup scrub, 401 path), `harness/src/run-turn.ts` (`applyModelGateway`
:306, :310-312), plus new tests in `harness/test` and `packages/knative-server/test`. **No
`pi-fork` changes.** `harness/src/cli.ts:13` and `packages/knative-server/src/leaf-job.ts:13-18`
stay ambient on purpose (§3.2 step 3).

**Worktree setup.** `link:` deps resolve inside the worktree, so a fresh one needs, in order:
`git submodule update --init --recursive`, then `cd pi-fork && npm ci && npm run build`, then
`pnpm install` at the root. Skipping the `pi-fork` build fails typecheck with missing declarations.

**Tests need Redis** — the `sh-test-redis` container on `:6379`. ~10 `ECONNREFUSED` failures across
4 files means it is stopped, not a regression.

**Commands.** `make typecheck` is `pnpm -r typecheck` across 9 packages; a new package fails
`harness/test/typecheck-coverage.test.ts` until it has a `tsconfig.json` with `test` in its include
and a `typecheck` script. `make lint` runs pre-commit over all files and **skips untracked files** —
stage new files first or it may lint nothing.

**Commits.** `git commit -s` (DCO enforced in CI) and `Assisted-By: Claude (Anthropic AI)
<noreply@anthropic.com>`.

## 9. References

- Issue [#220](https://github.com/rossoctl/serverless-harness/issues/220) — multi-session
  multiplexing (this slice realizes its concurrency-safety half; see §2.1 for corrections to its
  severity table).
- [ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md) — the decision this spec records.
- [ADR-0011](../adrs/0011-harness-lockdown.md) · [Z2](2026-06-26-harness-lockdown-design.md) — secret-free harness.
- [ADR-0012](../adrs/0012-inference-injector.md) · [Z3](2026-06-26-inference-injector-design.md) — injector holds the keys.
- [ADR-0025](../adrs/0025-authbridge-deployment-topology.md) · [ADR-0026](../adrs/0026-rc1-static-inject-plugin.md) · [RC1](2026-07-10-authbridge-egress-control-plane-poc-design.md) — placeholder swap, fail-closed.
- [ADR-0006](../adrs/0006-generalized-credentialed-egress.md) — `(subject ⊕ destination)` → credential resolution.
- [Z5](2026-06-19-m13-generalized-credentialed-egress-design.md) — home of the deferred per-user work.
- Epic [#49](https://github.com/rossoctl/serverless-harness/issues/49) · [P1](2026-07-02-p1-fs-free-harness-design.md) — the two-tier split this assumes.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
