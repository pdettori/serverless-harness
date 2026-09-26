# `sh-tui` — A Terminal Client for the MU1 Control Plane — Design

Version: 1.0 — September 25, 2026
Status: Proposed
Scope: A new, standalone terminal UI — `packages/tui` (`@sh/tui`), binary `sh-tui` — that logs a user
in against the MU1 control plane, lets them manage their own sessions and inference credentials, and
drives interactive turns against the harness over SSE. It talks **exclusively** over the `/v1` HTTP
contract already shipped in `packages/control-plane` and `packages/knative-server`. **No backend
changes are made or required by this spec.** UX is modeled on OpenCode's TUI conventions: one
persistent chat view, secondary functions as dismissable overlays, a leader-key + slash-command +
fuzzy-palette input model, and a themeable color-token layer.
Milestone: unassigned. This is a client-side product surface, not a work track of its own — see §11
for why no track prefix is claimed here.
Builds on (reuse, no redesign): [MU1](2026-09-08-multi-user-control-plane-design.md)'s `/v1` API
surface (auth, sessions, credentials) and its [OpenAPI contract](../api/openapi.yaml); the SSE
turn-stream design ([turn-sse-streaming](2026-08-26-turn-sse-streaming-design.md)); the
substrate-agnosticism established by [P6](2026-09-08-p6-vm-process-manager-design.md) — the harness's
request `handler` is exported once and reused, byte-identical, whether fronted by Knative or by the
VM/supervisor path; [RA1](2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md) for naming
context only (its rename is a separate, not-yet-executed plan; nothing here depends on it).
Tracking: assign an issue at execution time.

> **The one-sentence thesis.** Everything this TUI needs already exists over HTTP — login, owned
> sessions, credential management, streaming turns — so the whole of this design is a terminal
> client and nothing else: zero backend changes, zero runtime dependency on any `@sh/*` package, and
> zero assumption about what is actually running behind either URL it is given.

---

## 1. Goal & scope

### Goal

Give a user a fast, OpenCode-quality terminal experience for the harness: log in once, create or
resume sessions, watch turns stream live, and manage the named inference credentials a session runs
on — without ever touching `kubectl`, a YAML manifest, or a `curl` command by hand.

### In scope

- GitHub OAuth **device-flow login** against the control plane, with local caching of the resulting
  API token (§4).
- **Session lifecycle**: list, create, resume, delete — `GET/POST/DELETE /v1/sessions*` (§6.2, §6.3).
- **Interactive turns**: `POST /v1/turn` (alias `/turn`) in SSE mode, rendered live (§6.1).
- **Credential management**: list/add/delete named inference credentials — `GET/PUT/DELETE
/v1/credentials*` (§6.4).
- **Session profiles**: a small, additive, client-only seam so a saved preset can grow to cover more
  of session creation as the backend grows more knobs to set (§7).
- OpenCode-inspired interaction model: one persistent view, overlays, leader key, slash commands, a
  fuzzy palette, and a theme-token layer (§5).

### Out of scope (deliberately, not by oversight — see §9 for the reasoning)

- **Any backend change.** Not to `packages/control-plane`, not to `packages/knative-server`, not to
  `harness/`. If a future need requires a new field on `/v1/sessions` or `/turn`, that is a separate
  spec; this one only documents the seam that will receive it (§7).
- **Per-session model selection.** `SH_MODEL`/`SH_MODEL_API` are deployment-time env vars on the
  harness process, not a session-time parameter, and this spec does not add one.
  ([multi-protocol-model-provider](2026-08-20-multi-protocol-model-provider-design.md))
- **Per-session sandbox pool / resource / tool-set selection.** MU1 §8.2 states plainly that `/turn`
  "does not lease from the pool at all" — it always resolves a single fixed pod, regardless of any
  `workloadId`/selector mechanism that exists for the async `/runs` path. CPU/memory limits and which
  tools are installed are Kubernetes pod-spec / container-image concerns today, with no HTTP surface
  at all. None of this is buildable from the client side; §9 and §11 record it as owed backend work,
  not a TUI gap.
- **Unauthenticated / ambient-credential mode.** This client always requires control-plane auth. The
  existing `harness/src/cli.ts` and the 14 unauthenticated deploy scripts are untouched and remain the
  no-auth path for local/ops use.
- **A pluggable, user-authored theme-file system** (OpenCode's `/theme` + JSON theme files). One
  centralized set of color tokens, one or two shipped themes — the seam, not the ecosystem.
- Anything OpenCode does that assumes a **local** working tree: `@`-file fuzzy search, `!`-shell
  passthrough, git-backed undo/redo. This client has no local project context — its "sandbox" is a
  remote resource reached only through the harness's own tool-calling loop, which the transcript
  already renders (`tool_use`/`tool_result` frames).

---

## 2. Current state — what already exists and where this client anchors to it

### 2.1 The control plane (`packages/control-plane`) is implemented and merged

Not a design-only spec: `GET/POST /v1/auth/device*`, `GET /v1/me`, `POST/GET /v1/sessions`,
`GET/DELETE /v1/sessions/{id}`, `GET /v1/sessions/{id}/resources`, `POST /v1/sessions/{id}/token`,
`GET /v1/credentials`, `PUT/DELETE /v1/credentials/{name}` are all live, pinned by
`docs/api/openapi.yaml` and a contract-drift test
(`packages/control-plane/test/openapi-contract.test.ts`). This client is written against that
document; §12 lists it as the primary reference.

### 2.2 Two services, two token kinds — not one

The control plane and the harness are **separate deployables**, and by MU1's own design the SSE turn
stream never passes through the control plane — "the SSE stream stays direct from the Knative Service
to the client" (MU1 §5.3.1). Concretely:

| | Control plane | Harness (data plane) |
| --- | --- | --- |
| Routes | `/v1/auth/*`, `/v1/me`, `/v1/sessions*`, `/v1/credentials*` | `POST /v1/turn` (alias `/turn`) |
| Token | **API token** — `scope:["api"]`, 1 hour (`apiTokenTtlSeconds`), no refresh mechanism | **Session token** — `scope:["turn:write"]`+`sid`, 5 minutes (`sessionTokenTtlSeconds`) |
| Minted by | `POST /v1/auth/device/token` (device-flow completion) | `POST /v1/sessions` (on create) or `POST /v1/sessions/{id}/token` (remint) |

A client that only ever holds one of these will find the other's calls fail with `token_required` /
`token_invalid` — this is not an edge case to special-case later, it is the baseline shape every
session-creating and every turn-sending code path has to carry.

### 2.3 Turn streaming already exists, with a fixed frame vocabulary

`harness/src/turn-stream.ts`'s `TurnStreamFrame` union — `text` / `thinking` / `tool_use` /
`tool_result` / `done` / `error` — is what `POST /turn` emits when the caller sends
`Accept: text/event-stream`. Tool-result previews are already truncated server-side
(`SH_TURN_STREAM_TOOL_RESULT_PREVIEW_BYTES`, default 2048), and a heartbeat comment
(`SH_TURN_STREAM_KEEPALIVE_MS`, default 20000) keeps idle connections alive. This client renders that
vocabulary; it defines none of its own.

### 2.4 The credential kind registry is real but not queryable

`packages/control-plane/src/credential-store.ts` hardcodes four kinds — `bearer` (secret field
`token`), `basic` (`username`+`password`), `api-key` (`key`), `oauth2-token` (`accessToken`) — as an
**extensible, in-process registry**, not a closed union, and there is no `GET` endpoint that lists it.
A `PUT` with the wrong secret fields for a kind fails `400` with a message that names exactly which
fields are required. This client hardcodes the four documented kinds for a good default form, and
falls back to a generic key/value editor plus surfacing that 400 message verbatim for anything else —
see §6.4.

### 2.5 The deployment substrate underneath either URL is, correctly, none of this client's business

Verified rather than assumed, because it is the load-bearing property of "decoupled, HTTP-only":
`packages/knative-server/src/server.ts` exports its request `handler` as one word, and P6's
`packages/supervisor` reuses that exact function as its worker's entry point — the P6 spec states
outright, "Knative request handling is byte-identical." `packages/supervisor` itself contains **no**
HTTP or auth logic; it is a raw-socket router that hands connections to worker processes running that
same `handler`. So `/turn`'s auth path does not fork between Knative and the VM/P6 substrate — there is
only one implementation.

**One real, currently-true gap, worth stating precisely rather than glossing over**:
`deploy/vm/env/supervisor.env.example` — the actual shipped env template for the P6 VM deployment —
sets none of `SH_REQUIRE_AUTH`, `SH_CONTROL_PLANE_URL`, `SH_EXCHANGE_TOKEN`, or
`SH_SESSION_TOKEN_PUBLIC_KEYS`. This matches the P6 spec's own scope note ("the MU1 control plane on
the VM" is explicitly not exercised by its E8/E9 experiments). Since this client always requires
control-plane auth (§1), pointing it at a P6/VM-deployed harness today will fail authentication until
an operator adds those four variables to that deployment. That is a deployment-configuration
prerequisite, not a defect in this design — recorded as an assumption in §10, not silently worked
around.

---

## 3. Architecture

### 3.1 Package

```
packages/tui/                    @sh/tui, binary `sh-tui`
  src/
    cli.ts                       entrypoint
    config.ts                   local config/token cache (XDG path resolution)
    profiles.ts                  SessionProfile type + local store (§7)
    api/
      control-plane.ts           typed fetch wrapper for /v1/auth, /v1/me, /v1/sessions, /v1/credentials
      harness.ts                 typed fetch wrapper for POST /turn (sync + SSE)
      sse-parser.ts              text/event-stream -> TurnStreamFrame, chunk-boundary safe
      errors.ts                  CpError-shaped error type + the taxonomy table in §8
    theme.ts                     color-token type + the shipped theme(s) (§5.4)
    views/
      Login.tsx                  device-flow overlay
      SessionsOverlay.tsx        list/switch/delete
      CredentialsOverlay.tsx     list/add/delete
      Chat.tsx                   the persistent home view (§5, §6.1)
      Palette.tsx                fuzzy command palette (ctrl+p)
    app.tsx                      overlay stack + keybinding/slash-command dispatch
  test/                          mirrors src/, vitest
  package.json                   deps: ink, react; devDeps match the repo's existing minimal-deps style
```

**Hard constraint, stated so it can be checked rather than assumed**: `packages/tui/package.json`
declares **no** `workspace:*` dependency on any other package in this repo. It imports nothing from
`@sh/harness`, `@sh/control-plane`, `@sh/session-backend`, or `@sh/k8s-sandbox`. Every fact it needs
about a session or a turn comes from an HTTP response, never from a shared module. This is what makes
§2.5's substrate-agnosticism actually hold for this client and not just for the wire contract in the
abstract.

### 3.2 Configuration

Two endpoints, generically named (no "Knative" or "K8s" anywhere in a flag or env var name, on
purpose, per §2.5):

| Flag | Env | Meaning |
| --- | --- | --- |
| `--control-plane-url` | `SH_CONTROL_PLANE_URL` | auth, sessions, credentials |
| `--harness-url` | `SH_HARNESS_URL` | `POST /turn` |

Both are cached in local config (§8... rather §6.5) after first use, so day-to-day invocation is just
`sh-tui`.

---

## 4. Auth flow

1. **No cached API token, or the last `/v1/*` call returned `token_required`/`token_invalid`/
   `token_expired`**: open the Login overlay. `POST /v1/auth/device` returns a user code and a
   verification URL — both rendered large and copy-friendly, since this is the one screen where
   copy-paste accuracy matters. Poll `POST /v1/auth/device/token` at the server-given `interval`,
   treating `428 authorization_pending` as "keep polling," anything else as terminal.
2. On success, cache `{ apiToken, subject, displayName, roles, expiresAt }` (§6.5) and return to
   wherever the user was (or the Chat home view, on a cold start).
3. **Resuming** a session mints a session token via `POST /v1/sessions/{id}/token` (using the API
   token). **Creating** one gets a session token directly from `POST /v1/sessions`'s response — no
   extra call.
4. Before every turn send, check the cached session token's `expiresAt` against a small safety margin
   and remint first if it is close. Five minutes comfortably covers "think, type, send" for the common
   case, so this is invisible in normal use.
5. Pointing the client at a **different** `controlPlaneUrl` clears the cached API token and forces a
   fresh login — never send one control plane's token to another.

---

## 5. UX — modeled on OpenCode's TUI

Read directly from `opencode.ai/docs/tui/` and `opencode.ai/docs/themes/`, not inferred from the
marketing page. Three conventions carry over; three are deliberately not mirrored (§1).

### 5.1 One persistent view, overlays for everything else

There is no "session list screen" you navigate away from Chat to reach. **Chat is the home view**,
always present once authenticated (transcript + input box). Sessions, Credentials, and Login are
**overlays** that render on top of Chat and dismiss back into it — matching OpenCode's `/sessions`,
`/models`, `/themes` behavior, which are popups over one chat surface, not separate full-screen routes.

### 5.2 Three paths to the same action

Every command below is reachable three ways, exactly as in OpenCode:

- Typed as `/command` directly into the always-present input box.
- A leader-key shortcut: `ctrl+x` then a mnemonic letter.
- The fuzzy command palette, `ctrl+p`, which searches all of them by name.

| Command | Keybind | Action |
| --- | --- | --- |
| `/sessions` (`/resume`) | `ctrl+x l` | open the Sessions overlay |
| `/new` | `ctrl+x n` | start a new session (§6.3) |
| `/credentials` | `ctrl+x k` | open the Credentials overlay |
| `/details` | — | toggle collapsed vs. full `tool_use`/`tool_result` rendering |
| `/thinking` | — | toggle whether `thinking` frames render at all |
| `/quit` | `ctrl+x q` | exit |

`/login` is not user-invoked — it opens automatically whenever a call comes back
`token_required`/`token_invalid`/`token_expired` (§4).

### 5.3 The two toggles map directly onto the frame vocabulary

`/details` and `/thinking` are not new ideas invented for this client — they are exactly the two
rendering decisions §2.3's frame vocabulary already needs (collapsed-by-default `thinking` blocks,
and how verbose `tool_use`/`tool_result` rendering should be), now exposed as real user-facing toggles
instead of a fixed default, which is what OpenCode does with the same two frame kinds.

### 5.4 Theming — the seam, not the ecosystem

OpenCode themes are JSON files defining color tokens (`primary`/`secondary`/`accent`/status colors/
diff colors/syntax colors), each optionally split into `dark`/`light` variants, swapped live via
`/theme`. Building that whole pluggable, user-authored system is more than v1 needs. What v1 does:
centralize every color used anywhere in `views/` through one `ThemeTokens` type (`theme.ts`) — primary,
accent, text, border, and the four status colors (`error`/`warning`/`success`/`info`) — and ship
exactly one default theme, maybe a second. No component reaches for a literal ANSI color. This is the
cheap insurance: adding a second shipped theme, or a `/theme` command, later is a new object literal
and a switch, not a refactor of every view.

### 5.5 Status line

A persistent footer: `subject · session id (or "no session") · connection state`. Mirrors OpenCode's
own lower-right mode indicator (its Plan-mode toggle) in spirit — one glanceable line, not a dashboard.

---

## 6. Views and flows

### 6.1 Chat (home view)

Transcript + input box. Incoming `TurnStreamFrame`s map to rendering as follows:

- `text` — appended live, character-by-character, to the current assistant bubble.
- `thinking` — rendered dim/italic above the answer, respecting the `/thinking` toggle (§5.3).
- `tool_use` — a compact colored line, `→ name({args preview})`; expanded or truncated per `/details`.
- `tool_result` — immediately after, colored by `isError`; the `preview` text is already
  server-truncated (§2.3), rendered verbatim.
- `done` — finalizes the bubble, updates the status line with `stopReason`/usage, re-enables input.
- `error` — an inline banner. Two cases the server already distinguishes render distinctly: a
  pre-first-frame error (e.g. an unknown session — real `404`, nothing streamed yet) versus a
  mid-stream terminal `error` frame (tokens already flowed).

**Sending**: Enter → remint the session token if near expiry (§4.4) → `POST /turn`,
`Accept: text/event-stream`, session token as `Bearer`. Node's `fetch` gives a body stream, not an
`EventSource`, so `api/sse-parser.ts` is a small hand-rolled parser: split on blank lines, parse
`event:`/`data:` pairs, ignore `: keepalive` comments, and — this is the part worth stating rather than
discovering in testing — buffer across chunk boundaries, since a frame is not guaranteed to arrive in
one `fetch` read.

**Canceling**: `Esc` aborts the in-flight turn client-side (`AbortController`); the server already
treats a dropped connection as "abort the turn" (`res.on('close')` → `session.abort()`), so this
requires no server-side cooperation beyond what already exists.

*Implementation note, not a design fork*: batch React state updates from rapid `text` deltas on a
short timer (~30–50 ms) rather than one re-render per token, or the transcript visibly stutters under
Ink.

### 6.2 Sessions overlay

`GET /v1/sessions` (paged, newest first) — id, `createdAt`, `lastTurnAt`, `turns`, `state`. `Enter`
resumes (§4.3); `d` deletes with a confirmation (`DELETE /v1/sessions/{id}` — `202` if a turn was in
flight, `204` if idle; both dismiss the overlay back to Chat).

### 6.3 New session

Before calling `POST /v1/sessions`: list current `consumer: inference` credentials.

- **Zero** → route into the Credentials overlay with a contextual message ("add an inference
  credential first").
- **One** → auto-selected silently.
- **More than one** → a picker, pre-empting the server's own `credential_ambiguous` rather than
  round-tripping into it.

If a saved Session Profile (§7) already answers this, skip straight to creation.

### 6.4 Credentials overlay

`GET /v1/credentials` (metadata only — no value is ever returned, by the API's own design). Add form:
name (validated against the server's own pattern), kind (free text, suggesting the four documented
kinds — default `bearer`), consumer (default `inference`), destination hosts, endpoint (shown when
consumer is `inference`), then secret fields — hardcoded labels for the four known kinds, a generic
key/value editor otherwise, and the server's own `400` message surfaced verbatim if the fields still
don't match what the registry expects (§2.4). Delete asks for confirmation, then issues `DELETE` —
always `204` regardless of whether the name existed, matching the API's explicit "no existence oracle"
design.

### 6.5 Local state

`$XDG_CONFIG_HOME/sh-tui/` (falling back to `~/.config/sh-tui/`):

- `config.json` — `{ controlPlaneUrl, harnessUrl }`.
- `auth.json`, mode `0600` — `{ apiToken, subject, displayName, roles, expiresAt }`. The only
  secret-shaped thing stored locally, and it is a short-lived (1h) capability token, never a provider
  credential — the server never returns those to anyone (§2.4), this client included.
- `profiles.json` — named `SessionProfile`s (§7).

---

## 7. The extension seam: Session Profiles

A profile is a plain, additive, client-only value object:

```ts
interface SessionProfile {
  name: string;
  inferenceCredential: string;
  // Future, additive fields land here as the backend grows the corresponding parameter —
  // e.g. a model override once /v1/sessions or /turn accepts one, or a sandbox selector once
  // MU2 gives /turn one (§1, §9). Each is optional until the backend supports it, and the New
  // Session flow (§6.3) only asks about whichever fields a chosen profile leaves unanswered.
}
```

Today this saves re-picking an inference credential once you have more than one. Its purpose is
structural, not just convenience: when `/v1/sessions` or `/turn` gains a new session-time parameter,
that parameter becomes one new optional field here and one new argument threaded through the single
HTTP call site that builds the request in `api/control-plane.ts` / `api/harness.ts` — no change to
navigation, no new view, no restructuring of `app.tsx`'s overlay stack.

---

## 8. Error handling

A single map from the API's own error taxonomy (the `Error` schema's `error` enum in
`docs/api/openapi.yaml`) to UI action, rather than ad hoc handling per call site:

| Code(s) | UI action |
| --- | --- |
| `token_required` / `token_invalid` / `token_expired` | open Login (§4); return to the prior view after |
| `session_not_found` (404) | dismiss to Chat/home with a toast — not yours, or gone |
| `credential_required` / `credential_ambiguous` | handled proactively in §6.3, not surfaced as a raw error |
| `authorization_pending` (428) | not an error — expected while polling device-flow login |
| `redis_unavailable` / `credential_unavailable` / `internal_error` | generic "service unavailable, retry" banner — server-side, not a user mistake |
| pool saturation (`503` + `Retry-After` on `/turn`) | "no capacity, retrying…", auto-retry on the advertised delay — the server designed this to be retried, not treated as fatal |
| network/DNS failure | a connection banner; an unreachable **harness** blocks only Chat, an unreachable **control plane** blocks everything else |

---

## 9. Scope / YAGNI — explicitly not built here, and why

- **No UI for sandbox tools/mem/cpu.** There is nothing to submit it to (§1, §2.5's gap trace) — a
  control that does nothing would either silently no-op or need a permanent disclaimer, both worse
  than absence.
- **No per-session model picker.** Same reasoning; `SH_MODEL*` is deployment-time only (§1).
- **No pluggable theme-file loader.** §5.4 — the token seam is built, the file format and `/theme`
  command are not.
- **No dual auth mode.** This client always requires the control plane; ambient/no-auth stays the
  existing CLI's and the deploy scripts' territory (§1).
- **No `@`-file search, `!`-shell passthrough, or git-backed undo/redo.** These assume a local working
  tree this client does not have (§1).

None of these are missing by oversight; each has a concrete blocker cited above. §11 records the two
that are real backend gaps worth someone picking up separately.

---

## 10. Assumptions & external dependencies

1. **The control plane and the harness are both reachable over HTTP from wherever this client runs.**
   No assumption about what fronts either — Knative Service, P6 VM/supervisor, or anything else (§2.5).
2. **A P6/VM-deployed harness needs its auth env vars added before this client can authenticate
   against it.** Verified against the actual shipped example
   (`deploy/vm/env/supervisor.env.example`, §2.5) — not present today. This is an operator task on
   that deployment, not something this client can detect or work around; §2.5 names the four
   variables.
3. **The credential-kind registry's four documented kinds are stable enough to hardcode a friendly
   form for.** If the registry grows a fifth well-known kind, this client's fallback (a generic
   key/value editor plus the server's own validation message) still works — just less pleasantly than
   a dedicated form (§2.4, §6.4).

---

## 11. Open decisions / future work

- **Milestone/track assignment.** This spec deliberately claims no `M`/`Z`/`MU`/`P`/`RC`/`RA` prefix —
  it is a client, not a change to any of those tracks' subject matter. Whoever accepts this spec should
  decide whether it gets its own short prefix (a `UI` track, say) or is filed as a plain, untracked
  addition; not resolved here.
- **Per-session model selection and per-session sandbox pool selection** (§1, §2, §9) are real,
  named backend gaps — the second one explicitly tracked already in MU1 §8.2 as owed to MU2. Both are
  prerequisites for this client's "configure model"/"configure sandbox" language to mean anything
  beyond credential management. Worth their own spec(s) if picked up.
- **Desktop notifications on turn completion when the terminal is unfocused** — OpenCode has this
  (§5, not otherwise adopted here). A reasonable v2 addition; skipped for v1 as it needs an OS-level
  notification dependency this design otherwise avoids.
- **`GET /v1/sessions/{id}/resources`** (where a session is actually running) is not surfaced in any
  view in this spec. Still fully HTTP, still decoupled — a plausible small addition to the Sessions
  overlay later, deferred as YAGNI for v1.

---

## 12. References

- [MU1 — Multi-User Control Plane](2026-09-08-multi-user-control-plane-design.md) — the API this
  client is entirely written against; §5 (identity/tokens), §6 (credentials), §7 (data model), §8.1–8.2
  (isolation properties and the named `/turn` pool-selection gap).
- [`docs/api/openapi.yaml`](../api/openapi.yaml) — the pinned contract; this client's `api/` modules
  should be kept in sync with it the same way the control plane's own contract-drift test does.
- [Streaming `/turn` Responses (SSE)](2026-08-26-turn-sse-streaming-design.md) — the frame vocabulary
  §2.3 and §6.1 render.
- [P6 — VM Process Manager](2026-09-08-p6-vm-process-manager-design.md) — §3.3's `handler` export/reuse
  is what makes §2.5's substrate-agnosticism a verified fact rather than an assumption.
- [RA1 — Density Cutover & Repo Re-architecture](2026-09-24-ra1-density-cutover-and-repo-rearchitecture-design.md) —
  naming/context only; not a dependency of anything built here.
- [Multi-Protocol Model Provider](2026-08-20-multi-protocol-model-provider-design.md) — why model
  selection is deployment-time, not session-time, today (§1, §9).
- OpenCode TUI docs (`opencode.ai/docs/tui/`, `opencode.ai/docs/themes/`) — the UX conventions §5
  adopts and, explicitly, the three it does not (§1).

---

## 13. Spec self-review notes

- **Placeholders:** none remain.
- **Internal consistency:** §1's out-of-scope list, §9's YAGNI list, and §11's open-decisions list
  agree on exactly two real backend gaps (per-session model, per-session sandbox selection) and do not
  contradict each other about what this spec does or doesn't fix.
- **Scope:** single, bounded deliverable — one new package, no backend changes. Not decomposed further
  because nothing here spans independent subsystems.
- **Ambiguity:** §11 flags the one open call (milestone/track assignment) that is a project-management
  decision, not a technical one, rather than silently picking a prefix.

---

_Assisted-By: Claude Sonnet 5 <noreply@anthropic.com>_
