# ADR-0033: An always-on control plane owns multi-user identity and credentials

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-09-08
- **Deciders:** Serverless Harness team
- **Spec:** [`../specs/2026-09-08-multi-user-control-plane-design.md`](../specs/2026-09-08-multi-user-control-plane-design.md)

> ADR-0032 is reserved by the P5 session-isolation spec in
> [PR #228](https://github.com/rossoctl/serverless-harness/pull/228), open against `main`; this ADR
> takes 0033 to avoid a collision. P5's **implementation** is a separate contributor's track on a
> different timeline, so this decision is deliberately not sequenced behind it — see the linked spec
> §3.5 for the ownership boundary.

## Context

The harness is single-tenant by construction. `buildConfig()` reads one
`ANTHROPIC_AUTH_TOKEN` from the process environment for every caller
(`packages/knative-server/src/server.ts:66-73`), the session store has no owner concept
(`LogStore.list()` returns all session ids), no route reads an `Authorization` header, and all leaves
share one service-account identity. Supporting several users means deciding, at once, where the
authenticated subject comes from, where per-user credentials live, and which component is trusted to
hold them.

Three forces shape the answer:

- **The target design is not available.** [Z1](../specs/2026-06-26-identity-spine-design.md) puts a
  trusted orchestrator above the harness and keeps credentials out of it entirely, with per-subject
  resolution happening at the [Z3](../specs/2026-06-26-inference-injector-design.md)/[Z5](../specs/2026-06-19-m13-generalized-credentialed-egress-design.md)
  injector. That resolution lives in `kagenti-extensions`, outside this repo, so building on it blocks
  every user-visible deliverable on another codebase.
- **The harness is the wrong place for either.** It processes untrusted model output, so it must not be
  able to mint identity, and per Z2/ADR-0011 it should hold no secret. An ambient credential there is
  worse than untidy: the write-once-if-absent seed at `harness/src/run-turn.ts:310-311` makes session
  A's token stick process-wide, so B..N authenticate **as A**.
- **Something has to be demonstrable soon**, which rules out sequencing the full credential plane first.

## Decision

We will introduce **`@sh/control-plane`**, an always-on Deployment that owns the authenticated `/v1`
API, the session-ownership index, per-user credential storage, and resource introspection. It
authenticates users (GitHub OAuth in slice 1), mints an **Ed25519** session token carrying subject and
session id but **no secret**, and the data plane exchanges that token over mTLS for the subject's
credential at the start of each turn.

We accept, and contain, a **divergence from Z1 §2**: that table gives the orchestrator "Holds secrets?
no", and our control plane both mints identity and holds the credential store.

The containments are the reason the cost is bounded:

- A `CredentialStore` interface, so slice 3 moves resolution behind the Z3/Z5 injector without
  reshaping a handler or an endpoint, and so Vault or External Secrets can replace Kubernetes Secrets
  later.
- Credential Secrets in a dedicated `sh-credentials` namespace, with **no `list` verb** granted to the
  serving path — names are derived from the subject, so every access is a `get` by exact name and the
  serving path cannot enumerate users.
- Envelope encryption (AES-256-GCM, KEK in a separate Secret) with **AAD = `subject|name`**, so a
  namespace-wide secret read yields ciphertext and an attacker who can write Secrets cannot relabel one
  user's ciphertext into another's row.

### Alternatives considered

- **Retrofit auth onto the Knative Service** — one deployable and fastest to demo, but the process
  verifying tokens and holding credentials would be the same one running model output, contradicting
  Z2/ADR-0011, and every `GET /v1/sessions` would pay a scale-to-zero cold start.
- **Gateway-only auth (oauth2-proxy / Istio injecting a subject header)** — least new code, but the
  harness would then trust an asserted header, which Z1 §3.2 identifies as precisely the spoofable
  signal that per-session identity exists to replace.
- **Wait for Z3/Z5 per-subject resolution** — the correct end state, and still the slice-3 target, but
  it blocks all user-visible work on `kagenti-extensions`.
- **Per-user credentials in Redis** — rejected on inspection: `deploy/knative/redis.yaml` has no PVC and
  no `appendonly`, so every user's key would be lost on a pod restart.

## Consequences

- Positive: a request's upstream identity is determined solely by that request, and on the `/turn` path
  no identity is reachable from process-global state — a credential-less session fails closed instead of
  borrowing its neighbour's. The property is pinned by a test that sets `ANTHROPIC_AUTH_TOKEN` in the
  environment and asserts the turn still fails `credential_required`.
- Positive: the harness cannot forge identity. Ed25519 with a public-key-only verifier makes that
  structural rather than procedural.
- Positive: the control plane stays off the data path — one small exchange per turn, and it never sees a
  prompt or a model response.
- Negative / accepted cost: the identity minter and the credential store are one component, against
  Z1's explicit separation. Compromising the control plane compromises both.
- Negative / accepted cost: the harness transiently holds a raw provider key in memory, which Z3 exists
  to eliminate.
- Negative / accepted cost: the operator-key fallback does not disappear, it relocates — behind
  `ALLOW_OPERATOR_FALLBACK` (default `false`), resolved by the trusted tier where it is attributable and
  logged rather than ambient in the harness.
- Negative / accepted cost: revoking a user at the identity provider does not stop their scheduled runs,
  because the stored credential — not an OIDC grant — is what authorizes background egress.
- Follow-up owed: slice 1 ships a **shared** sandbox pool, so two users' leaves can land on the same
  pod; isolation holds at the API, session store, and inference credential only, and the demo says so.
  The tenant-labelled partition is blocked on the ADR-0028 deferral at `server.ts:308-320`, where a
  workload's pool selector is deliberately ignored for `kind: 'prompt'` leaves.
- Follow-up owed: deliver `sandbox-egress` credentials via Z5 rather than storing them unconsumed, and
  retire this divergence in slice 3. Extending the no-ambient-credential property from `/turn` to the
  leaf `ScaledJob` and CLI paths is **P5's** track, not this one's — the linked spec §3.5 records the
  ownership split, because both touch `run-turn.ts:306-313` and whichever lands second rebases.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
