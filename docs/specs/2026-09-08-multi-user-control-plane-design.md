# MU1 — Multi-User Control Plane: authenticated API, owned sessions, per-user credentials

Version: 1.0 — September 8, 2026
Status: Proposed
Scope: Turn the harness from a single-tenant deployment into a **multi-user service**. Introduces an
always-on **control plane** that owns the authenticated API surface (`/v1`), the session-ownership
index, and a per-user credential store; and makes the data plane carry a **per-request subject**
instead of an ambient deployment credential.
Milestone: **MU1**, first entry in the new **`MU` (multi-user service)** track — not a Phase-2 `Z` id,
because Phase 2 is a security architecture and this is a product surface. Source of truth for
numbering: [Milestone Registry](README.md).
Builds on (reuse, no redesign): [Z1](2026-06-26-identity-spine-design.md) trust tiers and the
`CredentialInjector` shape; [Z2](2026-06-26-harness-lockdown-design.md) secret-free container;
[Z3](2026-06-26-inference-injector-design.md) "the harness holds no provider key";
[Z5](2026-06-19-m13-generalized-credentialed-egress-design.md) per-user egress;
[RC1](2026-07-10-authbridge-egress-control-plane-poc-design.md) placeholder swap.
Composes with: **P5** multi-session isolation ([`2026-09-06-p5-session-isolation-design.md`](2026-09-06-p5-session-isolation-design.md),
[ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md)) — **design merged** in
[#228](https://github.com/rossoctl/serverless-harness/pull/228), implementation on a separate
contributor's track. P5 reserved `Authorization` for caller auth, which is exactly this spec; §3.5
sets the split and what MU1 does if P5 has not yet landed.
Decision record: [ADR-0033](../adrs/0033-multi-user-control-plane.md).

> **The one-sentence thesis.** Multi-user reduces to one property — _a request's upstream identity is
> determined solely by that request_ — and the cheapest way to make that property enforceable rather
> than hoped-for is to move both the identity and the credential out of the model-influenced pod and
> into a trusted tier that hands them back per turn.

---

## 1. Goal & scope

### Goal

Let many users share one deployment such that each can authenticate, hold their own credentials, run
sessions on their own identity, and see and delete only their own work — with the isolation resting
on properties the process cannot violate rather than on care.

### In scope

- The **control-plane tier**: an always-on service owning auth, the ownership index, the credential
  store, and resource introspection — §3.
- The **`/v1` API contract**, delivered as a checked-in OpenAPI 3.1 document — §4.
- **Identity**: GitHub OAuth login, and an Ed25519 **session token** that carries subject and session
  without carrying a secret — §5.
- The **credential model**: an open, destination-bound registry keyed by consumer tier, stored as
  per-user Kubernetes Secrets under envelope encryption — §6.
- **Data model**, cascade delete, and the `/resources` projection — §7.
- **Per-subject credential inflow** on the `/turn` path: the subject derived from the session token
  (never an inbound header), and that subject's credential installed as the model's per-turn `Bearer`
  header — §3.4, §3.5, §6.4.

### Out of scope (later slices, named honestly)

- **Sandbox pool tenancy.** Slice 1 ships with a **shared** pool: two users' leaves can be placed on
  the same pod. Isolation in slice 1 holds at the API, the session store, and the inference
  credential — **not** the sandbox. §8.2 states the partition design; §10 schedules it.
- **Leaf and CLI credential paths** stay ambient (`leaf-job.ts:15-18`, `harness/src/cli.ts:9-14`).
- **Delivery of `sandbox-egress` credentials.** Slice 1 stores them; nothing consumes them, because
  delivery means writing a secret into the untrusted tier — Z5's problem, not this spec's.
- **Quotas and cost attribution**, generic OIDC, owned `/v1/schedules` and `/v1/runs` — slice 2.
- **Injector-resolved credentials** (Z3/Z5), which retire this spec's interim trust assumption — slice 3.
- **Vault / External Secrets** as the credential backend — the stated future direction (§6.6), behind
  the `CredentialStore` interface from day one.

---

## 2. Current state — verified, with citations

Traced in the tree at `b533d87`, not inferred.

### 2.1 There is no principal anywhere

The data plane's routes (`packages/knative-server/src/server.ts:495-575`) are `GET /health`,
`POST /workloads`, `GET|DELETE /workloads/{name}`, `POST /runs` (+ `/runs/status`), and `POST /turn`.
None reads an `Authorization` header. Nothing in the request path names a user.

### 2.2 One ambient credential serves every caller

`buildConfig()` (`server.ts:66-73`) takes **no arguments** and reads `process.env.ANTHROPIC_AUTH_TOKEN`
(`:71`) and `ANTHROPIC_BASE_URL` (`:70`). It is called at `:111` (sync turn), `:174` (async dispatch),
and `:411`/`:415` (leaf). `leaf-job.ts:15-18` and `harness/src/cli.ts:9-14` do the same.

Inside the turn there are **three** environment reads on the credential path, not one:

| Location              | Code                                                                                         | Effect                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `run-turn.ts:306`     | `config?.anthropicAuthToken \|\| process.env.ANTHROPIC_AUTH_TOKEN`                           | an absent explicit value silently falls back to the deployment's                               |
| `run-turn.ts:310-312` | `if (authToken && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = authToken` | write-once-**if-absent**: session A's token sticks process-wide, so B..N authenticate **as A** |
| `run-turn.ts:313`     | `config?.anthropicBaseUrl \|\| process.env.ANTHROPIC_BASE_URL`                               | same fallback for the gateway base                                                             |

The middle row is the cross-tenant identity leak P5 §2.1 identified. All three must go for the `/turn`
path to fail closed; removing only the seed leaves the `||` fallbacks intact.

### 2.3 The session store has no owner, and its list is unusable for users

`LogStore` (`packages/session-backend/src/backend.ts`) exposes `list(): Promise<string[]>` — "all known
session ids", with no owner concept. `RedisSessionBackend.list()` implements it as
`client.keys('session:*')` filtered by suffix (`redis-backend.ts:80-84`). Keys are `session:<sid>` and
`session:<sid>:seq` (`:6-7`). So requirement "list my sessions" has neither the data nor a usable
access path today, and the control plane must never route a user-facing list through `keys()`.

### 2.4 There is no session → sandbox reverse index

Leases live in `sh:sandbox:<pod>:leases` — a ZSET whose **member is the run id, not the session id**,
score = expiry ms (`harness/src/sandbox-lease.ts:3-6`, `ACQUIRE_LUA` `ARGV[3]`). Presence records are a
hash at `sh:sandbox:records` (`pool-records.ts:17-20`). Answering "which sandbox is my session on"
therefore requires scanning every pod's ZSET — O(pods) per request, and racy. §7.4 resolves this.

### 2.5 Redis is entirely ephemeral

`deploy/knative/redis.yaml` is a single-replica `redis:7-alpine` Deployment: **no PVC, no volume, no
`appendonly`**, 128Mi memory limit. Everything in Redis dies with the pod. This decides the credential
store (§6.5).

### 2.6 A pool-selector seam already exists — and already declines the prompt path

`POST /runs` deletes any client-supplied `sandboxPoolSelector` (`server.ts:553`), commenting that "a
workload resolver may add one after this boundary." `resolveRunWorkload()` (`:300-324`) is that
resolver: it returns `{ ...body, sandboxPoolSelector: record.sandboxSelector }` from a
`WorkloadRecord.sandboxSelector` (`context-service.ts:13-26`).

**But for `kind: 'prompt'` it deliberately ignores the workload's selector and only warns** (`:308-320`,
an ADR-0028 amendment): _"Whether a workload's pool should bound its prompt leaves is a separate
decision … until it is taken, warn rather than change behavior here."_ A per-user session turn is
exactly that case, so §8.2's tenant partition inherits an already-deferred decision rather than
inventing one. §11.1 records it as owed; tracked as
[#237](https://github.com/rossoctl/serverless-harness/issues/237).

### 2.7 Pi does not need changing

P5 §2.2 traced this and it still holds: `AgentSession` resolves auth per request via
`_getRequiredRequestAuth` from a **per-instance** `ModelRegistry`, passes the resolved key explicitly
into stream options, and `withEnvApiKey` consults the environment **only when no explicit key was
given**. The environment is a fallback _beneath_ an already-per-session mechanism. Nothing in
`pi-fork` changes.

---

## 3. Architecture

### 3.1 Components

```mermaid
flowchart TB
    U[browser / CLI] -->|1. OAuth login, /v1 calls| CP
    CP[control-plane<br/>Deployment, always on<br/>auth · ownership · credentials · introspection]
    CP -->|2. session token Ed25519| U
    U -->|3. POST /turn + token, SSE direct| K[Knative Service<br/>scale-to-zero]
    K -->|4. exchange token for credential, mTLS| CP
    CP --> S[(K8s Secrets<br/>sh-credentials ns)]
    CP --> R[(Redis<br/>sh:cp:* index)]
    CP -->|read| A[K8s API<br/>pods]
    K --> R
    K --> SB[sandbox pool<br/>shared in slice 1]
```

The **control plane** is a plain `Deployment`, deliberately not Knative: it holds a JWKS/OAuth client,
mints tokens for cron-fired runs with no client present, and is the trusted tier. Scale-to-zero would
buy nothing and cost a cold start on every `GET /v1/sessions`.

The **data plane** stays the same deployable and image. It gains a session-token verifier and a
subject-carrying `buildConfig()`.

### 3.2 Trust tiers

Per [Z1](2026-06-26-identity-spine-design.md) §2:

| Tier    | Component         | Trust                           | Mints identity? | Holds secrets?        |
| ------- | ----------------- | ------------------------------- | --------------- | --------------------- |
| Control | **control plane** | trusted; not model-influenced   | yes (sole)      | **yes — see §3.3**    |
| Brain   | harness           | semi-trusted (untrusted _data_) | no              | transiently, per turn |
| Hands   | sandbox           | untrusted (model code)          | no              | no                    |

### 3.3 The accepted divergence from Z1

Z1 §2's table gives the orchestrator **"Holds secrets? no"**, specifically to keep the identity crown
jewel out of the credential blast radius. This design puts both in one component: the control plane
mints session identity **and** holds the credential store.

That is a real concentration of risk, accepted for one reason: the alternative — per-subject
resolution at the inference injector — lives in `kagenti-extensions`, outside this repo, and would
block every user-visible deliverable on another codebase. Two containments make the cost bounded:

- A `CredentialStore` interface (§6.6), so slice 3 moves resolution behind the Z3/Z5 injector without
  reshaping a handler or an endpoint.
- Credential Secrets in a **separate namespace** with **no `list` verb** granted to the serving path
  (§6.5), so "read the credential store" and "read any Secret in the app namespace" are not the same
  permission, and a compromised control plane cannot enumerate users.

Recorded in [ADR-0033](../adrs/0033-multi-user-control-plane.md). Retired by slice 3.

### 3.4 How the per-subject credential actually reaches the model

The first draft of this section said "pass the key as an explicit argument, and pi's per-session
`apiKey` does the rest." Reading P5's merged §3.3 and the code it cites shows that is **not the
mechanism available**, so it is corrected here.

`createAgentSession` (`run-turn.ts:499-504`) exposes **no seam** to pass a per-session key into the
session's `ModelRegistry`. Pi resolves the request key **by provider name** —
`authStorage.getApiKey('anthropic')` → `getEnvApiKey('anthropic')` → `process.env.ANTHROPIC_API_KEY`
(documented at `run-turn.ts:150-155`) — so with that variable absent, `_getRequiredRequestAuth`
throws `No API key found for "anthropic"` before any request is attempted.

What _is_ per-session is the **model object**, rebuilt every turn at `run-turn.ts:497` by
`applyModelGateway` (`:294`), which installs `Authorization: Bearer <token>` from
`config.anthropicAuthToken` and prefers `config` over the environment at `:306`. So the credential
path MU1 uses is:

```
control plane ──exchange──▶ TurnConfig.anthropicAuthToken
                              │
                              ▼  applyModelGateway (per turn)
                        model.headers.Authorization = Bearer <subject's token>
                        ANTHROPIC_API_KEY = P5's inert sentinel   ← satisfies pi's existence check
```

Two consequences follow, and they are the reason §3.5 changed:

- **MU1 does not need to touch `run-turn.ts` at all.** `:306` already prefers `config` over the
  environment. MU1's work is to make `config` carry the _right subject's_ token — which is
  `server.ts` and the control plane, not the gateway function.
- **Deleting the `:310-312` seed is not MU1's to do, and must not be done without P5's sentinel.**
  Delete it alone and `ANTHROPIC_API_KEY` goes absent, so gateway mode breaks outright (P5 §3.3).
  P5's step 3 replaces it with a fixed non-secret sentinel; MU1 consumes that, and duplicating it
  would be both redundant and a merge conflict.

### 3.5 Composition with P5 — and what MU1 does before it lands

P5's design is **merged** ([ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md), via
[#228](https://github.com/rossoctl/serverless-harness/pull/228)); its **implementation** is a separate
contributor's track on a different timeline. The two specs turn out to be complementary by
construction, because P5 §3.2 step 1 reserved `Authorization` for precisely this spec:

> `Authorization` is unused on inbound requests today … but its meaning there is "may this caller use
> the harness" — and ADR-0011's lock-down implies caller auth is coming. Overloading one header with
> _authorize the caller_ and _whose budget to spend upstream_ collides exactly when that lands.

So the header split is already decided, and MU1 adopts it unchanged:

| Header                                  | Means                             | Owner          |
| --------------------------------------- | --------------------------------- | -------------- |
| `Authorization: Bearer <session token>` | _may this caller use the harness_ | **MU1** (§5.2) |
| `X-SH-Subject`                          | _whose work this is_              | **P5**         |

**MU1's contribution is making the subject trustworthy rather than asserted.** P5 reads
`X-SH-Subject` from the inbound request, which is correct for a trusted orchestrator but is exactly
the spoofable-header pattern [Z1](2026-06-26-identity-spine-design.md) §3.2 warns about once
arbitrary users can call the API. Therefore:

> **When a session token is present, the subject is `token.sub`, and any inbound `X-SH-Subject` is
> ignored.** A request carrying both a session token and a conflicting `X-SH-Subject` is rejected
> with `subject_conflict` (400) rather than resolved by precedence — a silent winner here is a
> cross-tenant bug waiting to be written.

The operator-driven and leaf paths keep P5's inbound-header behaviour; they are not user-facing.

#### Ownership split

| Concern                                                                                        | Owner                                     |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `Authorization` caller auth; subject derived from the token; per-subject credential resolution | **MU1**                                   |
| `buildConfig(req)` signature and per-request subject inflow                                    | **P5** (MU1 extends it to read the token) |
| Removing the `:306`/`:313` fallbacks and the `:310-312` seed                                   | **P5**                                    |
| The startup sentinel + deleting `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`               | **P5**                                    |
| Reachability pins for the four inert globals                                                   | **P5**                                    |
| Leaf `ScaledJob` and CLI paths                                                                 | **P5**                                    |

#### If P5's implementation has not landed

MU1 still ships, with a weaker but honestly-stated property. Because `:306` already prefers `config`,
a subject's token reaches the model correctly today; what is missing without P5 is the _guarantee_
that nothing ambient can substitute for it. So MU1 enforces fail-closed **by policy at two points it
owns** — `POST /v1/sessions` refuses a subject with no resolvable credential, and the exchange refuses
to return one — while the process-level guarantee waits on P5's step 3.

The distinction matters and the spec will not blur it: with P5, a credential-less session **cannot**
run on a neighbour's identity; without P5, it _does not_, because two checks say so. §8.1 records
which of the two is in force, and §9.3 test 1 is written to assert the policy version today and
tighten to the process version once the sentinel exists.

---

## 4. API contract

Delivered as **`docs/api/openapi.yaml`** (OpenAPI 3.1), pinned by a contract-drift test (§9, test 3).

### 4.1 Two conventions

**The principal is never in a path.** `/v1/sessions` means _my_ sessions, derived from the token. Admin
listing is `?owner=<subject>`, gated on a role claim. Subject-in-path makes every future authz rule a
string comparison against a URL segment, and makes token and path two sources of truth for one fact.

**The data plane gains `/v1` aliases, not a hard break.** Reuse the alias machinery already at
`server.ts:482-494`, which is mid-migration on `/run-leaf → /runs`. Forcing a second simultaneous
version break on `/turn` would run two migrations at once against live orchestrators.

### 4.2 Control plane (`@sh/control-plane`)

| Route                             | Slice | Notes                                                                                                    |
| --------------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`                      | 1     | subject, display name, roles                                                                             |
| `POST /v1/sessions`               | 1     | creates the ownership record → `{sessionId, token, expiresAt}`; resolves the inference credential (§6.4) |
| `GET /v1/sessions`                | 1     | owner-filtered, paged from the owner zset; `?owner=` requires `role=admin`                               |
| `GET /v1/sessions/{id}`           | 1     | owner, timestamps, state, turn count                                                                     |
| `DELETE /v1/sessions/{id}`        | 1     | cascade — §7.3                                                                                           |
| `GET /v1/sessions/{id}/resources` | 1     | §7.4                                                                                                     |
| `POST /v1/sessions/{id}/token`    | 1     | re-mint; a session outlives a 5-minute token                                                             |
| `GET /v1/credentials`             | 1     | **metadata only — no value is ever returned**                                                            |
| `PUT /v1/credentials/{name}`      | 1     | write-only; no read-back path exists                                                                     |
| `DELETE /v1/credentials/{name}`   | 1     |                                                                                                          |
| `POST\|GET\|DELETE /v1/schedules` | 2     | owner recorded at creation (§5.5)                                                                        |
| `POST /v1/runs`                   | 2     | user-owned async dispatch                                                                                |
| `GET /healthz`, `/readyz`         | 1     |                                                                                                          |
| `POST /internal/credentials`      | 1     | mTLS, data plane only — §5.3                                                                             |

### 4.3 Data plane (existing Knative Service)

| Route                           | Change                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| `POST /v1/turn` (alias `/turn`) | requires a session token; subject and credential derived from it |
| `POST /v1/runs` (alias `/runs`) | unchanged — operator-authenticated, orchestrator-facing          |
| `POST\|GET\|DELETE /workloads`  | unchanged                                                        |
| `GET /health`                   | unchanged                                                        |

`POST /turn` enforces exactly one rule: **`token.sid === body.sessionId`**. It performs no ownership
lookup — it holds no ownership data and should not.

---

## 5. Identity and the session token

### 5.1 GitHub is not an OIDC provider

Worth stating because it changes the implementation: GitHub's **user-login** flow is plain OAuth 2.0.
There is no `id_token`, no discovery document, no JWKS. A code is exchanged for an **opaque** token and
identity comes from `GET https://api.github.com/user`. (GitHub issues OIDC tokens only to Actions
workloads, not to logging-in humans.)

Behind an `IdentityProvider` seam:

- **Slice 1 — `github-oauth`**: code exchange → `/user`. The subject is **`github:<numeric id>`**, never
  the login, which is mutable and reusable after account deletion.
- **Slice 2 — `oidc`**: discovery + JWKS, for Keycloak/Dex/Entra/OCP cluster OAuth.

Rejected for slice 1: running Dex with a GitHub connector and writing only the generic verifier.
Cleaner long-term, but it adds a second new deployable to the demo path to defer code needed anyway.

### 5.2 The session token

A JWT signed with **Ed25519**; the private key is a control-plane Secret, and the data plane receives
only the **public** key.

The asymmetry is load-bearing, not stylistic. The harness is the brain tier — semi-trusted, processing
untrusted model output. Under a shared HMAC secret a compromised harness could **mint** a token for any
subject; under Ed25519 it can only verify. The trust tier dictates the algorithm.

```
iss, aud="harness", sub="github:1234", sid=<sessionId>,
tenant, scope=["turn:write"], exp=+5min, jti
```

**No credential travels in the token.** It is a capability naming a subject and a session.

### 5.3 The credential exchange

At turn start the data plane exchanges the presented token for that subject's credential, over mTLS:

```
harness ──POST /internal/credentials { token } ──▶ control plane
        ◀── { anthropicAuthToken, anthropicBaseUrl }
```

If the credential rode inside the token, a client-visible bearer string would contain a provider key —
landing in browser storage, proxy logs, and shell history. This keeps it server-side and matches the
shape [Z1](2026-06-26-identity-spine-design.md) §4 defines for `CredentialInjector`.

The exchange also checks the session tombstone (§7.3), so a deleted session cannot start a new turn.

**This puts the control plane on the control path once per turn — never on the data path.** It sees no
prompt and no model output; the SSE stream stays direct from the Knative Service to the client.

### 5.4 Where authz is enforced

Every session-scoped control-plane handler goes through a single
`assertOwner(sessionId, principal)` that reads the ownership record and throws a typed `NotFound` on
mismatch. The failure mode designed against is authz scattered per-handler, where the fifth endpoint
someone adds forgets the check — hence one choke point plus an enumeration test (§9, test 2).

### 5.5 Offline execution

OIDC/OAuth authenticates **API calls**; the stored credential authorizes **egress**. The two are
decoupled, so a queued or cron-fired run needs no refresh token: the control plane mints a session
token for the owner recorded on the schedule and resolves that owner's stored credential.

Accepted cost: revoking the user at the identity provider does **not** stop their scheduled runs.
Stopping them requires deleting the schedule or the credential. §11 records storing an OIDC offline
grant as the alternative if IdP-driven revocation becomes a requirement.

---

## 6. Credential model and store

### 6.1 The organizing axis is the consumer tier

Not the service. Which trust tier consumes a credential determines whether it can be delivered safely
at all — so that, not the vendor, is what the model is keyed on.

| `consumer`       | Examples                                                               | Delivery                                    |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `inference`      | Anthropic, an OpenAI-compatible gateway, Bedrock                       | data plane, per-turn exchange — **slice 1** |
| `sandbox-egress` | GitHub, Jira, an internal REST API, a database, an MCP server's bearer | sandbox (untrusted tier) — Z5 forward proxy |
| `control-plane`  | webhook signing key                                                    | control plane only                          |

Organizing by service (`inference.anthropic`, `git.github`) was the first draft and was wrong: it
buries the property that governs delivery and makes every new service a schema change.

### 6.2 Descriptor

```jsonc
PUT /v1/credentials/github-work
{
  "kind": "bearer",                     // registry entry: bearer | basic | api-key | oauth2-token | sigv4 | …
  "consumer": "sandbox-egress",
  "destination": { "hosts": ["api.github.com", "github.com"] },
  "binding": { "header": "Authorization", "format": "Bearer {token}" },
  "secret": { "token": "…" }            // the only encrypted part
}
```

`name` is **user-chosen**, so `github-work` and `github-personal` coexist. `kind` is a **registry**
entry carrying validation and binding rules, not a closed union — adding SigV4 or an MCP server's
token is a registry addition, not a migration.

`kind`, `consumer`, `destination`, and `binding` are **not secret**: they live as Secret annotations
plus the Redis index, so `GET /v1/credentials` lists without decrypting anything.

### 6.3 Destination binding

A credential declares the hosts it may be sent to. Two reasons to record it in slice 1 even though
nothing enforces it yet:

1. It is the input slice 3's forward proxy needs — the proxy attaches a credential based on where the
   request is going, so the agent never chooses it and never sees it. Recording it now means slice 3
   does not have to ask every user to re-declare.
2. It bounds the confused-deputy case where a tool is talked into sending a token to another host.

### 6.4 Which credential a session uses

`POST /v1/sessions` accepts `{"credentials": {"inference": "my-anthropic"}}`. If omitted, it resolves
to the single credential with `consumer: inference`; with several, it returns
**`400 credential_ambiguous`** rather than picking silently. With none, **`400 credential_required`** at
creation — a missing key should fail at session creation, not three turns in.

**The operator fallback relocates rather than disappearing.** For deployments that want "user has no
key yet → use the deployment's", the control plane resolves the operator key **at exchange time**,
behind `ALLOW_OPERATOR_FALLBACK` (default `false`) — never as an environment fallback in the harness.

Same convenience, a different property: the decision is made by the trusted tier, is attributable to a
subject, and is logged. The harness still cannot run bare, so a control-plane bug fails closed instead
of quietly borrowing a neighbour's identity.

### 6.5 Storage: per-user Kubernetes Secrets

Redis is ephemeral (§2.5), so it cannot hold credentials: a pod restart would lose every user's key,
and re-entry after each bounce would make the system fragile in its most visible place.

```
namespace: sh-credentials

Secret/sh-cred-<sha256(subject)[:16]>
  annotations:  sh.io/kind.<name>, sh.io/consumer.<name>, sh.io/destination.<name>
  data:
    github-work:      <AES-256-GCM ciphertext>
    my-anthropic:     <AES-256-GCM ciphertext>
```

**Envelope encryption on top of the Secret.** A Secret is base64, not encryption, and namespace
`get secrets` reads it. These are users' third-party keys — the highest-value data in the system.
AES-256-GCM with a KEK from a _separate_ Secret mounted only into the control plane, so a namespace-wide
secret read yields ciphertext and the KEK is a distinct RBAC subject.

**AAD = `subject|name`.** Free, and it buys a real property: an attacker who can _write_ Secrets still
cannot relabel Alice's ciphertext into Bob's row and spend her key — decryption fails.

**No `list` verb on the serving path.** The Secret name is derived deterministically from the subject,
so every access is a `get` by exact name. The runtime Role grants
`get/create/update/patch/delete` and **omits `list`**, so a bug or an injection cannot enumerate users'
credential objects; reaching Bob's Secret requires already knowing Bob's subject. Cleanup of departed
users needs `list`, so that goes to a separate maintenance Role used by a Job.

The name is a hash, so object names disclose no logins. A dedicated namespace is what makes the RBAC
containment possible at all — Kubernetes RBAC filters by `resourceNames`, never by label.

### 6.6 `CredentialStore`, and Vault later

All access goes through a `CredentialStore` interface (`put` / `get` / `list` / `delete`).

Per-user Secrets are right at demo and team scale. They are a known anti-pattern at very large user
counts — each is an etcd object with watch and informer cost. The recorded future direction is an
**external manager (Vault, or External Secrets Operator)** behind this same interface. The rejected
middle option is one shared Secret keyed by user: Secrets cap at **1 MiB total**, and every write
becomes read-modify-write on one hot object, needing optimistic-concurrency retries to avoid lost
updates — strictly worse than either end.

---

## 7. Data model, deletion, and resources

### 7.1 Where each thing lives

| Data            | Store                                      | Reason                               |
| --------------- | ------------------------------------------ | ------------------------------------ |
| Session log     | Redis `session:<sid>`, `session:<sid>:seq` | existing, unchanged                  |
| Ownership index | Redis `sh:cp:*`                            | **same lifetime as what it indexes** |
| Credentials     | K8s Secrets (`sh-credentials`)             | must outlive Redis (§6.5)            |
| Audit           | Redis Stream `sh:cp:audit`                 | append-only, TTL'd                   |

The index belongs in Redis _because_ Redis is ephemeral: if Redis is wiped the sessions are gone, so
their ownership records are meaningless. Co-location means index and data can never disagree.
Credentials are the opposite — they outlive every session.

### 7.2 Keyspace

```
sh:cp:session:<sid>                  hash    owner, tenant, createdAt, state, poolSelector, tombstone
sh:cp:owner:<subjectHash>:sessions   zset    score = createdAt → sid      (ordered list + pagination)
sh:cp:session:<sid>:runtime          hash    self-reported by the harness — DISPLAY ONLY
sh:cp:audit                          stream  (subject, sid, credential name, decision) — never values
```

The owner zset is the **only** user-facing list path. `LogStore.list()` must never serve one: it is a
`keys('session:*')` scan (§2.3), O(keyspace) and unowned.

Audit lives in a keyspace separate from the model-influenced session log, per
[Z1](2026-06-26-identity-spine-design.md) §6.

### 7.3 Cascade delete, ordered to fail safe

**Tombstone → data → index.** Never the reverse: dropping the index first leaves data present but
invisible, which is worse than a visible orphan.

1. Set the tombstone on `sh:cp:session:<sid>`. The credential exchange (§5.3) checks it, so no new turn
   can start.
2. Delete the log stream and seq, leaf results, gate state, queue entries.
3. Remove from the owner zset, then delete the session hash.

A turn in flight returns **202** with the tombstone set; a sweeper reaps what that turn writes on its
way out (its sandbox lease is already released by its own `finally`). An idle session returns **204**.
Returning 202 is preferred over pretending a synchronous delete happened.

### 7.4 `/resources`, and the reverse-index fix

```jsonc
GET /v1/sessions/{id}/resources
{
  "session":  { "id", "state", "createdAt", "lastTurnAt", "turns" },
  "harness":  { "mode": "knative|leaf-job", "podName", "revision", "ready" },
  "sandbox":  { "podName", "phase", "tenant" },
  "lease":    { "key", "runId", "expiresAt", "ttlSeconds" },
  "queue":    { "position", "pending" }     // async only
}
```

Because no session → pod index exists (§2.4), the harness **self-reports**
`{ harnessPod, revision, sandboxPod, leaseKey, runId }` into `sh:cp:session:<sid>:runtime` when it
acquires its lease. Sandbox `phase` comes from the K8s API (`get`/`list` on pods).

**That runtime hash is written by the brain tier, so it is untrusted, display-only data and is never
consulted for authz.** Stated here because the tempting later shortcut is to read `owner` from whatever
the harness wrote. `owner` lives only in `sh:cp:session:<sid>`, written only by the control plane.

---

## 8. Isolation properties

### 8.1 What slice 1 guarantees

| Layer                  | Property                                                          | Mechanism                                                                                              |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| API                    | a user sees and deletes only their own sessions                   | `assertOwner`, owner zset, 404 on mismatch                                                             |
| Session drive          | a valid token cannot drive another session                        | `token.sid === body.sessionId`                                                                         |
| Token forgery          | the harness cannot mint a token                                   | Ed25519, harness holds the public key only                                                             |
| Inference credential   | a turn runs on its own subject's key or not at all                | per-subject inflow; **enforced by policy** pre-P5, **by construction** once P5's sentinel lands (§3.5) |
| Credential at rest     | a namespace secret read yields ciphertext; a relabel attack fails | envelope encryption, AAD = `subject\|name`                                                             |
| Credential enumeration | the serving path cannot list users                                | no `list` verb, separate namespace                                                                     |

**404, not 403, for another user's session.** A 403 is an existence oracle. Session ids are unguessable
UUIDs so the leak is small, but 404 is the standard answer and the one we would otherwise have to
change later. `403` is reserved for _authenticated but insufficiently privileged on a resource you may
know exists_ — e.g. a non-admin passing `?owner=`.

### 8.2 What slice 1 does not guarantee — the shared pool

Two users' leaves can be placed on the same pooled sandbox pod. Nothing in slice 1 changes that, and
the demo narration says so out loud.

The slice-2 design is a **tenant-labelled pool partition**: the control plane supplies a
`sandboxPoolSelector` per tenant through the seam at `server.ts:553`/`:300-324`, pods carry a tenant
label, and a lease can only ever match its own partition. This preserves the warm pool and the P2/P3
density work, at the cost of a minimum idle pod count per active tenant.

It is blocked on the deferred ADR-0028 decision recorded in §2.6: the resolver **ignores** a workload's
selector for `kind: 'prompt'` leaves, which is precisely the shape of a user session turn. That
decision has to be taken before the partition can be enforced (§11).

Rejected alternatives: **exclusive lease + scrub on release** (isolation reduces to the completeness of
a scrub list — the #216/#222 bug class, permanently); **per-session ephemeral sandbox** (strongest and
simplest to explain, but discards the warm-pool cold-start work).

---

## 9. Error handling and testing

### 9.1 Error taxonomy

Typed errors at the boundary, mapped once. Codes stay `snake_case` and bodies stay
`{ error, message?, sessionId? }`, matching `invalid_json` / `session_not_found` / `prompt_required`
already in `server.ts`.

| Condition                             | Code                             | Status                       |
| ------------------------------------- | -------------------------------- | ---------------------------- |
| Missing, invalid, or expired token    | `token_invalid`, `token_expired` | 401                          |
| Non-owner on a session route          | `session_not_found`              | 404                          |
| Non-admin passing `?owner=`           | `forbidden`                      | 403                          |
| Owner has no inference credential     | `credential_required`            | 400                          |
| Owner has several, none named         | `credential_ambiguous`           | 400                          |
| Control plane unreachable at exchange | `credential_unavailable`         | 503                          |
| `token.sid` ≠ body `sessionId`        | `session_mismatch`               | 400                          |
| Pool saturated                        | `saturated`                      | 503 + `Retry-After` (exists) |
| Delete accepted, turn in flight       | —                                | 202                          |

### 9.2 Fail-closed requirements

- **Control plane unreachable → the turn fails.** It does not fall back to the environment. This is the
  single most important behaviour in the design; §6 is scaffolding for it.
- **Token expiry is evaluated at turn start only**, so a long turn is not killed mid-stream when its
  5-minute token lapses.
- **An identity-provider outage does not break running work.** Session-token verification is local
  Ed25519 with no per-request IdP call: new logins fail, existing sessions continue.
- **Redis down** → session routes 503, while `/v1/credentials` stays up, because §7.1 put them in
  different stores.
- **K8s API down** → `/resources` returns its Redis-sourced fields with `sandbox.phase: "unknown"`
  rather than 500. For an introspection endpoint, partial data with explicit unknowns beats an error.

### 9.3 Tests

Reuse the injectable structural-`RedisLike` fake pattern from `leaf-result-store.ts` and
`config-store.ts`, so most of this needs no live Redis.

Three tests carry the design:

1. **The credential-isolation property, in two phases.** Today: with `ANTHROPIC_AUTH_TOKEN` **set in
   the environment**, `POST /v1/sessions` for a subject with no stored credential must fail
   `credential_required`, and the exchange must refuse to return one — so the ambient value is never
   what a session runs on. Once P5's sentinel lands, tighten the same test to assert the process
   version: `ANTHROPIC_API_KEY` equals the sentinel exactly and `ANTHROPIC_OAUTH_TOKEN` /
   `ANTHROPIC_AUTH_TOKEN` are absent, so no identity is _reachable_ rather than merely unused. Written
   in that order deliberately — the weaker assertion is true now and does not have to be deleted
   later, and P5's own §5 makes clear that asserting the sentinel alone would stay green while an
   OAuth token outranked it.
2. **Route-table enumeration.** Enumerate every session-scoped route and assert each rejects a
   non-owner, so a sixth endpoint added without `assertOwner` fails CI instead of shipping.
3. **Contract drift.** Assert the implemented route table matches `docs/api/openapi.yaml`. Without it,
   "API as a product" degrades into prose that lies.

Also: Ed25519 mint/verify (expiry, `aud`, `sid` binding, tampered signature, and that a
harness-side verifier cannot sign); envelope crypto (round-trip, **AAD mismatch must fail**, wrong KEK
must fail); cascade-delete ordering; cross-tenant negatives (A's token cannot drive B's `sid`; B's list
omits A's sessions).

Live smoke gated by env var per existing convention: `MULTIUSER_LIVE_SMOKE=1` →
`deploy/knative/demo-multiuser.sh`, in the style of `demo-promoted-workflow.sh`.

---

## 10. Slices

| Slice | Contents                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | `packages/control-plane`; `github-oauth`; Ed25519 session token + `/internal/credentials` exchange; `/v1/sessions` CRUD + `/resources`; `/v1/credentials` (all kinds stored, `inference` delivered); subject-from-token on `/turn` (§3.5); `docs/api/openapi.yaml`; `demo-multiuser.sh`; ADR-0033 |
| **2** | Tenant-labelled pool partition (needs §11.1); `sandbox-egress` delivery for git operations; quotas and cost attribution; generic `oidc` provider; owned `/v1/schedules` and `/v1/runs`. The leaf/CLI credential paths are **P5's**, not this slice's (§3.5)                                       |
| **3** | Z3/Z5 injector-resolved credentials; retire the §3.3 divergence; Vault or ESO behind `CredentialStore`                                                                                                                                                                                            |

The demo lands in slice 1: two GitHub logins, two sessions, each user's list containing only their own,
a 404 across tenants, a `/resources` projection, and — on the `/turn` path — a credential property that
holds with the deployment's own key present in the environment.

---

## 11. Open decisions owed

1. **Should a workload's pool bound its `kind: 'prompt'` leaves?** Deferred at
   `server.ts:308-320` under ADR-0028; §8.2's tenant partition cannot be enforced until it is taken.
   Not decided here because it predates this spec and affects the non-multi-user `/runs` path too.
   Tracked as [#237](https://github.com/rossoctl/serverless-harness/issues/237).
2. **Tenant granularity.** This spec treats one subject as one tenant. Teams and shared sessions would
   introduce a tenant that is not a user, changing the owner zset into a membership lookup. Deliberately
   not designed now (YAGNI), but the `tenant` field exists in the session hash and the token so the
   change is additive.
3. **IdP-driven revocation of scheduled runs** (§5.5) — needs a stored OIDC offline grant if it becomes
   a requirement.
4. **Per-user pool cost.** A tenant-labelled partition implies idle pods per active tenant; the
   provisioning ratio from P3 was measured for a shared pool and would need revisiting.

---

## 12. References

- [Z1 Identity Spine](2026-06-26-identity-spine-design.md) — trust tiers (§2), `CredentialInjector` (§4), log/binding split (§6)
- [Z2 Harness Lock-Down](2026-06-26-harness-lockdown-design.md) — secret-free container
- [Z3 Inference Injector](2026-06-26-inference-injector-design.md) — provider-key chokepoint
- [Z5 Generalized Credentialed Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — sandbox forward proxy
- [RC1 AuthBridge Egress Control Plane](2026-07-10-authbridge-egress-control-plane-poc-design.md) — placeholder swap
- [P5 Multi-Session Isolation](2026-09-06-p5-session-isolation-design.md) + [ADR-0032](../adrs/0032-per-request-subject-no-ambient-credential.md) — design **merged** via [#228](https://github.com/rossoctl/serverless-harness/pull/228), implementation pending on a separate track. §2.2/§2.7 reuse its tracing; §3.4 corrects this spec's credential mechanism from it; §3.5 sets the composition. Issue #220 was closed in favour of new issues matching that PR, so #228 — not #220 — is the reference.
- [ADR-0028](../adrs/0028-async-prompt-dispatch.md) — the prompt-leaf selector deferral in §2.6
- [ADR-0033](../adrs/0033-multi-user-control-plane.md) — this spec's decision record

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
